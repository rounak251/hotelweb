"""Luxury Stays booking API (Flask + SQLite).

Serves the website at / and a JSON API under /api:
    GET  /api/health                      liveness check
    GET  /api/rooms                       room types, prices and capacity
    POST /api/availability                quote + availability for dates/room/guests
    POST /api/bookings                    create a booking (re-checks availability)
    GET  /api/bookings/<ref>?email=...    look up a booking
    POST /api/bookings/<ref>/cancel       cancel a booking (email must match)
    POST /api/contact                     store a contact-form message
    POST /api/subscribe                   newsletter sign-up
    GET  /admin?token=...                 bookings, messages and subscribers

Run locally:  python backend/app.py   ->  http://localhost:5000
"""
import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

from flask import Flask, abort, g, jsonify, render_template_string, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DATABASE_PATH", Path(__file__).resolve().parent / "hotel.db"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "change-me")
CORS_ORIGINS = {o.strip() for o in os.environ.get("CORS_ORIGINS", "https://rounak251.github.io").split(",") if o.strip()}
TAX_RATE = 0.18
MAX_NIGHTS = 30
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# slug, name, price per night (INR), max guests, rooms of this type
ROOMS = [
    ("deluxe", "Deluxe Room", 6500, 2, 40),
    ("premier", "Premier Room", 8900, 3, 30),
    ("executive", "Executive Suite", 14500, 4, 12),
    ("presidential", "Presidential Suite", 28000, 4, 1),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    max_guests INTEGER NOT NULL, inventory INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    room_slug TEXT NOT NULL REFERENCES rooms(slug),
    guest_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
    checkin TEXT NOT NULL, checkout TEXT NOT NULL, guests INTEGER NOT NULL,
    nights INTEGER NOT NULL, total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_room_dates ON bookings(room_slug, checkin, checkout);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
    subject TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscribers (
    email TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
"""

app = Flask(__name__)


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=err.message), err.status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)
        db.executemany(
            "INSERT INTO rooms (slug, name, price, max_guests, inventory) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, price=excluded.price, "
            "max_guests=excluded.max_guests, inventory=excluded.inventory",
            ROOMS,
        )


@app.after_request
def add_cors(resp):
    origin = request.headers.get("Origin")
    if origin and (origin in CORS_ORIGINS or "*" in CORS_ORIGINS):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    return resp


@app.before_request
def preflight():
    if request.method == "OPTIONS":
        return "", 204


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
        "SELECT COUNT(*) FROM bookings WHERE room_slug = ? AND status = 'confirmed' "
        "AND checkin < ? AND checkout > ?",
        (room["slug"], checkout.isoformat(), checkin.isoformat()),
    ).fetchone()[0]
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
    return jsonify(status="ok")


@app.get("/api/rooms")
def rooms():
    rows = get_db().execute("SELECT slug, name, price, max_guests FROM rooms ORDER BY price").fetchall()
    return jsonify([dict(r) for r in rows])


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
    # BEGIN IMMEDIATE takes the write lock before the availability check, so two
    # simultaneous requests can't both grab the last room.
    db.execute("BEGIN IMMEDIATE")
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
    cur = db.execute("INSERT OR IGNORE INTO subscribers (email, created_at) VALUES (?, ?)", (email, now()))
    db.commit()
    return jsonify(ok=True, already_subscribed=cur.rowcount == 0), 201


# ---------- admin dashboard ----------

ADMIN_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luxury Stays Admin</title><style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#faf7f2;color:#1c1a17}
h1{font-weight:600}h2{margin-top:36px}.cards{display:flex;gap:14px;flex-wrap:wrap}
.card{background:#fff;padding:16px 22px;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.card b{display:block;font-size:1.6rem;color:#8f6f3e}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;font-size:.9rem}
th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}th{background:#1c1a17;color:#fff}
.cancelled{color:#b3402e}.confirmed{color:#2e7d4f}</style></head><body>
<h1>Luxury Stays · Admin</h1>
<div class="cards"><div class="card"><b>{{ stats.active }}</b>Active bookings</div>
<div class="card"><b>₹{{ "{:,}".format(stats.revenue) }}</b>Booked revenue</div>
<div class="card"><b>{{ messages|length }}</b>Messages</div><div class="card"><b>{{ subscribers|length }}</b>Subscribers</div></div>
<h2>Bookings</h2><div class="wrap"><table><tr><th>Ref</th><th>Room</th><th>Guest</th><th>Email</th><th>Check-in</th><th>Check-out</th><th>Guests</th><th>Total</th><th>Status</th><th>Created</th></tr>
{% for b in bookings %}<tr><td>{{ b.ref }}</td><td>{{ b.room_name }}</td><td>{{ b.guest_name }}</td><td>{{ b.email }}</td><td>{{ b.checkin }}</td><td>{{ b.checkout }}</td><td>{{ b.guests }}</td><td>₹{{ "{:,}".format(b.total) }}</td><td class="{{ b.status }}">{{ b.status }}</td><td>{{ b.created_at[:16] }}</td></tr>
{% else %}<tr><td colspan="10">No bookings yet.</td></tr>{% endfor %}</table></div>
<h2>Messages</h2><div class="wrap"><table><tr><th>From</th><th>Email</th><th>Subject</th><th>Message</th><th>Received</th></tr>
{% for m in messages %}<tr><td>{{ m.name }}</td><td>{{ m.email }}</td><td>{{ m.subject }}</td><td style="white-space:normal">{{ m.message }}</td><td>{{ m.created_at[:16] }}</td></tr>
{% else %}<tr><td colspan="5">No messages yet.</td></tr>{% endfor %}</table></div>
<h2>Subscribers</h2><div class="wrap"><table><tr><th>Email</th><th>Since</th></tr>
{% for s in subscribers %}<tr><td>{{ s.email }}</td><td>{{ s.created_at[:10] }}</td></tr>{% else %}<tr><td colspan="2">No subscribers yet.</td></tr>{% endfor %}</table></div>
</body></html>"""


@app.get("/admin")
def admin():
    if not secrets.compare_digest(request.args.get("token", ""), ADMIN_TOKEN):
        abort(401)
    db = get_db()
    bookings = db.execute("SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.slug = b.room_slug "
                          "ORDER BY b.created_at DESC").fetchall()
    stats = db.execute("SELECT COUNT(*) AS active, COALESCE(SUM(total), 0) AS revenue FROM bookings "
                       "WHERE status = 'confirmed'").fetchone()
    return render_template_string(
        ADMIN_HTML, bookings=bookings, stats=stats,
        messages=db.execute("SELECT * FROM messages ORDER BY created_at DESC").fetchall(),
        subscribers=db.execute("SELECT * FROM subscribers ORDER BY created_at DESC").fetchall(),
    )


# ---------- website ----------

@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
