import importlib
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture
def client(tmp_path):
    os.environ["DATABASE_PATH"] = str(tmp_path / "test.db")
    os.environ["ADMIN_TOKEN"] = "secret"
    import app as app_module
    importlib.reload(app_module)
    app_module.app.testing = True
    return app_module.app.test_client()


def stay(days_from_now=10, nights=2, room="deluxe", guests=2, **extra):
    checkin = date.today() + timedelta(days=days_from_now)
    return {"room": room, "guests": guests, "checkin": checkin.isoformat(),
            "checkout": (checkin + timedelta(days=nights)).isoformat(), **extra}


GUEST = {"name": "Test Guest", "email": "Guest@Example.com", "phone": "+91 90000 00000"}


def test_rooms_and_health(client):
    assert client.get("/api/health").json == {"status": "ok"}
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

    assert client.get("/admin?token=wrong").status_code == 401
    page = client.get("/admin?token=secret").get_data(as_text=True)
    assert "couples massages" in page and "a@b.co" in page and "Test Guest" in page


def test_serves_site_and_cors(client):
    assert b"Luxury" in client.get("/").data
    resp = client.get("/api/health", headers={"Origin": "https://rounak251.github.io"})
    assert resp.headers["Access-Control-Allow-Origin"] == "https://rounak251.github.io"
    assert "Access-Control-Allow-Origin" not in client.get("/api/health", headers={"Origin": "https://evil.example"}).headers
