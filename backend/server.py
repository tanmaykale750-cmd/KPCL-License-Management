"""
KPCL integration API (Python standard library HTTP server; no new framework).

    python -m backend.server                # http://127.0.0.1:8000  (run from the project root)
    python -m backend.server --port 8000 --warm

Serves /api/* and, when frontend/dist exists (npm run build), the built frontend with SPA fallback.
Every /api call except /api/health, /api/auth/login and /api/auth/demo-accounts needs the signed session from the
employee sign-in. What each profile may call is decided in backend/auth.py (SCOPES).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import app_services as svc
from . import auth

DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _pool(q: dict) -> tuple[str, str]:
    pf, sw = (q.get("portfolio_id") or [""])[0].upper(), (q.get("software_id") or [""])[0].upper()
    if not pf or not sw:
        raise ValueError("portfolio_id and software_id are required")
    return pf, sw


class Handler(BaseHTTPRequestHandler):
    server_version = "KPCL/1.0"

    # ------------------------------------------------------------------ plumbing
    def log_message(self, fmt, *args):  # quieter logs
        if self.server.verbose:  # type: ignore[attr-defined]
            super().log_message(fmt, *args)

    def _send(self, status: int, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(svc.jsonable(payload) if ctype == "application/json"
                                                                     else payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        data = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("JSON object expected")
        return data

    def _user(self, scope: str | None = None) -> dict:
        h = self.headers.get("Authorization", "")
        user = auth.session_user(h[7:] if h.lower().startswith("bearer ") else None)
        if scope:
            auth.require(user, scope)
        return user

    def _dispatch(self, method: str):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self._static(url.path) if method == "GET" else self._send(404, {"error": "not_found"})
        q = parse_qs(url.query)
        try:
            route = ROUTES.get((method, url.path))
            if route is None:
                return self._send(404, {"error": "not_found", "message": f"No route {method} {url.path}"})
            status, payload = route(self, q)
            self._send(status, payload)
        except auth.AuthError as e:
            self._send(e.status, {"error": e.code, "message": e.message})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": "bad_request", "message": str(e)})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": "server_error", "message": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _static(self, path: str):
        if not DIST.is_dir():
            return self._send(404, {"error": "frontend_not_built", "message": "Run `npm run build` in frontend/ or use `npm run dev`."})
        f = (DIST / path.lstrip("/")).resolve()
        if not str(f).startswith(str(DIST.resolve())) or not f.is_file():
            f = DIST / "index.html"
        self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")

    # ------------------------------------------------------------------ routes
    def health(self, q):
        return 200, {"status": "ok", **svc.status()}

    def login(self, q):
        b = self._body()
        user = auth.verify_employee(b.get("employee_id"), b.get("email"), b.get("designation"))
        return 200, {"token": auth.issue_token(user), "user": user}

    def me(self, q):
        return 200, {"user": self._user()}

    def pools(self, q):
        self._user("forecast")
        return 200, svc.pools()

    def forecast(self, q):
        self._user("forecast")
        return 200, svc.forecast(*_pool(q))

    def explain(self, q):
        self._user("forecast")
        return 200, svc.explain(*_pool(q))

    def recommendation(self, q):
        user = self._user("recommend")
        return 200, svc.recommendation(*_pool(q), costs="costs" in user["scopes"])

    def optimisation(self, q):
        self._user("optimise")
        return 200, svc.optimisation()

    def whatif(self, q):
        user = self._user()
        body = self._body()
        # licence-supply changes need 'simulate'; schedule-only changes (delay / cancel / team size) need 'simulate_plan'
        supply = bool(int(body.get("licence_change") or 0) or int(body.get("temp_licences") or 0))
        auth.require(user, "simulate") if supply else auth.require_any(user, "simulate_plan", "simulate")
        return 200, svc.what_if(body, costs="costs" in user["scopes"])

    def chat(self, q):
        user = self._user("chat")
        b = self._body()
        question = str(b.get("question") or "").strip()
        if not question:
            raise ValueError("question is required")
        if len(question) > 2000:
            raise ValueError("question is too long (2000 characters at most)")
        history = b.get("history") or []
        focus = tuple(b["focus"]) if b.get("focus") else None
        # The viewer is built from the verified session, never from the request body. The chat engine only runs a
        # what-if the profile permits and redacts rupee amounts for profiles without the 'costs' scope.
        return 200, svc.chat(question, history, focus, viewer=user)

    def team(self, q):
        # every profile may call this; auth.team() limits the people to the caller's scope
        # (engineers get only themselves and their contacts)
        return 200, auth.team(self._user())

    def demo_accounts(self, q):
        return 200, {"accounts": auth.demo_accounts()}


ROUTES = {
    ("GET", "/api/health"): Handler.health,
    ("POST", "/api/auth/login"): Handler.login,
    ("GET", "/api/auth/me"): Handler.me,
    ("GET", "/api/pools"): Handler.pools,
    ("GET", "/api/forecast"): Handler.forecast,
    ("GET", "/api/forecast/explain"): Handler.explain,
    ("GET", "/api/recommendation"): Handler.recommendation,
    ("GET", "/api/optimisation"): Handler.optimisation,
    ("POST", "/api/whatif"): Handler.whatif,
    ("POST", "/api/chat"): Handler.chat,
    ("GET", "/api/team"): Handler.team,
    ("GET", "/api/auth/demo-accounts"): Handler.demo_accounts,
}


def make_server(host="127.0.0.1", port=8000, verbose=False) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.verbose = verbose  # type: ignore[attr-defined]
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--warm", action="store_true", help="load the ensemble and knowledge base before serving")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    if a.warm:
        print("Loading ensemble, recommendation engine and knowledge base ...")
        svc.services()
        print("Ready:", svc.status().get("model", {}).get("label"))
    else:
        threading.Thread(target=lambda: _quiet(svc.services), daemon=True).start()
    srv = make_server(a.host, a.port, a.verbose)
    print(f"KPCL API on http://{a.host}:{a.port}  (frontend: {'frontend/dist' if DIST.is_dir() else 'run npm run dev in frontend/'})")
    srv.serve_forever()


def _quiet(fn):
    try:
        fn()
    except Exception as e:  # reported by /api/health
        print(f"Service start-up failed: {e}")


if __name__ == "__main__":
    main()
