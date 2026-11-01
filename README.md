# Luxury Stays: Hotel Booking Website

**Live demo (front end):** https://rounak251.github.io/hotelweb/

A full-stack hotel website with interactive 3D scenes and a production-style booking backend. The front end is an animated, scroll-driven landing page built with Three.js. The backend is a Flask API with Postgres, real availability checks, double-booking protection, an admin dashboard, rate limiting, OpenAPI docs, Docker, CI and a one-click Render deployment.

📐 **[System design →](docs/SYSTEM_DESIGN.md)**: architecture, data model, booking concurrency, security, deployment and scaling plan.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rounak251/hotelweb)

## Features

**Interactive 3D** (Three.js r170 from a CDN, no build step)
- **Resort map** (`js/resort3d.js`): a 3D island you can fly around. It has seven places: an arrival jetty, the lodge, an infinity pool, a spa, a beach club, overwater villas and a lighthouse bar. Click a place, or its pin, and the camera swoops to it and the panel shows details with a call to action. A **time-of-day slider** runs from sunrise to midnight, and the sky, shadows, water, window lights, path lamps, stars and lighthouse beam follow it. There is also a **guided tour**, a shuttle boat leaving a wake, and drifting clouds that cast shadows
- **Hero** (`js/hero3d.js`): a real-time sunset ocean with the resort on an island. Scrolling flies the camera across the water; clicking the sea releases a lantern
- **Room tour** (`js/suite3d.js`): a cut-away model of each room type that you can orbit and zoom, with a day/night switch
- **Live availability:** the room tour shows the next 14 nights from the API. Pick a night and the booking bar fills in
- A gallery shown as a 3D photo ring, and cards that tilt towards the pointer
- Without WebGL 2 the page keeps its photos. Scenes load only when they are about to scroll into view, pause off screen, and stay still with `prefers-reduced-motion`

**Motion and feel**
- Preloader with a counter and a curtain reveal, a custom cursor with context labels (Drag, Visit, Lantern), and magnetic buttons
- Smooth scrolling with [Lenis](https://github.com/darkroomengineering/lenis); the hero and rooms pin while you scroll, experience cards stack, headings reveal word by word, a marquee runs, and a reading-progress bar tracks the page

**Booking**
- Booking bar with date validation, then a price quote (nights × rate + 18% GST), guest details and a confirmation with a booking reference
- "My Booking" lookup by reference and email, with cancellation
- Contact form and newsletter sign-up
- Without a backend it runs in **demo mode**: prices are worked out in the browser and nothing is saved. When the backend is asleep on a free tier, the page keeps retrying and switches to live mode once it wakes

**Backend** (`backend/`: Flask, SQLite locally, Postgres in production)
| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness and database check |
| `GET /api/rooms` | Room types, prices and capacity |
| `GET /api/rooms/<slug>/calendar` | Rooms left per night (up to 90 days) |
| `POST /api/availability` | Validates dates and guests, prices the stay, counts rooms left |
| `POST /api/bookings` | Creates a booking; re-checks availability under a per-room-type lock so the last room can't be double-booked |
| `GET /api/bookings/<ref>?email=` | Booking lookup |
| `POST /api/bookings/<ref>/cancel` | Cancels a booking and frees the room |
| `POST /api/contact`, `POST /api/subscribe` | Contact messages and newsletter |
| `GET /api/docs` | Swagger UI for the OpenAPI 3 spec (`/api/openapi.json`) |
| `/admin` | Staff dashboard: password login with a signed session cookie, occupancy and revenue charts, cancel with CSRF protection, CSV export |

Also included:
- Per-IP rate limiting and a login lockout
- Security headers and a CORS allowlist
- A request id on every response, with one log line per request
- 35 tests, run in CI against both SQLite and Postgres, including a concurrent-booking test that checks the API never oversells

## Run locally

Quick start (SQLite):
```bash
pip install -r backend/requirements.txt
python backend/app.py
```
Open http://localhost:5000. The footer shows **"Live booking system"** when the backend is connected. The admin dashboard is at http://localhost:5000/admin; the password is `ADMIN_TOKEN`, which defaults to `change-me`.

Production-like (Docker + Postgres):
```bash
docker compose up --build
```
Open http://localhost:8000. The admin password is `dev-admin-password`.

Tests:
```bash
pip install pytest && python -m pytest backend
DATABASE_URL=postgres://user:pass@localhost:5432/db python -m pytest backend   # against Postgres
```

## Deploy

1. Click **Deploy to Render** above, or create a **Blueprint** from this repo in Render. `render.yaml` creates the web service and a Postgres database, generates `ADMIN_TOKEN` and `SECRET_KEY`, and health-checks deploys.
2. Set `BACKEND_URL` in `index.html` to your Render URL (e.g. `https://luxury-stays.onrender.com`) and push. The GitHub Pages site will then take live bookings.

The image in `Dockerfile` also runs on Fly.io, Railway, Cloud Run or a VPS. Every push runs CI in `.github/workflows/ci.yml`: tests on SQLite and Postgres, plus a Docker build. All configuration is through environment variables; see the [system design](docs/SYSTEM_DESIGN.md#9-deployment) for the full list.

Render's free web service sleeps when idle, and its free Postgres expires after 30 days. Use paid plans for real traffic.

## Tech stack
HTML5 · CSS3 (grid, custom properties, 3D transforms) · vanilla JavaScript · Three.js (WebGL 2, custom GLSL shaders) · Lenis · Python · Flask · gunicorn · PostgreSQL · SQLite · psycopg 3 · pytest · Docker · GitHub Actions · Render

Photos from [Unsplash](https://unsplash.com). 3D built with [three.js](https://threejs.org) (MIT); smooth scrolling by [Lenis](https://github.com/darkroomengineering/lenis) (MIT). Luxury Stays is a fictional hotel; this is a portfolio project.
