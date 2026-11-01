"""Luxury Stays booking API (Flask + SQLite or Postgres).

Serves the website at / and a JSON API under /api:
    GET  /api/health                      liveness + database check
    GET  /api/rooms                       room types, prices and capacity
    GET  /api/rooms/<slug>/calendar       rooms left per night (?start=&days=)
    POST /api/availability                quote + availability for dates/room/guests
    POST /api/bookings                    create a booking (re-checks availability)
    GET  /api/bookings/<ref>?email=...    look up a booking
    POST /api/bookings/<ref>/cancel       cancel a booking (email must match)
    POST /api/contact                     store a contact-form message
    POST /api/subscribe                   newsletter sign-up
    GET  /api/openapi.json, /api/docs     OpenAPI spec and Swagger UI
    /admin                                login, dashboard, cancel, CSV export (see admin.py)

Environment: DATABASE_URL (Postgres) or DATABASE_PATH (SQLite), ADMIN_TOKEN (admin password),
SECRET_KEY (session signing), CORS_ORIGINS, RATELIMIT_ENABLED, SESSION_COOKIE_SECURE.

Run locally:  python backend/app.py   ->  http://localhost:5000
"""
import logging
import os
import re
import secrets
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory
from flask.sessions import SecureCookieSessionInterface
from werkzeug.middleware.proxy_fix import ProxyFix

import admin
import db as database
import openapi
import security
from db import get_db

ROOT = Path(__file__).resolve().parent.parent
CORS_ORIGINS = {o.strip() for o in os.environ.get("CORS_ORIGINS", "https://rounak251.github.io").split(",") if o.strip()}
TAX_RATE = 0.18
MAX_NIGHTS = 30
MAX_CALENDAR_DAYS = 90
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# slug, name, price per night (INR), max guests, rooms of this type
ROOMS = [
    ("deluxe", "Deluxe Room", 6500, 2, 40),
    ("premier", "Premier Room", 8900, 3, 30),
    ("executive", "Executive Suite", 14500, 4, 12),
    ("presidential", "Presidential Suite", 28000, 4, 1),
]

# endpoint -> (max POSTs, per seconds) for each client IP
RATE_LIMITS = {
    "create_booking": (10, 60), "availability": (60, 60), "cancel_booking": (10, 60),
    "contact": (5, 60), "subscribe": (5, 60), "admin.login": (5, 60),
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("luxury_stays")


class CookieInterface(SecureCookieSessionInterface):
    def get_cookie_secure(self, app):
        """Secure cookie everywhere except debug/testing (or SESSION_COOKIE_SECURE=0)."""
        if os.environ.get("SESSION_COOKIE_SECURE") == "0":
            return False
        return not (app.debug or app.testing)


app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)  # real client IP behind Render's proxy
app.session_interface = CookieInterface()
app.config.update(
    ADMIN_TOKEN=os.environ.get("ADMIN_TOKEN", "change-me"),
    SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    RATELIMIT_ENABLED=os.environ.get("RATELIMIT_ENABLED", "1") != "0",
)
if not os.environ.get("SECRET_KEY"):
    log.warning("SECRET_KEY is not set; using a random key. Admin sessions reset on restart "
                "and do not work across multiple workers. Set SECRET_KEY in production.")
if app.config["ADMIN_TOKEN"] == "change-me":
    log.warning("ADMIN_TOKEN is the default 'change-me'. Set ADMIN_TOKEN in production.")
limiter = security.RateLimiter()
app.extensions["login_throttle"] = security.LoginThrottle()
app.register_blueprint(admin.bp)
app.teardown_appcontext(database.close_db)


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=err.message), err.status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db():
    database.init_db(ROOMS)


@app.before_request
def start_request():
    """Tag the request, answer CORS preflights, and apply rate limits to POSTs."""
    g.t0 = time.perf_counter()
    incoming = request.headers.get("X-Request-ID", "")
    g.request_id = incoming if security.REQUEST_ID_RE.match(incoming) else secrets.token_hex(8)
    if request.method == "OPTIONS":
        return "", 204
    rule = RATE_LIMITS.get(request.endpoint)
    if rule and request.method == "POST" and app.config["RATELIMIT_ENABLED"]:
        wait = limiter.check(f"{request.remote_addr}:{request.endpoint}", *rule)
        if wait:
            resp = jsonify(error="Too many requests. Please slow down and try again shortly.")
            resp.status_code = 429
            resp.headers["Retry-After"] = str(wait)
            return resp


@app.after_request
def finish_request(resp):
    """CORS, security headers, request id and one access-log line."""
    origin = request.headers.get("Origin")
    if origin and (origin in CORS_ORIGINS or "*" in CORS_ORIGINS):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Expose-Headers"] = "Retry-After, X-Request-ID"
        resp.headers["Vary"] = "Origin"
    security.add_security_headers(resp, request.path)
    request_id = g.get("request_id", "-")
    resp.headers["X-Request-ID"] = request_id
    ms = (time.perf_counter() - g.t0) * 1000 if "t0" in g else 0
    log.info("%s %s %s %.1fms rid=%s", request.method, request.path, resp.status_code, ms, request_id)
    return resp


# ---------- validation helpers ----------

def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Request body must be JSON.")
    return data


def text(data, key, label, min_len=1, max_len=200, required=True):
    value = str(data.get(key) or "").strip()
    if required and len(value) < min_len:
        raise ApiError(f"{label} is required." if min_len == 1 else f"{label} must be at least {min_len} characters.")
    if len(value) > max_len:
        raise ApiError(f"{label} must be at most {max_len} characters.")
    return value


def email_of(data):
    value = text(data, "email", "Email", max_len=254).lower()
    if not EMAIL_RE.match(value):
        raise ApiError("Please enter a valid email address.")
    return value


def parse_date(value, label):
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ApiError(f"{label} must be a date in YYYY-MM-DD format.")


def get_room(slug):
    room = get_db().execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
    if room is None:
        raise ApiError("Unknown room type.", 404)
    return room


def quote(data):
    """Validate a stay request and price it. Returns (room, checkin, checkout, guests, quote dict)."""
    room = get_room(str(data.get("room", "")))
    checkin = parse_date(data.get("checkin"), "Check-in")
    checkout = parse_date(data.get("checkout"), "Check-out")
    if checkin < date.today():
        raise ApiError("Check-in can't be in the past.")
    nights = (checkout - checkin).days
    if nights < 1:
        raise ApiError("Check-out must be at least one day after check-in.")
    if nights > MAX_NIGHTS:
        raise ApiError(f"Online bookings are limited to {MAX_NIGHTS} nights. Please contact us for longer stays.")
    try:
        guests = int(data.get("guests", 1))
    except (TypeError, ValueError):
        raise ApiError("Guests must be a number.")
    if guests < 1:
        raise ApiError("At least one guest is required.")
    if guests > room["max_guests"]:
        raise ApiError(f"The {room['name']} sleeps up to {room['max_guests']} guests. Try a larger room.")

    booked = get_db().execute(
        "SELECT COUNT(*) AS n FROM bookings WHERE room_slug = ? AND status = 'confirmed' "
        "AND checkin < ? AND checkout > ?",
        (room["slug"], checkout.isoformat(), checkin.isoformat()),
    ).fetchone()["n"]
    subtotal = nights * room["price"]
    taxes = round(subtotal * TAX_RATE)
    return room, checkin, checkout, guests, {
        "room": room["slug"], "room_name": room["name"],
        "checkin": checkin.isoformat(), "checkout": checkout.isoformat(),
        "guests": guests, "nights": nights, "price_per_night": room["price"],
        "subtotal": subtotal, "taxes": taxes, "total": subtotal + taxes,
        "rooms_left": max(room["inventory"] - booked, 0),
        "available": booked < room["inventory"],
    }


def booking_json(row):
    return {k: row[k] for k in ("ref", "room_slug", "guest_name", "email", "phone", "checkin",
                                "checkout", "guests", "nights", "total", "status", "created_at")}


# ---------- API ----------

@app.get("/api/health")
def health():
    kind = database.kind()
    try:
        get_db().execute("SELECT 1").fetchone()
    except Exception:
        log.exception("health check: database unreachable")
        return jsonify(status="degraded", database=kind), 503
    return jsonify(status="ok", database=kind)


@app.get("/api/rooms")
def rooms():
    rows = get_db().execute("SELECT slug, name, price, max_guests FROM rooms ORDER BY price").fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/rooms/<slug>/calendar")
def room_calendar(slug):
    room = get_room(slug)
    start = parse_date(request.args.get("start") or date.today(), "Start")
    if start < date.today():
        raise ApiError("Start can't be in the past.")
    try:
        days = int(request.args.get("days", 14))
    except ValueError:
        raise ApiError("Days must be a number.")
    if not 1 <= days <= MAX_CALENDAR_DAYS:
        raise ApiError(f"Days must be between 1 and {MAX_CALENDAR_DAYS}.")
    end = start + timedelta(days=days)
    rows = get_db().execute(
        "SELECT checkin, checkout FROM bookings WHERE room_slug = ? AND status = 'confirmed' "
        "AND checkin < ? AND checkout > ?", (slug, end.isoformat(), start.isoformat())).fetchall()
    booked = [0] * days
    for r in rows:
        first = max((date.fromisoformat(r["checkin"]) - start).days, 0)
        last = min((date.fromisoformat(r["checkout"]) - start).days, days)  # exclusive
        for i in range(first, last):
            booked[i] += 1
    return jsonify(room=room["slug"], name=room["name"], inventory=room["inventory"], price=room["price"],
                   days=[{"date": (start + timedelta(days=i)).isoformat(),
                          "rooms_left": max(room["inventory"] - booked[i], 0)} for i in range(days)])


@app.post("/api/availability")
def availability():
    return jsonify(quote(body())[4])


@app.post("/api/bookings")
def create_booking():
    data = body()
    name = text(data, "name", "Name", min_len=2, max_len=100)
    email = email_of(data)
    phone = text(data, "phone", "Phone", max_len=30, required=False)
    db = get_db()
    # Take the write lock (SQLite BEGIN IMMEDIATE / Postgres row lock on the room type)
    # before the availability check, so two simultaneous requests can't both grab the last room.
    db.begin_write(str(data.get("room", "")))
    try:
        room, checkin, checkout, guests, q = quote(data)
        if not q["available"]:
            raise ApiError(f"Sorry, the {room['name']} is fully booked for those dates.", 409)
        ref = "LS-" + secrets.token_hex(3).upper()
        db.execute(
            "INSERT INTO bookings (ref, room_slug, guest_name, email, phone, checkin, checkout, guests, nights, total, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ref, room["slug"], name, email, phone, q["checkin"], q["checkout"], guests, q["nights"], q["total"], now()),
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    row = db.execute("SELECT * FROM bookings WHERE ref = ?", (ref,)).fetchone()
    return jsonify(booking_json(row) | {"room_name": room["name"]}), 201


def find_booking(ref, email):
    row = get_db().execute(
        "SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.slug = b.room_slug "
        "WHERE b.ref = ? AND b.email = ?",
        (ref.upper(), email.strip().lower()),
    ).fetchone()
    if row is None:
        raise ApiError("No booking found with that reference and email.", 404)
    return row


@app.get("/api/bookings/<ref>")
def get_booking(ref):
    row = find_booking(ref, request.args.get("email", ""))
    return jsonify(booking_json(row) | {"room_name": row["room_name"]})


@app.post("/api/bookings/<ref>/cancel")
def cancel_booking(ref):
    row = find_booking(ref, str(body().get("email", "")))
    if row["status"] == "cancelled":
        raise ApiError("This booking is already cancelled.", 409)
    db = get_db()
    db.execute("UPDATE bookings SET status = 'cancelled' WHERE id = ?", (row["id"],))
    db.commit()
    return jsonify(booking_json(db.execute("SELECT * FROM bookings WHERE id = ?", (row["id"],)).fetchone())
                   | {"room_name": row["room_name"]})


@app.post("/api/contact")
def contact():
    data = body()
    values = (text(data, "name", "Name", max_len=100), email_of(data),
              text(data, "subject", "Subject", max_len=100, required=False),
              text(data, "message", "Message", min_len=10, max_len=3000), now())
    db = get_db()
    db.execute("INSERT INTO messages (name, email, subject, message, created_at) VALUES (?, ?, ?, ?, ?)", values)
    db.commit()
    return jsonify(ok=True), 201


@app.post("/api/subscribe")
def subscribe():
    email = email_of(body())
    db = get_db()
    cur = db.execute("INSERT INTO subscribers (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING",
                     (email, now()))
    db.commit()
    return jsonify(ok=True, already_subscribed=cur.rowcount == 0), 201


# ---------- API docs ----------

@app.get("/api/openapi.json")
def openapi_spec():
    return jsonify(openapi.build_spec())


@app.get("/api/docs")
def api_docs():
    return openapi.DOCS_HTML


# ---------- website ----------

@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/js/<path:name>")
def scripts(name):
    return send_from_directory(ROOT / "js", name)


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
