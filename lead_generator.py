#!/usr/bin/env python3
"""Lead generator that uses SerpApi to build a JSON feed for the lead dashboard."""

import argparse
import csv
import json
import logging
import os
import re
import time
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

from serpapi import GoogleSearch

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_JSON_OUTPUT = os.path.join(SCRIPT_DIR, "ld", "data", "leads.json")
DEFAULT_SENDER_NAME = "Evergreen Media Labs"
EXCLUDED_DOMAINS = {
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "yelp.com",
    "foursquare.com",
    "manta.com",
    "linkedin.com",
    "tripadvisor.com",
    "bbb.org",
}
CSV_FIELDS = [
    "name",
    "address",
    "phone",
    "place_id",
    "google_maps_url",
    "email",
    "about",
    "email_subject",
    "email_body",
    "validation_notes",
]
EMAIL_REGEX = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
MIN_SUMMARY_LENGTH = 20
SUMMARY_TRUNCATE = 280


class LeadGenerator:
    def __init__(
        self,
        api_key: str,
        maps_query: str,
        ll: str,
        city: str,
        max_pages: int,
        request_delay: float,
        json_output: str,
        csv_output: Optional[str],
        overwrite: bool,
        sender_name: str,
    ):
        self.api_key = api_key
        self.maps_query = maps_query
        self.ll = ll
        self.city = city
        self.max_pages = max_pages
        self.request_delay = request_delay
        self.json_output = json_output
        self.csv_output = csv_output
        self.overwrite = overwrite
        self.sender_name = sender_name
        self.seen_place_ids = set()

    def _maps_search(self, start: int) -> Dict:
        params = {
            "engine": "google_maps",
            "type": "search",
            "q": self.maps_query,
            "ll": self.ll,
            "start": start,
            "google_domain": "google.com",
            "hl": "en",
            "api_key": self.api_key,
        }
        logging.debug("Maps search params: %s", params)
        return GoogleSearch(params).get_dict()

    def _google_search(self, query: str) -> Dict:
        params = {
            "engine": "google",
            "q": query,
            "location": self.city,
            "google_domain": "google.com",
            "hl": "en",
            "api_key": self.api_key,
        }
        return GoogleSearch(params).get_dict()

    def _extract_people_from_maps(self, payload: Dict) -> Iterable[Dict]:
        raw = payload.get("local_results") or []
        if isinstance(raw, dict):
            raw = raw.get("results") or []
        return raw

    def _extract_maps_website(self, place: Dict) -> Optional[str]:
        links = place.get("links", {}) or {}
        return links.get("website")

    def _build_maps_url(self, place: Dict) -> Optional[str]:
        place_id = place.get("place_id")
        if place_id:
            return f"https://www.google.com/maps/search/?api=1&query_place_id={place_id}"
        return place.get("links", {}).get("maps")

    def _filter_local_results(self, data: Dict) -> List[Dict]:
        results = []
        for place in self._extract_people_from_maps(data):
            place_id = place.get("place_id") or place.get("data_id")
            if not place_id or place_id in self.seen_place_ids:
                continue
            self.seen_place_ids.add(place_id)
            if self._extract_maps_website(place):
                continue
            results.append(place)
        return results

    def _site_found_in_google(self, place_name: str) -> Optional[str]:
        query = f"{place_name} {self.city} official website"
        results = self._google_search(query)
        for result in results.get("organic_results", []):
            url = result.get("link")
            if not url:
                continue
            domain = urlparse(url).netloc.lower()
            domain = domain.replace("www.", "")
            if domain in EXCLUDED_DOMAINS:
                continue
            return url
        return None

    @staticmethod
    def _clean_text(text: Optional[str]) -> Optional[str]:
        if not text:
            return None
        return " ".join(str(text).split())

    def _extract_maps_snippet(self, place: Dict) -> Optional[str]:
        for key in ("description", "snippet", "short_description", "long_description"):
            if text := self._clean_text(place.get(key)):
                return text
        return None

    def _pick_summary(self, candidates: Iterable[Optional[str]]) -> Optional[str]:
        for candidate in candidates:
            cleaned = self._clean_text(candidate)
            if not cleaned:
                continue
            if len(cleaned) > SUMMARY_TRUNCATE:
                cleaned = f"{cleaned[: SUMMARY_TRUNCATE - 3]}..."
            if len(cleaned) >= MIN_SUMMARY_LENGTH:
                return cleaned
        return None

    def _site_or_email_summary(self, place: Dict) -> Tuple[Optional[str], Optional[str]]:
        query = f"{place.get('title')} {self.city} email"
        results = self._google_search(query)
        fields: List[Optional[str]] = []
        summary_candidates: List[Optional[str]] = []
        if answer := results.get("answer_box"):
            fields.append(answer.get("answer"))
            fields.append(answer.get("snippet"))
            summary_candidates.append(answer.get("snippet") or answer.get("answer"))
        for block in results.get("organic_results", []):
            if snippet := block.get("snippet"):
                fields.append(snippet)
                summary_candidates.append(snippet)
            if title := block.get("title"):
                fields.append(title)
                summary_candidates.append(title)
            rich = block.get("rich_snippet", {})
            top = rich.get("top", {})
            if top_snippet := top.get("snippet"):
                fields.append(top_snippet)
                summary_candidates.append(top_snippet)
        if kg := results.get("knowledge_graph"):
            if description := kg.get("description"):
                fields.append(description)
                summary_candidates.append(description)
            if title := kg.get("title"):
                fields.append(title)
                summary_candidates.append(title)
        email = None
        for text in filter(None, fields):
            cleaned = self._clean_text(text)
            if email := self._extract_email_from_text(cleaned):
                break
        summary = self._pick_summary(summary_candidates)
        if not summary:
            summary = self._extract_maps_snippet(place)
        return email, summary

    def _build_email_template(self, name: Optional[str], about: Optional[str]) -> Dict[str, str]:
        display_name = name or "your business"
        subject = f"Quick idea for {display_name}"
        first_name = name.split()[0] if name else "there"
        city_label = (self.city.split(",")[0] if self.city else "Wausau").strip()
        about_line = ""
        if about:
            sanitized = about.rstrip(".")
            about_line = f" I noticed {sanitized}."
        body = (
            f"Hi {first_name},\n\n"
            f"I'm with {self.sender_name}. Many {city_label} businesses I work with don't have a website yet, so customers only see a phone number on Google. "
            "We can launch a clean landing page in a few days that highlights your services, hours, and the best ways for people to contact you."
        )
        if about_line:
            body = f"{body}{about_line}"
        body = (
            f"{body}\n\n"
            f"Would you be open to a quick 10-minute call to explore a no-pressure plan for getting {display_name} online?\n\n"
            "Best,\n"
            f"{self.sender_name}"
        )
        return {"subject": subject, "body": body}

    def _write_json(self, leads: List[Dict]) -> None:
        os.makedirs(os.path.dirname(self.json_output) or ".", exist_ok=True)
        with open(self.json_output, "w", encoding="utf-8") as f:
            json.dump(leads, f, ensure_ascii=False, indent=2)
        logging.info("Wrote %d leads to %s", len(leads), self.json_output)

    def _write_csv(self, leads: List[Dict]) -> None:
        if not self.csv_output:
            return
        os.makedirs(os.path.dirname(self.csv_output) or ".", exist_ok=True)
        mode = "w" if self.overwrite else "a"
        write_header = not os.path.exists(self.csv_output) or self.overwrite
        with open(self.csv_output, mode, newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=CSV_FIELDS)
            if write_header:
                writer.writeheader()
            writer.writerows(leads)
        logging.info("Wrote %d leads to %s", len(leads), self.csv_output)

    def run(self) -> None:
        collected: List[Dict] = []
        for page in range(self.max_pages):
            start = page * 20
            logging.info("Fetching Maps page %s (start=%s)", page + 1, start)
            payload = self._maps_search(start)
            candidates = self._filter_local_results(payload)
            if not candidates:
                logging.info("No more candidates returned; stopping.")
                break
            for candidate in candidates:
                name = candidate.get("title")
                address = candidate.get("address")
                phone = candidate.get("phone")
                maps_url = self._build_maps_url(candidate)
                logging.debug("Inspecting %s", name)
                if self._site_found_in_google(name):
                    logging.debug("Website still exists for %s; skipping", name)
                    continue
                email, about = self._site_or_email_summary(candidate)
                if not email:
                    logging.debug("No email for %s; skipping", name)
                    continue
                template = self._build_email_template(name, about)
                collected.append(
                    {
                        "name": name,
                        "address": address,
                        "phone": phone,
                        "place_id": candidate.get("place_id") or candidate.get("data_id"),
                        "google_maps_url": maps_url,
                        "email": email,
                        "about": about or "",
                        "email_subject": template["subject"],
                        "email_body": template["body"],
                        "validation_notes": "Verified no website and email located",
                    }
                )
                time.sleep(self.request_delay)
            time.sleep(self.request_delay)
        self._write_json(collected)
        self._write_csv(collected)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lead generator for Wausau businesses lacking websites but providing email."
    )
    parser.add_argument("--maps-query", default="businesses in Wausau, Wisconsin", help="Google Maps search query")
    parser.add_argument("--ll", default="44.9591,-89.6301", help="Latitude,longitude for search center")
    parser.add_argument("--city", default="Wausau, Wisconsin, United States", help="City context for validation searches")
    parser.add_argument("--pages", type=int, default=3, help="How many Google Maps pages (20 results each) to scan")
    parser.add_argument("--delay", type=float, default=1.5, help="Seconds to wait between SerpApi requests")
    parser.add_argument("--json-output", default=DEFAULT_JSON_OUTPUT, help="JSON feed path for the website widget")
    parser.add_argument("--csv-output", help="Optional CSV file path if you still need a spreadsheet export")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite any existing CSV instead of appending")
    parser.add_argument("--sender-name", default=DEFAULT_SENDER_NAME, help="Name to use in the email template closing")
    parser.add_argument("--api-key", help="SerpApi API key; falls back to SERPAPI_API_KEY env var")
    return parser.parse_args()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    args = parse_args()
    api_key = args.api_key or os.environ.get("SERPAPI_API_KEY")
    if not api_key:
        logging.error("SerpApi API key required via --api-key or SERPAPI_API_KEY env var")
        raise SystemExit(1)

    generator = LeadGenerator(
        api_key=api_key,
        maps_query=args.maps_query,
        ll=args.ll,
        city=args.city,
        max_pages=args.pages,
        request_delay=args.delay,
        json_output=os.path.expanduser(args.json_output),
        csv_output=os.path.expanduser(args.csv_output) if args.csv_output else None,
        overwrite=args.overwrite,
        sender_name=args.sender_name,
    )
    generator.run()


if __name__ == "__main__":
    main()
