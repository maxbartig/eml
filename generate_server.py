#!/usr/bin/env python3
'''Flask-backed generator that reuses SerpApi + OpenAI to populate ld/data/leads.json.'''
import argparse
import json
import os
import textwrap
from pathlib import Path
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from flask import Flask, jsonify, request
from flask_cors import CORS
from serpapi import Client
from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent
LEADS_PATH = BASE_DIR / 'ld' / 'data' / 'leads.json'
CITY_CONTEXT = 'Wausau, Wisconsin, United States'
EMAIL_RX = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SERPAPI_API_KEY = os.environ.get('SERPAPI_API_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
SERPAPI_CLIENT = Client(api_key=SERPAPI_API_KEY) if SERPAPI_API_KEY else None
OPENAI_CLIENT = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

app = Flask(__name__)
CORS(app, origins="https://evergreenmedialabs.com")


def load_leads() -> List[Dict]:
    if not LEADS_PATH.exists():
        return []
    return json.loads(LEADS_PATH.read_text(encoding='utf-8'))


def save_leads(leads: List[Dict]) -> None:
    LEADS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEADS_PATH.write_text(json.dumps(leads, ensure_ascii=False, indent=2), encoding='utf-8')


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
                        'validation_notes': 'Generated via automation',
                        'rating': rating,
                    }
                )
                existing_names.add(name.lower())
                collected += 1
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
    generated = build_payload(instructions, names)
    if not generated:
        return jsonify({'message': 'No new leads were generated'}), 200

    leads.extend(generated)
    save_leads(leads)
    return jsonify({'message': 'Generated leads', 'count': len(generated)}), 200


@app.route('/leads', methods=['GET'])
def get_leads() -> Tuple[str, int]:
    leads = load_leads()
    return jsonify(leads), 200


@app.route('/leads/<place_id>', methods=['DELETE'])
def delete_lead(place_id: str) -> Tuple[str, int]:
    leads = load_leads()
    updated = [lead for lead in leads if lead.get('place_id') != place_id]
    if len(updated) == len(leads):
        return jsonify({'error': 'Lead not found'}), 404
    save_leads(updated)
    return jsonify({'message': 'Lead deleted', 'count': len(updated)}), 200


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
