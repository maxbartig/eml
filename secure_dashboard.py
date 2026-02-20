#!/usr/bin/env python3
"""Serve the lead dashboard with a single HTTP Basic auth user."""

import argparse
import base64
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class AuthHandler(SimpleHTTPRequestHandler):
    realm = "Evergreen Media Labs"

    def __init__(self, *args, directory=None, **kwargs):
        self._auth_token = self.server.auth_token  # type: ignore[attr-defined]
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self):
        if not self._is_authenticated():
            self._send_401()
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._is_authenticated():
            self._send_401()
            return
        super().do_HEAD()

    def _send_401(self) -> None:
        self.send_response(401)
        self.send_header("WWW-Authenticate", f'Basic realm="{self.realm}"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _is_authenticated(self) -> bool:
        header = self.headers.get("Authorization")
        if not header or not header.startswith("Basic "):
            return False
        token = header.split(" ", 1)[1].strip()
        return token == self._auth_token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the Evergreen Media Labs dashboard with HTTP auth.")
    parser.add_argument("--dir", default="ld", help="Directory to serve (defaults to ld)")
    parser.add_argument("--host", default="", help="Host/interface to bind (default all)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    user = os.environ.get("LEAD_DASHBOARD_USER")
    password = os.environ.get("LEAD_DASHBOARD_PASSWORD")
    if not user or not password:
        print("Set LEAD_DASHBOARD_USER and LEAD_DASHBOARD_PASSWORD to use the secure server.", file=sys.stderr)
        sys.exit(1)

    cred = f"{user}:{password}".encode("utf-8")
    token = base64.b64encode(cred).decode("ascii")

    handler = AuthHandler
    server = HTTPServer((args.host, args.port), handler)
    server.auth_token = token  # type: ignore[attr-defined]
    handler.server = server  # type: ignore[attr-defined]

    print(f"Serving {args.dir} at http://{args.host or 'localhost'}:{args.port}/lead-dashboard.html")
    print(f"Authenticated user: {user}")
    os.chdir(args.dir)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
