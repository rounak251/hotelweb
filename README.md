# Luxury Stays: Hotel Booking Website

**Live demo (front end):** https://rounak251.github.io/hotelweb/

A full-stack hotel website: a responsive, animated landing page plus a Flask + SQLite booking backend with real availability checks, booking management and an admin dashboard.

## Features

**Front end** (`index.html`, plain HTML/CSS/JS, no frameworks)
- Hero section, about, rooms and suites, amenities, experiences, gallery, reviews and contact sections
- Booking bar with date validation → price quote (nights × rate + 18% GST) → guest details → confirmation with a booking reference
- "My Booking" lookup by reference and email, with cancellation
- Gallery lightbox with keyboard navigation, scroll-reveal animations, animated counters
- Mobile slide-out menu, fully responsive layout, honours `prefers-reduced-motion`
- Contact form with inline validation, and newsletter sign-up
- Works without a server: on GitHub Pages it runs in **demo mode** (prices are calculated in the browser, nothing is saved)

**Backend** (`backend/app.py`, Flask + SQLite)
| Endpoint | Purpose |
|---|---|
| `GET /api/rooms` | Room types, prices and capacity |
| `POST /api/availability` | Validates dates and guests, prices the stay, counts rooms left |
| `POST /api/bookings` | Creates a booking; re-checks availability inside a write lock so the last room can't be double-booked |
| `GET /api/bookings/<ref>?email=` | Booking lookup |
| `POST /api/bookings/<ref>/cancel` | Cancels a booking and frees the room |
| `POST /api/contact` | Stores contact messages |
| `POST /api/subscribe` | Newsletter sign-up (no duplicates) |
| `GET /admin?token=…` | Dashboard of bookings, revenue, messages and subscribers |

## Run locally
```bash
pip install -r backend/requirements.txt
python backend/app.py
```
Open http://localhost:5000. The footer shows **"Live booking system"** when the backend is connected. The admin dashboard is at http://localhost:5000/admin?token=change-me; set the `ADMIN_TOKEN` environment variable to change the password.

Run the tests:
```bash
pip install pytest && python -m pytest backend
```

## Deploy the backend
1. On [Render](https://render.com), create a **Blueprint** from this repo. `render.yaml` configures the service and generates an admin token.
2. In `index.html`, set `BACKEND_URL` to your Render URL (e.g. `https://luxury-stays.onrender.com`) and push. The GitHub Pages site will then take live bookings.

Render's free tier has temporary disk storage, so the SQLite database resets on redeploys. For persistent data, attach a disk and set `DATABASE_PATH`, or switch to a hosted database.

## Tech stack
HTML5 · CSS3 (grid, flexbox, custom properties) · vanilla JavaScript · Python · Flask · SQLite · pytest

Photos from [Unsplash](https://unsplash.com). Luxury Stays is a fictional hotel; this is a portfolio project.
