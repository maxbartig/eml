#!/usr/bin/env python3
'''Flask-backed generator that reuses SerpApi + OpenAI to populate ld/data/leads.json.'''
import argparse
import json
import os
import textwrap
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from flask import Flask, jsonify, request
from serpapi import GoogleSearch
import openai

BASE_DIR = Path(__file__).resolve().parent
LEADS_PATH = BASE_DIR / 'ld' / 'data' / 'leads.json'
CITY_CONTEXT = 'Wausau, Wisconsin, United States'
SERPAPI_API_KEY = os.environ.get('SERPAPI_API_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')

app = Flask(__name__)


def load_leads() -> List[Dict]:
    if not LEADS_PATH.exists():
        return []
    return json.loads(LEADS_PATH.read_text(encoding='utf-8'))


def save_leads(leads: List[Dict]) -> None:
    LEADS_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEADS_PATH.write_text(json.dumps(leads, ensure_ascii=False, indent=2), encoding='utf-8')


def serpapi_search(niche: str, start: int) -> Dict:
    params = {
        'engine': 'google_maps',
        'type': 'search',
        'q': f"{niche} in {CITY_CONTEXT}",
        'google_domain': 'google.com',
        'hl': 'en',
        'start': start,
        'api_key': SERPAPI_API_KEY,
    }
    return GoogleSearch(params).get_dict()


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


def call_openai(prompt: str) -> Dict[str, str]:
    openai.api_key = OPENAI_API_KEY
    resp = openai.ChatCompletion.create(
        model='gpt-4o-mini',
        messages=[{'role': 'user', 'content': prompt}],
        temperature=0.35,
        max_tokens=400,
    )
    content = resp.choices[0].message.get('content', '').strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenAI response could not be parsed as JSON: {content}") from exc


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
                        'email': place.get('phone') or '',
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
