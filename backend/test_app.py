import csv
import importlib
import io
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture
def client(tmp_path):
    """Fresh app + empty tables. Uses Postgres when DATABASE_URL is set, else a temp SQLite file."""
    if not os.environ.get("DATABASE_URL"):
        os.environ["DATABASE_PATH"] = str(tmp_path / "test.db")
    os.environ["ADMIN_TOKEN"] = "secret"
    os.environ["SECRET_KEY"] = "test-secret-key"
    import app as app_module
    importlib.reload(app_module)
    app_module.app.testing = True
    app_module.app.config["RATELIMIT_ENABLED"] = False
    conn = app_module.database.Database()
    conn.execute("DELETE FROM bookings")
    conn.execute("DELETE FROM messages")
    conn.execute("DELETE FROM subscribers")
    conn.commit()
    conn.close()
    c = app_module.app.test_client()
    c.app_module = app_module
    return c


def stay(days_from_now=10, nights=2, room="deluxe", guests=2, **extra):
    checkin = date.today() + timedelta(days=days_from_now)
    return {"room": room, "guests": guests, "checkin": checkin.isoformat(),
            "checkout": (checkin + timedelta(days=nights)).isoformat(), **extra}


GUEST = {"name": "Test Guest", "email": "Guest@Example.com", "phone": "+91 90000 00000"}


def test_rooms_and_health(client):
    assert client.get("/api/health").json == {"status": "ok", "database": client.app_module.database.kind()}
    rooms = client.get("/api/rooms").json
    assert [r["slug"] for r in rooms] == ["deluxe", "premier", "executive", "presidential"]


def test_quote_prices_with_tax(client):
    q = client.post("/api/availability", json=stay(nights=3)).json
    assert q["nights"] == 3 and q["subtotal"] == 3 * 6500
    assert q["taxes"] == round(3 * 6500 * 0.18) and q["total"] == q["subtotal"] + q["taxes"]
    assert q["available"] is True


@pytest.mark.parametrize("payload, message", [
    (stay(days_from_now=-1), "past"),
    (stay(nights=0), "at least one day"),
    (stay(nights=31), "limited to 30"),
    (stay(room="deluxe", guests=3), "sleeps up to 2"),
    (stay(room="penthouse"), "Unknown room"),
])
def test_quote_validation(client, payload, message):
    resp = client.post("/api/availability", json=payload)
    assert resp.status_code in (400, 404) and message in resp.json["error"]


def test_booking_lifecycle(client):
    resp = client.post("/api/bookings", json=stay(**GUEST))
    assert resp.status_code == 201
    booking = resp.json
    assert booking["ref"].startswith("LS-") and booking["email"] == "guest@example.com"

    found = client.get(f"/api/bookings/{booking['ref']}?email=GUEST@example.com").json
    assert found["ref"] == booking["ref"] and found["status"] == "confirmed"
    assert client.get(f"/api/bookings/{booking['ref']}?email=other@example.com").status_code == 404

    cancelled = client.post(f"/api/bookings/{booking['ref']}/cancel", json={"email": "guest@example.com"}).json
    assert cancelled["status"] == "cancelled"
    assert client.post(f"/api/bookings/{booking['ref']}/cancel", json={"email": "guest@example.com"}).status_code == 409


def test_last_room_cannot_be_double_booked(client):
    first = client.post("/api/bookings", json=stay(room="presidential", **GUEST))
    assert first.status_code == 201
    # Overlapping stay in the only presidential suite is refused...
    overlap = client.post("/api/bookings", json=stay(days_from_now=11, room="presidential", **GUEST))
    assert overlap.status_code == 409
    # ...but a stay starting on the first one's checkout day is fine.
    after = client.post("/api/bookings", json=stay(days_from_now=12, room="presidential", **GUEST))
    assert after.status_code == 201
    # Cancelling frees the room again.
    client.post(f"/api/bookings/{first.json['ref']}/cancel", json={"email": GUEST["email"]})
    assert client.post("/api/availability", json=stay(room="presidential")).json["available"] is True


def test_booking_requires_valid_guest(client):
    assert "valid email" in client.post("/api/bookings", json=stay(name="Al", email="nope")).json["error"]
    assert "Name" in client.post("/api/bookings", json=stay(email="a@b.co")).json["error"]


def test_contact_subscribe_and_admin(client):
    assert client.post("/api/contact", json={"name": "A", "email": "a@b.co", "message": "short"}).status_code == 400
    assert client.post("/api/contact", json={"name": "Ann", "email": "a@b.co", "subject": "Spa",
                                              "message": "Do you have couples massages?"}).status_code == 201
    assert client.post("/api/subscribe", json={"email": "a@b.co"}).json["already_subscribed"] is False
    assert client.post("/api/subscribe", json={"email": "A@b.co"}).json["already_subscribed"] is True
    client.post("/api/bookings", json=stay(**GUEST))

    login(client)
    page = client.get("/admin").get_data(as_text=True)
    assert "couples massages" in page and "a@b.co" in page and "Test Guest" in page


def test_serves_site_and_cors(client):
    assert b"Luxury" in client.get("/").data
    resp = client.get("/api/health", headers={"Origin": "https://rounak251.github.io"})
    assert resp.headers["Access-Control-Allow-Origin"] == "https://rounak251.github.io"
    assert "Access-Control-Allow-Origin" not in client.get("/api/health", headers={"Origin": "https://evil.example"}).headers


def test_site_and_3d_scripts_are_served(client):
    assert b"heroCanvas" in client.get("/").data
    for name in ("hero3d.js", "suite3d.js", "resort3d.js"):
        resp = client.get(f"/js/{name}")
        assert resp.status_code == 200 and b"three" in resp.data
    assert client.get("/js/../backend/app.py").status_code == 404


# ---------- helpers ----------

def login(client, password="secret"):
    return client.post("/admin/login", data={"password": password})


def csrf_of(client):
    with client.session_transaction() as sess:
        return sess["csrf"]


def book(client, **kw):
    resp = client.post("/api/bookings", json=stay(**{**GUEST, **kw}))
    assert resp.status_code == 201, resp.json
    return resp.json


# ---------- calendar ----------

def test_calendar_shape_and_counts(client):
    start = date.today() + timedelta(days=10)
    book(client, room="presidential", days_from_now=10, nights=2)
    book(client, room="deluxe", days_from_now=11, nights=2)
    book(client, room="deluxe", days_from_now=11, nights=1)
    cal = client.get(f"/api/rooms/presidential/calendar?start={start.isoformat()}&days=4").json
    assert cal == {"room": "presidential", "name": "Presidential Suite", "inventory": 1, "price": 28000,
                   "days": [{"date": (start + timedelta(days=i)).isoformat(), "rooms_left": left}
                            for i, left in enumerate([0, 0, 1, 1])]}
    deluxe = client.get(f"/api/rooms/deluxe/calendar?start={start.isoformat()}&days=4").json
    assert [d["rooms_left"] for d in deluxe["days"]] == [40, 38, 39, 40]
    assert deluxe["inventory"] == 40 and deluxe["price"] == 6500


def test_calendar_ignores_cancelled_and_uses_defaults(client):
    ref = book(client, days_from_now=1, nights=1, room="presidential")["ref"]
    cal = client.get("/api/rooms/presidential/calendar").json
    assert len(cal["days"]) == 14 and cal["days"][0]["date"] == date.today().isoformat()
    assert cal["days"][1]["rooms_left"] == 0
    client.post(f"/api/bookings/{ref}/cancel", json={"email": GUEST["email"]})
    assert client.get("/api/rooms/presidential/calendar").json["days"][1]["rooms_left"] == 1


@pytest.mark.parametrize("query, status", [
    ("days=91", 400), ("days=0", 400), ("days=x", 400), ("start=2020-01-01", 400), ("start=nope", 400),
])
def test_calendar_validation(client, query, status):
    assert client.get(f"/api/rooms/deluxe/calendar?{query}").status_code == status
    assert client.get("/api/rooms/penthouse/calendar").status_code == 404
    assert len(client.get("/api/rooms/deluxe/calendar?days=90").json["days"]) == 90


# ---------- admin ----------

def test_admin_requires_login(client):
    resp = client.get("/admin")
    assert resp.status_code == 302 and "/admin/login" in resp.headers["Location"]
    assert client.get("/admin?token=secret").status_code == 302  # old query-string auth is gone
    assert client.get("/admin/bookings.csv").status_code == 401
    assert b"password" in client.get("/admin/login").data
    assert login(client, "wrong").status_code == 401
    assert login(client).status_code == 303
    page = client.get("/admin").get_data(as_text=True)
    assert "Occupancy, next 14 nights" in page and "Revenue by room type" in page


def test_admin_cookie_flags(client):
    cookie = login(client).headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie and "Secure" not in cookie
    client.app_module.app.testing = False  # production behaviour
    cookie = login(client).headers["Set-Cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie


def test_admin_logout_and_csrf(client):
    login(client)
    token = csrf_of(client)
    assert client.post("/admin/logout").status_code == 403
    assert client.post("/admin/logout", data={"csrf_token": "bad"}).status_code == 403
    assert client.get("/admin").status_code == 200  # still signed in
    assert client.post("/admin/logout", data={"csrf_token": token}).status_code == 303
    assert client.get("/admin").status_code == 302


def test_admin_cancel_booking(client):
    ref = book(client)["ref"]
    # not logged in
    assert client.post(f"/admin/bookings/{ref}/cancel", data={"csrf_token": "x"}).status_code == 403
    login(client)
    page = client.get("/admin").get_data(as_text=True)
    assert f"/admin/bookings/{ref}/cancel" in page and 'name="csrf_token"' in page
    assert client.post(f"/admin/bookings/{ref}/cancel").status_code == 403  # missing CSRF
    assert client.post(f"/admin/bookings/{ref}/cancel", data={"csrf_token": csrf_of(client)}).status_code == 303
    assert client.get(f"/api/bookings/{ref}?email={GUEST['email']}").json["status"] == "cancelled"
    assert f"/admin/bookings/{ref}/cancel" not in client.get("/admin").get_data(as_text=True)


def test_admin_csv_export(client):
    book(client, name="=cmd|calc", room="executive")
    login(client)
    resp = client.get("/admin/bookings.csv")
    assert resp.mimetype == "text/csv" and "attachment" in resp.headers["Content-Disposition"]
    rows = list(csv.reader(io.StringIO(resp.get_data(as_text=True))))
    assert rows[0][:3] == ["ref", "room_slug", "room_name"]
    assert rows[1][1] == "executive" and rows[1][3] == "'=cmd|calc"


def test_admin_login_throttle(client):
    for _ in range(5):
        assert login(client, "nope").status_code == 401
    blocked = login(client, "secret")
    assert blocked.status_code == 429 and "Retry-After" in blocked.headers


def test_dashboard_numbers(client):
    book(client, room="presidential", days_from_now=2, nights=3)
    login(client)
    page = client.get("/admin").get_data(as_text=True)
    assert "3 of 14 room-nights" in page and "21% " in page
    assert "₹99,120" in page  # 3 nights * 28000 + 18% tax


# ---------- rate limiting, headers, request id, health, docs ----------

def test_rate_limit_triggers(client):
    client.app_module.app.config["RATELIMIT_ENABLED"] = True
    payload = {"name": "A", "email": "a@b.co", "message": "short"}
    codes = [client.post("/api/contact", json=payload).status_code for _ in range(6)]
    assert codes == [400] * 5 + [429]
    resp = client.post("/api/contact", json=payload)
    assert resp.json["error"] and int(resp.headers["Retry-After"]) >= 1
    assert client.post("/api/subscribe", json={"email": "a@b.co"}).status_code == 201  # separate bucket
    # a different client IP (as set by the proxy) has its own budget
    other = client.post("/api/contact", json=payload, headers={"X-Forwarded-For": "9.9.9.9"})
    assert other.status_code == 400


def test_rate_limit_off_by_default_in_tests(client):
    assert all(client.post("/api/contact", json={}).status_code == 400 for _ in range(8))


def test_security_headers(client):
    for path in ("/api/health", "/admin/login", "/"):
        h = client.get(path).headers
        assert h["X-Content-Type-Options"] == "nosniff"
        assert h["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in h["Permissions-Policy"]
    assert client.get("/api/health").headers["X-Frame-Options"] == "DENY"
    assert client.get("/admin").headers["X-Frame-Options"] == "DENY"
    assert "X-Frame-Options" not in client.get("/").headers
    assert "Content-Security-Policy" not in client.get("/").headers


def test_request_id(client, caplog):
    assert len(client.get("/api/health").headers["X-Request-ID"]) >= 8
    assert client.get("/api/health", headers={"X-Request-ID": "abc-123"}).headers["X-Request-ID"] == "abc-123"
    bad = client.get("/api/health", headers={"X-Request-ID": "bad id\"<x>"}).headers["X-Request-ID"]
    assert bad != "bad id\"<x>" and re.fullmatch(r"[0-9a-f]{16}", bad)
    with caplog.at_level("INFO", logger="luxury_stays"):
        client.get("/api/rooms", headers={"X-Request-ID": "log-me"})
    assert any("GET /api/rooms 200" in r.getMessage() and "rid=log-me" in r.getMessage() for r in caplog.records)


def test_health_degraded_when_db_fails(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(client.app_module.database.Database, "execute", boom)
    resp = client.get("/api/health")
    assert resp.status_code == 503 and resp.json["status"] == "degraded"


def test_openapi_and_docs(client):
    spec = client.get("/api/openapi.json").json
    assert spec["openapi"].startswith("3.0")
    expected = {("/api/health", "get"), ("/api/rooms", "get"), ("/api/rooms/{slug}/calendar", "get"),
                ("/api/availability", "post"), ("/api/bookings", "post"), ("/api/bookings/{ref}", "get"),
                ("/api/bookings/{ref}/cancel", "post"), ("/api/contact", "post"), ("/api/subscribe", "post")}
    assert {(p, m) for p, ops in spec["paths"].items() for m in ops} == expected

    def refs(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "$ref":
                    yield v
                yield from refs(v)
        elif isinstance(node, list):
            for v in node:
                yield from refs(v)
    assert all(r.split("/")[-1] in spec["components"]["schemas"] for r in refs(spec))
    docs = client.get("/api/docs").get_data(as_text=True)
    assert "swagger-ui-dist@5" in docs and "/api/openapi.json" in docs


def test_database_url_normalised(monkeypatch):
    from db import database_url
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@host/db")
    assert database_url() == "postgresql://u:p@host/db"
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@host/db")
    assert database_url() == "postgresql://u:p@host/db"
    monkeypatch.delenv("DATABASE_URL")
    assert database_url() is None


def test_concurrent_bookings_do_not_oversell(client):
    import threading
    results = []

    def go():
        c = client.application.test_client()
        results.append(c.post("/api/bookings", json=stay(room="presidential", **GUEST)).status_code)
    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results).count(201) == 1 and set(results) <= {201, 409}
