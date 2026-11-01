"""Admin dashboard: password login, signed session cookie, CSRF-protected actions."""
import csv
import io
import secrets
from datetime import date, timedelta

from flask import Blueprint, Response, abort, current_app, redirect, render_template_string, request, session, url_for

from db import get_db
from security import safe_equal

bp = Blueprint("admin", __name__)
OCCUPANCY_DAYS = 14

STYLE = """<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#faf7f2;color:#1c1a17}
h1{font-weight:600}h2{margin-top:36px}.cards{display:flex;gap:14px;flex-wrap:wrap}
.card{background:#fff;padding:16px 22px;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.card b{display:block;font-size:1.6rem;color:#8f6f3e}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;font-size:.9rem}
th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}th{background:#1c1a17;color:#fff}
.cancelled{color:#b3402e}.confirmed{color:#2e7d4f}
.bars{background:#fff;border-radius:12px;padding:8px 22px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.bar-row{display:flex;align-items:center;gap:14px;margin:12px 0}.bar-row span:first-child{width:170px}
.bar-row span:last-child{width:210px;text-align:right;font-size:.85rem}
.bar{flex:1;height:14px;background:#efe8da;border-radius:7px;overflow:hidden}.bar i{display:block;height:100%;background:#8f6f3e}
button{font:inherit;background:#8f6f3e;color:#fff;border:0;border-radius:8px;padding:6px 14px;cursor:pointer}
button.link{background:#1c1a17}button.danger{background:#b3402e;padding:4px 10px}
form.inline{display:inline;margin:0}a{color:#8f6f3e}.top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.login{max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.login input{width:100%;box-sizing:border-box;padding:10px;margin:10px 0 16px;border:1px solid #d9cfbd;border-radius:8px;font:inherit}
.error{color:#b3402e}
</style>"""

LOGIN_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luxury Stays Admin</title>""" + STYLE + """</head><body>
<form class="login" method="post" action="/admin/login"><h1>Admin sign-in</h1>
{% if error %}<p class="error">{{ error }}</p>{% endif %}
<label>Password<input type="password" name="password" autofocus required autocomplete="current-password"></label>
<button type="submit">Sign in</button></form></body></html>"""

ADMIN_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luxury Stays Admin</title>""" + STYLE + """</head><body>
<div class="top"><h1>Luxury Stays · Admin</h1><div>
<a href="/admin/bookings.csv">Export bookings (CSV)</a>
<form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="{{ csrf }}">
<button class="link" type="submit">Log out</button></form></div></div>
{% if flash %}<p>{{ flash }}</p>{% endif %}
<div class="cards"><div class="card"><b>{{ stats.active }}</b>Active bookings</div>
<div class="card"><b>₹{{ "{:,}".format(stats.revenue) }}</b>Booked revenue</div>
<div class="card"><b>{{ messages|length }}</b>Messages</div><div class="card"><b>{{ subscribers|length }}</b>Subscribers</div></div>
<h2>Occupancy, next {{ nights }} nights</h2><div class="bars">
{% for o in occupancy %}<div class="bar-row"><span>{{ o.name }}</span><div class="bar"><i style="width:{{ o.pct }}%"></i></div>
<span>{{ o.pct }}% · {{ o.sold }} of {{ o.capacity }} room-nights</span></div>{% endfor %}</div>
<h2>Revenue by room type</h2><div class="bars">
{% for r in revenue %}<div class="bar-row"><span>{{ r.name }}</span><div class="bar"><i style="width:{{ r.pct }}%"></i></div>
<span>₹{{ "{:,}".format(r.revenue) }} · {{ r.count }} booking{{ "" if r.count == 1 else "s" }}</span></div>{% endfor %}</div>
<h2>Bookings</h2><div class="wrap"><table><tr><th>Ref</th><th>Room</th><th>Guest</th><th>Email</th><th>Check-in</th><th>Check-out</th><th>Guests</th><th>Total</th><th>Status</th><th>Created</th><th></th></tr>
{% for b in bookings %}<tr><td>{{ b.ref }}</td><td>{{ b.room_name }}</td><td>{{ b.guest_name }}</td><td>{{ b.email }}</td><td>{{ b.checkin }}</td><td>{{ b.checkout }}</td><td>{{ b.guests }}</td><td>₹{{ "{:,}".format(b.total) }}</td><td class="{{ b.status }}">{{ b.status }}</td><td>{{ b.created_at[:16] }}</td>
<td>{% if b.status == "confirmed" %}<form class="inline" method="post" action="/admin/bookings/{{ b.ref }}/cancel" onsubmit="return confirm('Cancel {{ b.ref }}?')">
<input type="hidden" name="csrf_token" value="{{ csrf }}"><button class="danger" type="submit">Cancel</button></form>{% endif %}</td></tr>
{% else %}<tr><td colspan="11">No bookings yet.</td></tr>{% endfor %}</table></div>
<h2>Messages</h2><div class="wrap"><table><tr><th>From</th><th>Email</th><th>Subject</th><th>Message</th><th>Received</th></tr>
{% for m in messages %}<tr><td>{{ m.name }}</td><td>{{ m.email }}</td><td>{{ m.subject }}</td><td style="white-space:normal">{{ m.message }}</td><td>{{ m.created_at[:16] }}</td></tr>
{% else %}<tr><td colspan="5">No messages yet.</td></tr>{% endfor %}</table></div>
<h2>Subscribers</h2><div class="wrap"><table><tr><th>Email</th><th>Since</th></tr>
{% for s in subscribers %}<tr><td>{{ s.email }}</td><td>{{ s.created_at[:10] }}</td></tr>{% else %}<tr><td colspan="2">No subscribers yet.</td></tr>{% endfor %}</table></div>
</body></html>"""

BOOKING_SQL = ("SELECT b.*, r.name AS room_name FROM bookings b JOIN rooms r ON r.slug = b.room_slug "
               "ORDER BY b.created_at DESC")


def logged_in():
    return session.get("admin") is True


def check_csrf():
    """Reject the request unless the form carries this session's CSRF token."""
    if not logged_in() or not safe_equal(request.form.get("csrf_token", ""), session.get("csrf", "")):
        abort(403)


def occupancy(db):
    """Booked room-nights over the next 14 nights, per room type."""
    start = date.today()
    end = start + timedelta(days=OCCUPANCY_DAYS)
    sold = {}
    rows = db.execute("SELECT room_slug, checkin, checkout FROM bookings WHERE status = 'confirmed' "
                      "AND checkin < ? AND checkout > ?", (end.isoformat(), start.isoformat())).fetchall()
    for r in rows:
        lo = max(date.fromisoformat(r["checkin"]), start)
        hi = min(date.fromisoformat(r["checkout"]), end)
        sold[r["room_slug"]] = sold.get(r["room_slug"], 0) + (hi - lo).days
    out = []
    for room in db.execute("SELECT slug, name, inventory FROM rooms ORDER BY price").fetchall():
        capacity = room["inventory"] * OCCUPANCY_DAYS
        n = sold.get(room["slug"], 0)
        out.append({"name": room["name"], "sold": n, "capacity": capacity, "pct": round(100 * n / capacity)})
    return out


def revenue_by_room(db):
    rows = db.execute(
        "SELECT r.name AS name, COALESCE(SUM(b.total), 0) AS revenue, COUNT(b.id) AS count FROM rooms r "
        "LEFT JOIN bookings b ON b.room_slug = r.slug AND b.status = 'confirmed' "
        "GROUP BY r.slug, r.name, r.price ORDER BY r.price").fetchall()
    top = max([r["revenue"] for r in rows] + [1])
    return [dict(r, pct=round(100 * r["revenue"] / top)) for r in rows]


@bp.get("/admin")
def dashboard():
    if not logged_in():
        return redirect(url_for("admin.login"))
    db = get_db()
    stats = db.execute("SELECT COUNT(*) AS active, COALESCE(SUM(total), 0) AS revenue FROM bookings "
                       "WHERE status = 'confirmed'").fetchone()
    return render_template_string(
        ADMIN_HTML, bookings=db.execute(BOOKING_SQL).fetchall(), stats=stats, csrf=session["csrf"],
        occupancy=occupancy(db), revenue=revenue_by_room(db), nights=OCCUPANCY_DAYS,
        flash=session.pop("flash", None),
        messages=db.execute("SELECT * FROM messages ORDER BY created_at DESC").fetchall(),
        subscribers=db.execute("SELECT * FROM subscribers ORDER BY created_at DESC").fetchall(),
    )


@bp.route("/admin/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return redirect(url_for("admin.dashboard")) if logged_in() else render_template_string(LOGIN_HTML, error=None)
    throttle = current_app.extensions["login_throttle"]
    wait = throttle.blocked_for(request.remote_addr)
    if wait:
        resp = render_template_string(LOGIN_HTML, error=f"Too many failed attempts. Try again in {wait // 60 + 1} min.")
        return Response(resp, 429, {"Retry-After": str(wait)})
    if safe_equal(request.form.get("password", ""), current_app.config["ADMIN_TOKEN"]):
        throttle.succeeded(request.remote_addr)
        session.clear()
        session.permanent = True
        session["admin"] = True
        session["csrf"] = secrets.token_hex(16)
        return redirect(url_for("admin.dashboard"), 303)
    throttle.failed(request.remote_addr)
    return render_template_string(LOGIN_HTML, error="Incorrect password."), 401


@bp.post("/admin/logout")
def logout():
    check_csrf()
    session.clear()
    return redirect(url_for("admin.login"), 303)


@bp.post("/admin/bookings/<ref>/cancel")
def cancel(ref):
    check_csrf()
    db = get_db()
    cur = db.execute("UPDATE bookings SET status = 'cancelled' WHERE ref = ? AND status = 'confirmed'", (ref.upper(),))
    db.commit()
    session["flash"] = f"Booking {ref.upper()} cancelled." if cur.rowcount else f"{ref.upper()} was not an active booking."
    return redirect(url_for("admin.dashboard"), 303)


def csv_safe(value):
    """Stop spreadsheet apps from running guest-supplied text as a formula."""
    value = "" if value is None else str(value)
    return "'" + value if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


@bp.get("/admin/bookings.csv")
def bookings_csv():
    if not logged_in():
        abort(401)
    cols = ["ref", "room_slug", "room_name", "guest_name", "email", "phone", "checkin", "checkout",
            "guests", "nights", "total", "status", "created_at"]
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(cols)
    for row in get_db().execute(BOOKING_SQL).fetchall():
        writer.writerow([csv_safe(row[c]) for c in cols])
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=bookings.csv"})
