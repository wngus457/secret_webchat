#!/usr/bin/env python3
"""Small private team chat. Standard library only; all state lives in memory.

    CHAT_PASSWORD=secret python3 server.py

Environment: CHAT_PASSWORD (random if unset), HOST (127.0.0.1), PORT (8000).
"""
import base64
import hmac
import json
import os
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent / "public"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

MAX_MEMBERS = 7
MAX_NAME = 16
MAX_TEXT = 2000
MAX_PASSWORD = 72
MAX_IMAGE = 3 * 1024 * 1024
MAX_IMAGES_TOTAL = 100 * 1024 * 1024
MAX_REQUEST = 5 * 1024 * 1024
MAX_MESSAGES = 300
TEXT_TTL = 24 * 3600
IMAGE_TTL = 5 * 60
ACTIVE_WINDOW = 15
SESSION_IDLE = 30 * 60
LOGIN_ATTEMPTS = 5
LOGIN_LOCK = 60
REACTIONS = ("thumbs_up", "heart", "laugh", "surprise", "sad", "clap")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_ms():
    return int(time.time() * 1000)


def image_type(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def text_arg(data, key):
    value = data.get(key)
    return value if isinstance(value, str) else ""


class Room:
    def __init__(self, password):
        self.password = password.encode()
        self.id = uuid.uuid4().hex
        self.lock = threading.Lock()
        self.sessions = {}
        self.messages = {}
        self.seq = 0
        self.failures = {}

    def _prune(self):
        now = now_ms()
        cutoff = now - SESSION_IDLE * 1000
        self.sessions = {t: s for t, s in self.sessions.items() if s["seen"] > cutoff}
        live = [m for m in self.messages.values() if m["expires_at"] > now][-MAX_MESSAGES:]
        self.messages = {m["id"]: m for m in live}

    def _session(self, token):
        self._prune()
        session = self.sessions.get(token)
        if not session:
            raise ApiError(401, "접속이 만료되었습니다. 다시 입장해 주세요.")
        session["seen"] = now_ms()
        return session

    def _add(self, kind, name, body, ttl, reply_to=None, image=None, image_mime=None):
        created = now_ms()
        self.seq += 1
        message = {
            "id": uuid.uuid4().hex, "seq": self.seq, "kind": kind, "name": name, "body": body,
            "created_at": created, "expires_at": created + ttl * 1000, "reply_to": reply_to,
            "reactions": {}, "image": image, "image_mime": image_mime,
        }
        self.messages[message["id"]] = message
        return message

    def _reply_target(self, reply_to):
        if not reply_to:
            return None
        target = self.messages.get(reply_to)
        if not target or target["kind"] == "join":
            raise ApiError(404, "원문이 사라졌습니다. 답장을 취소한 뒤 보내 주세요.")
        return reply_to

    def _view(self, message, me):
        reply = self.messages.get(message["reply_to"]) if message["reply_to"] else None
        picked = list(message["reactions"].values())
        return {
            "id": message["id"], "seq": message["seq"], "kind": message["kind"],
            "name": message["name"], "body": message["body"],
            "created_at": message["created_at"], "expires_at": message["expires_at"],
            "mine": message["name"] == me,
            "reply_to": message["reply_to"],
            "reply": reply and {"name": reply["name"], "kind": reply["kind"], "body": reply["body"][:180]},
            "reactions": [
                {"key": key, "count": picked.count(key), "mine": message["reactions"].get(me) == key}
                for key in REACTIONS if key in picked
            ],
        }

    def login(self, name, password, ip):
        name = " ".join(name.split())
        if not 1 <= len(name) <= MAX_NAME:
            raise ApiError(400, f"이름은 1~{MAX_NAME}자로 입력해 주세요.")
        with self.lock:
            self._prune()
            now = time.time()
            count, until = self.failures.get(ip, (0, 0))
            if until > now:
                raise ApiError(429, "시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
            if len(password) > MAX_PASSWORD or not hmac.compare_digest(password.encode(), self.password):
                count += 1
                self.failures[ip] = (0, now + LOGIN_LOCK) if count >= LOGIN_ATTEMPTS else (count, 0)
                raise ApiError(403, "비밀번호가 올바르지 않습니다.")
            self.failures.pop(ip, None)
            existing = [t for t, s in self.sessions.items() if s["name"] == name]
            if not existing and len(self.sessions) >= MAX_MEMBERS:
                raise ApiError(403, f"정원 {MAX_MEMBERS}명이 모두 입장했습니다.")
            for token in existing:  # the newest login with a name takes it over
                del self.sessions[token]
            token = secrets.token_urlsafe(32)
            stamp = now_ms()
            self.sessions[token] = {"name": name, "seen": stamp, "active": stamp}
            if not existing:
                self._add("join", name, "", TEXT_TTL)
            return {"token": token}

    def sync(self, token, active):
        with self.lock:
            session = self._session(token)
            if active:
                session["active"] = session["seen"]
            limit = now_ms() - ACTIVE_WINDOW * 1000
            return {
                "room": self.id,
                "name": session["name"],
                "members": [
                    {"name": s["name"], "online": s["active"] > limit}
                    for s in sorted(self.sessions.values(), key=lambda s: s["name"])
                ],
                "messages": [self._view(m, session["name"]) for m in self.messages.values()],
            }

    def send(self, token, body, reply_to):
        body = body.strip()
        if not 1 <= len(body) <= MAX_TEXT:
            raise ApiError(400, f"메시지는 1~{MAX_TEXT}자로 입력해 주세요.")
        with self.lock:
            session = self._session(token)
            self._add("text", session["name"], body, TEXT_TTL, self._reply_target(reply_to))
            return {"ok": True}

    def send_image(self, token, encoded, caption, reply_to):
        caption = caption.strip()
        if len(caption) > MAX_TEXT:
            raise ApiError(400, f"설명은 {MAX_TEXT}자 이내로 입력해 주세요.")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise ApiError(400, "이미지를 읽지 못했습니다.")
        mime = image_type(data)
        if not mime:
            raise ApiError(400, "JPEG, PNG, WebP 이미지만 보낼 수 있습니다.")
        if len(data) > MAX_IMAGE:
            raise ApiError(413, "이미지는 3MB 이하만 보낼 수 있습니다.")
        with self.lock:
            session = self._session(token)
            target = self._reply_target(reply_to)
            used = sum(len(m["image"]) for m in self.messages.values() if m["image"])
            if used + len(data) > MAX_IMAGES_TOTAL:
                raise ApiError(507, "이미지 저장 공간이 찼습니다. 잠시 후 다시 시도하세요.")
            self._add("image", session["name"], caption, IMAGE_TTL, target, data, mime)
            return {"ok": True}

    def image(self, token, message_id):
        with self.lock:
            self._session(token)
            message = self.messages.get(message_id)
            if not message or not message["image"]:
                raise ApiError(404, "이미지가 만료되었습니다.")
            return message["image"], message["image_mime"]

    def delete(self, token, message_id):
        with self.lock:
            session = self._session(token)
            message = self.messages.get(message_id)
            if not message:
                raise ApiError(404, "이미 삭제된 메시지입니다.")
            if message["name"] != session["name"] or message["kind"] == "join":
                raise ApiError(403, "내 메시지만 삭제할 수 있습니다.")
            del self.messages[message_id]
            return {"ok": True}

    def react(self, token, message_id, key):
        with self.lock:
            session = self._session(token)
            message = self.messages.get(message_id)
            if not message or message["kind"] == "join":
                raise ApiError(404, "메시지를 찾을 수 없습니다.")
            if message["name"] == session["name"]:
                raise ApiError(403, "내 메시지에는 반응할 수 없습니다.")
            if key == "off":
                message["reactions"].pop(session["name"], None)
            elif key in REACTIONS:
                message["reactions"][session["name"]] = key
            else:
                raise ApiError(400, "알 수 없는 반응입니다.")
            return {"ok": True}

    def leave(self, token):
        with self.lock:
            self.sessions.pop(token, None)
            return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "webchat"
    sys_version = ""
    timeout = 60

    def log_message(self, *args):
        pass

    def _respond(self, status, payload, content_type):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, data):
        self._respond(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _token(self):
        header = self.headers.get("Authorization", "")
        return header[7:] if header.startswith("Bearer ") else ""

    def _guarded(self, action):
        try:
            action()
        except ApiError as error:
            self._json(error.status, {"error": error.message})
        except Exception:
            self._json(500, {"error": "서버 오류가 발생했습니다."})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in STATIC:
            name, content_type = STATIC[path]
            self._respond(200, (PUBLIC / name).read_bytes(), content_type)
        elif path.startswith("/api/image/"):
            self._guarded(lambda: self._image(path[len("/api/image/"):]))
        else:
            self._json(404, {"error": "찾을 수 없습니다."})

    def _image(self, message_id):
        data, mime = self.server.room.image(self._token(), message_id)
        self._respond(200, data, mime)

    def do_POST(self):
        self._guarded(self._api)

    def _api(self):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise ApiError(411, "요청 길이가 필요합니다.")
        if not 0 <= length <= MAX_REQUEST:
            self.close_connection = True
            raise ApiError(413, "요청이 너무 큽니다.")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "잘못된 요청입니다.")
        if not isinstance(data, dict):
            raise ApiError(400, "잘못된 요청입니다.")

        room, token = self.server.room, self._token()
        op = self.path.split("?", 1)[0]
        if op == "/api/login":
            result = room.login(text_arg(data, "name"), text_arg(data, "password"), self.client_address[0])
        elif op == "/api/sync":
            result = room.sync(token, data.get("active") is True)
        elif op == "/api/send":
            result = room.send(token, text_arg(data, "body"), text_arg(data, "reply_to"))
        elif op == "/api/image":
            result = room.send_image(token, text_arg(data, "data"), text_arg(data, "body"), text_arg(data, "reply_to"))
        elif op == "/api/delete":
            result = room.delete(token, text_arg(data, "id"))
        elif op == "/api/react":
            result = room.react(token, text_arg(data, "id"), text_arg(data, "key"))
        elif op == "/api/leave":
            result = room.leave(token)
        else:
            raise ApiError(404, "찾을 수 없습니다.")
        self._json(200, result)


def main():
    password = os.environ.get("CHAT_PASSWORD") or secrets.token_urlsafe(9)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.room = Room(password)
    print(f"http://{host}:{port}/", flush=True)
    if "CHAT_PASSWORD" not in os.environ:
        print(f"password: {password}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
