#!/usr/bin/env python3
'''Flask-backed generator that reuses SerpApi + OpenAI to populate ld/data/leads.json.'''
import argparse
import json
import os
import threading
import textwrap
import time
import uuid
from pathlib import Path
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import certifi
import datetime
import requests

from flask import Flask, jsonify, request
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.collection import Collection
from pymongo.errors import PyMongoError
from serpapi import Client
from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent
LEADS_PATH = BASE_DIR / 'ld' / 'data' / 'leads.json'
CITY_CONTEXT = 'Wausau, Wisconsin, United States'
EMAIL_RX = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DB = os.environ.get('MONGODB_DB', 'evergreen')
MONGODB_COLLECTION = os.environ.get('MONGODB_COLLECTION', 'leads')
SERPAPI_API_KEY = os.environ.get('SERPAPI_API_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
BREVO_API_KEY = os.environ.get('BREVO_API_KEY')
BREVO_SENDER_EMAIL = os.environ.get('BREVO_SENDER_EMAIL', 'hello@evergreenmedialabs.com')
BREVO_SENDER_NAME = os.environ.get('BREVO_SENDER_NAME', 'Evergreen Media Labs')
BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email'
SEND_SLEEP_SECONDS = 90
SERPAPI_CLIENT = Client(api_key=SERPAPI_API_KEY) if SERPAPI_API_KEY else None
OPENAI_CLIENT = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

app = Flask(__name__)
client_kwargs = {'tls': True} if MONGODB_URI and MONGODB_URI.startswith('mongodb+srv') else {}
if MONGODB_URI:
    tls_kwargs = {**client_kwargs}
    if MONGODB_URI.startswith('mongodb+srv'):
        tls_kwargs['tlsCAFile'] = certifi.where()
    MONGO_CLIENT = MongoClient(MONGODB_URI, **tls_kwargs)
else:
    MONGO_CLIENT = None

CORS(app, origins="https://evergreenmedialabs.com", methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"])


def _get_collection() -> Optional[Collection]:
    if not MONGO_CLIENT:
        return None
    return MONGO_CLIENT[MONGODB_DB][MONGODB_COLLECTION]


def load_leads() -> List[Dict]:
    coll = _get_collection()
    if coll is None:
        if not LEADS_PATH.exists():
            return []
        try:
            content = LEADS_PATH.read_text(encoding='utf-8')
            if not content.strip():
                return []
            return json.loads(content)
        except json.JSONDecodeError:
            return []
    return list(coll.find({}, {'_id': False}))


def save_leads(leads: List[Dict]) -> None:
    coll = _get_collection()
    if coll is None:
        LEADS_PATH.parent.mkdir(parents=True, exist_ok=True)
        LEADS_PATH.write_text(json.dumps(leads, ensure_ascii=False, indent=2), encoding='utf-8')
        return
    coll.delete_many({})
    if leads:
        coll.insert_many(leads)


def _queue_approved_leads_for_sending() -> int:
    leads = load_leads()
    queued = 0
    for lead in leads:
        if (lead.get('status') or '').lower() == 'approved':
            lead['status'] = 'Queued'
            lead['queued_at'] = datetime.datetime.utcnow().isoformat()
            queued += 1
    if queued:
        save_leads(leads)
    return queued


SEND_THREAD_LOCK = threading.Lock()
SEND_THREAD: Optional[threading.Thread] = None
GENERATION_PROGRESS_LOCK = threading.Lock()
GENERATION_PROGRESS: Dict[str, object] = {
    'active': False,
    'current': 0,
    'total': 0,
    'message': 'Idle',
    'error': None,
    'updated_at': None,
}


def _set_generation_progress(**updates: object) -> None:
    with GENERATION_PROGRESS_LOCK:
        GENERATION_PROGRESS.update(updates)
        GENERATION_PROGRESS['updated_at'] = datetime.datetime.utcnow().isoformat()


def _increment_generation_progress() -> None:
    with GENERATION_PROGRESS_LOCK:
        GENERATION_PROGRESS['current'] = int(GENERATION_PROGRESS.get('current') or 0) + 1
        GENERATION_PROGRESS['updated_at'] = datetime.datetime.utcnow().isoformat()


def _get_generation_progress() -> Dict[str, object]:
    with GENERATION_PROGRESS_LOCK:
        return dict(GENERATION_PROGRESS)


def _build_html_body(body: str) -> str:
    escaped = (body or '').replace('\n', '<br/>')
    return f'<p>{escaped}</p>' if escaped else ''


def _dispatch_brevo_email(lead: Dict) -> None:
    if not BREVO_API_KEY:
        raise RuntimeError('BREVO_API_KEY is required to send email')
    payload = {
        'sender': {'name': BREVO_SENDER_NAME, 'email': BREVO_SENDER_EMAIL},
        'to': [{'email': lead.get('email'), 'name': lead.get('name')}],
        'subject': lead.get('email_subject') or f"Quick idea for {lead.get('name')}",
        'htmlContent': _build_html_body(lead.get('email_body', '')),
        'textContent': lead.get('email_body', ''),
    }
    headers = {'Content-Type': 'application/json', 'api-key': BREVO_API_KEY}
    response = requests.post(BREVO_ENDPOINT, json=payload, headers=headers, timeout=60)
    response.raise_for_status()


def _process_send_queue() -> None:
    global SEND_THREAD
    try:
        while True:
            leads = load_leads()
            targets = [
                lead
                for lead in leads
                if (lead.get('status') or '').lower() == 'queued' and not lead.get('sent_at')
            ]
            if not targets:
                app.logger.info('Send queue empty, stopping worker')
                break
            for lead in targets:
                try:
                    email_address = lead.get('email')
                    if not email_address:
                        continue
                    _dispatch_brevo_email(lead)
                    lead['status'] = 'Sent'
                    lead['sent_at'] = datetime.datetime.utcnow().isoformat()
                    save_leads(leads)
                except Exception as exc:
                    app.logger.error('Failed to send to %s: %s', lead.get('name'), exc)
                time.sleep(SEND_SLEEP_SECONDS)
    finally:
        with SEND_THREAD_LOCK:
            SEND_THREAD = None


def _ensure_send_thread() -> bool:
    global SEND_THREAD
    with SEND_THREAD_LOCK:
        if SEND_THREAD and SEND_THREAD.is_alive():
            return False
        thread = threading.Thread(target=_process_send_queue, daemon=True)
        SEND_THREAD = thread
        thread.start()
        return True


def serpapi_search(niche: str, start: int) -> Dict:
    if not SERPAPI_CLIENT:
        raise RuntimeError('SERPAPI_API_KEY is required to query SerpApi')
    params = {
        'engine': 'google_maps',
        'type': 'search',
        'q': f"{niche} in {CITY_CONTEXT}",
        'google_domain': 'google.com',
        'hl': 'en',
        'start': start,
        'api_key': SERPAPI_API_KEY,
    }
    result = SERPAPI_CLIENT.search(params=params)
    if hasattr(result, 'as_dict'):
        return result.as_dict()
    return dict(result or {})


def _has_website(place: Dict) -> bool:
    for key in ('website', 'website_url', 'webpage', 'websiteLink', 'homepage'):
        value = place.get(key)
        if value:
            return True
    return False


def extract_businesses(payload: Dict) -> Iterable[Dict]:
    raw = payload.get('local_results') or []
    if isinstance(raw, dict):
        raw = raw.get('results') or []
    for place in raw:
        title = place.get('title') or place.get('name')
        place_id = place.get('place_id') or place.get('data_id')
        if not title or not place_id:
            continue
        yield {
            'name': title,
            'address': place.get('address'),
            'phone': place.get('phone'),
            'place_id': place_id,
            'maps_url': place.get('link') or place.get('maps'),
            'rating': place.get('rating') or place.get('reviews', {}).get('rating'),
            'city': CITY_CONTEXT,
            'email': place.get('email') or place.get('emails') or place.get('website') or place.get('webpage'),
            'website': place.get('website') or place.get('website_url') or place.get('webpage'),
            'has_website': _has_website(place),
        }


def ai_prompt(name: str, city: str, category: str, rating: str) -> str:
    rating_str = f"{rating} star" if rating else 'rating unavailable'
    return textwrap.dedent(f"""
        You are helping a high school senior write a professional but warm outreach package.

        Business: {name}
        City: {city}
        Category: {category}
        Google Stars: {rating_str}

        Deliver JSON with two keys:
        1. "about": 2-3 sentences summarizing the business, mention a service detail and its current Google star review.
        2. "email": single paragraph (no greeting or closing) that follows these rules:
           - Written by a senior at D.C. Everest Senior High, tone slightly innocent + student entrepreneur.
           - Reference something specific about the business (service, reputation, city).
           - Mention building fully functioning websites that accommodate the {category} category.
           - Include a line that says if they already have a website, no worries; if interested in a new one or upgrade they can reply.
           - Ask them to email back if interested.
           - Include the sentence "I have built hundreds of websites in the area and it is my passion. I am highly skilled."
           - Include the sentence "I would love to start off by building you a website for free. No strings attached. If you love it, you can choose to proceed with developments."
           - No placeholders, no brackets, no "My name is".
           - Include https://evergreenmedialabs.com at the end.
        """
    ).strip()


def _find_json_block(text: str) -> str:
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1:
        return text.strip()
    return text[start:end + 1]


def call_openai(prompt: str) -> Dict[str, str]:
    if not OPENAI_CLIENT:
        raise RuntimeError('OPENAI_API_KEY is required to call OpenAI')
    resp = OPENAI_CLIENT.chat.completions.create(
        model='gpt-4o-mini',
        messages=[{'role': 'user', 'content': prompt}],
        temperature=0.35,
        max_tokens=400,
    )
    content = resp.choices[0].message.content.strip()
    candidate = _find_json_block(content)
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenAI response could not be parsed as JSON: {content}") from exc


def _find_email(payload: Dict) -> Optional[str]:
    email_candidates = [
        payload.get('email'),
        payload.get('emails'),
        payload.get('website'),
        payload.get('webpage'),
    ]
    for candidate in email_candidates:
        if candidate and isinstance(candidate, str) and '@' in candidate:
            return candidate
    return None


def _find_email(payload: Dict) -> Optional[str]:
    email_candidates = [
        payload.get('email'),
        payload.get('emails'),
        payload.get('website'),
        payload.get('webpage'),
    ]
    for candidate in email_candidates:
        if candidate and isinstance(candidate, str):
            match = EMAIL_RX.search(candidate)
            if match:
                return match.group(0)
    return None


def _search_for_email(name: str, city: str) -> Optional[str]:
    if not SERPAPI_CLIENT:
        return None
    params = {
        'engine': 'google',
        'q': f"{name} {city} email",
        'google_domain': 'google.com',
        'hl': 'en',
        'gl': 'us',
        'api_key': SERPAPI_API_KEY,
    }
    try:
        result = SERPAPI_CLIENT.search(params=params)
    except Exception:
        return None
    data = result.as_dict() if hasattr(result, 'as_dict') else dict(result or {})
    for bucket in data.get('organic_results', []):
        snippet = bucket.get('snippet', '') or ''
        match = EMAIL_RX.search(snippet)
        if match:
            return match.group(0)
    answer_box = data.get('answer_box') or {}
    email = answer_box.get('email')
    if email and EMAIL_RX.search(email):
        return EMAIL_RX.search(email).group(0)
    return None


def build_payload(instructions: Sequence[Dict[str, int]], existing_names: set) -> List[Dict]:
    generated = []
    for niche, count in instructions:
        collected = 0
        start = 0
        while collected < count:
            payload = serpapi_search(niche, start)
            places = list(extract_businesses(payload))
            if not places:
                break
            for place in places:
                name = place['name']
                if name.lower() in existing_names:
                    continue
                rating = place.get('rating')
                if place.get('has_website'):
                    continue
                email_address = _find_email(place) or _search_for_email(name, place['city'])
                if not email_address:
                    continue
                ai_output = call_openai(ai_prompt(name, place['city'], niche, rating or ""))
                generated.append(
                    {
                        'name': name,
                        'address': place.get('address'),
                        'phone': place.get('phone'),
                        'category': niche,
                        'place_id': place.get('place_id'),
                        'google_maps_url': place.get('maps_url'),
                        'about': ai_output['about'],
                        'email_subject': f"Quick idea for {name}",
                        'email_body': f"Hello,\n\n{ai_output['email']}\n\nThank you,\nOwner of Evergreen Media Labs",
                        'email': email_address,
                        'status': 'Drafted',
                        'validation_notes': 'Generated via automation',
                        'rating': rating,
                    }
                )
                existing_names.add(name.lower())
                collected += 1
                _increment_generation_progress()
                if collected >= count:
                    break
            start += 20
            if start > 120:
                break
    return generated


@app.route('/generate', methods=['POST'])
def generate_leads() -> Tuple[str, int]:
    if not SERPAPI_API_KEY or not OPENAI_API_KEY:
        return jsonify({'error': 'SERPAPI_API_KEY and OPENAI_API_KEY are required'}), 400
    data = request.get_json() or []
    instructions = []
    for entry in data:
        niche = (entry.get('niche') or entry.get('category') or '').strip()
        count = int(entry.get('count', 0))
        if niche and count > 0:
            instructions.append((niche, count))
    if not instructions:
        return jsonify({'error': 'No valid niches provided'}), 400

    leads = load_leads()
    names = {lead.get('name', '').lower() for lead in leads}
    total_requested = sum(count for _, count in instructions)
    _set_generation_progress(
        active=True,
        current=0,
        total=total_requested,
        message='Generating leads',
        error=None,
    )
    run_started = time.time()
    run_id = f"gen_{datetime.datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
    try:
        generated = build_payload(instructions, names)
    except Exception as exc:
        _set_generation_progress(active=False, message='Generation failed', error=str(exc))
        raise
    if not generated:
        _set_generation_progress(active=False, message='No new leads were generated')
        return jsonify({'message': 'No new leads were generated', 'requested': total_requested, 'generated': 0}), 200

    elapsed_seconds = max(0.0, time.time() - run_started)
    per_lead_seconds = elapsed_seconds / len(generated) if generated else 0.0
    generated_at = datetime.datetime.utcnow().isoformat()
    for lead in generated:
        lead['generated_at'] = generated_at
        lead['generation_run_id'] = run_id
        lead['generation_requested_count'] = total_requested
        lead['generation_generated_count'] = len(generated)
        lead['generation_elapsed_seconds'] = round(elapsed_seconds, 3)
        lead['generation_seconds_per_lead'] = round(per_lead_seconds, 3)

    leads.extend(generated)
    save_leads(leads)
    _set_generation_progress(
        active=False,
        current=len(generated),
        total=total_requested,
        message='Generated leads',
        error=None,
    )
    return (
        jsonify(
            {
                'message': 'Generated leads',
                'count': len(generated),
                'requested': total_requested,
                'generated': len(generated),
            }
        ),
        200,
    )


@app.route('/generate/progress', methods=['GET'])
def get_generate_progress() -> Tuple[str, int]:
    return jsonify(_get_generation_progress()), 200


@app.route('/leads', methods=['GET'])
def get_leads() -> Tuple[str, int]:
    leads = load_leads()
    return jsonify(leads), 200


@app.route('/leads/<place_id>', methods=['DELETE'])
def delete_lead(place_id: str) -> Tuple[str, int]:
    coll = _get_collection()
    if coll is not None:
        result = coll.delete_one({'place_id': place_id})
        if result.deleted_count == 0:
            return jsonify({'error': 'Lead not found'}), 404
        return jsonify({'message': 'Lead deleted', 'count': coll.count_documents({})}), 200
    leads = load_leads()
    updated = [lead for lead in leads if lead.get('place_id') != place_id]
    if len(updated) == len(leads):
        return jsonify({'error': 'Lead not found'}), 404
    save_leads(updated)
    return jsonify({'message': 'Lead deleted', 'count': len(updated)}), 200


@app.route('/leads/<place_id>/status', methods=['PATCH'])
def update_status(place_id: str) -> Tuple[str, int]:
    payload = request.get_json() or {}
    status = payload.get('status')
    if status not in ('Drafted', 'Approved', 'Queued', 'Sent'):
        return jsonify({'error': 'Invalid status'}), 400
    coll = _get_collection()
    if coll is not None:
        result = coll.update_one({'place_id': place_id}, {'$set': {'status': status}})
        if result.matched_count == 0:
            return jsonify({'error': 'Lead not found'}), 404
        return jsonify({'message': 'Status updated'}), 200
    leads = load_leads()
    found = False
    for lead in leads:
        if lead.get('place_id') == place_id:
            lead['status'] = status
            found = True
            break
    if not found:
        return jsonify({'error': 'Lead not found'}), 404
    save_leads(leads)
    return jsonify({'message': 'Status updated'}), 200


@app.route('/send', methods=['POST'])
def trigger_send() -> Tuple[str, int]:
    if not BREVO_API_KEY:
        return jsonify({'error': 'BREVO_API_KEY is required to send emails'}), 400
    queued = _queue_approved_leads_for_sending()
    thread_started = _ensure_send_thread()
    if queued:
        message = f'Queued {queued} lead{"s" if queued != 1 else ""} for send'
    elif not thread_started:
        message = 'Send queue already running'
    else:
        message = 'No approved leads to queue'
    return jsonify({'message': message, 'queued': queued}), 200


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Serve the Evergreen Media Labs generator.')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind .')
    parser.add_argument('--port', type=int, default=5000, help='Port to listen on.')
    parser.add_argument('--debug', action='store_true', help='Enable Flask debug mode.')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == '__main__':
    main()
