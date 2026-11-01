"""Thin database adapter: SQLite by default, Postgres when DATABASE_URL is set.

Queries are written once with `?` placeholders and returned as dict rows on both.
"""
import os
import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "hotel.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL,
    max_guests INTEGER NOT NULL, inventory INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
    id {identity},
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
    id {identity}, name TEXT NOT NULL, email TEXT NOT NULL,
    subject TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscribers (
    email TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
"""
IDENTITY = {"sqlite": "INTEGER PRIMARY KEY AUTOINCREMENT",
            "postgres": "INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY"}
UPSERT_ROOM = ("INSERT INTO rooms (slug, name, price, max_guests, inventory) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, price=excluded.price, "
               "max_guests=excluded.max_guests, inventory=excluded.inventory")


def database_url():
    """DATABASE_URL normalised to postgresql://, or None when SQLite is in use."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url if url.startswith("postgresql://") else None


def kind():
    return "postgres" if database_url() else "sqlite"


def sqlite_path():
    return os.environ.get("DATABASE_PATH") or DEFAULT_DB_PATH


def _dict_factory(cursor, row):
    return {col[0]: value for col, value in zip(cursor.description, row)}


class Database:
    """One connection per request. Use execute()/commit()/rollback()/close()."""

    def __init__(self):
        self.kind = kind()
        if self.kind == "postgres":
            import psycopg
            from psycopg.rows import dict_row
            self.conn = psycopg.connect(database_url(), row_factory=dict_row)
        else:
            self.conn = sqlite3.connect(sqlite_path())
            self.conn.row_factory = _dict_factory
            self.conn.execute("PRAGMA foreign_keys = ON")

    def execute(self, sql, params=()):
        if self.kind == "postgres":
            return self.conn.execute(sql.replace("?", "%s"), tuple(params) or None)
        return self.conn.execute(sql, params)

    def begin_write(self, room_slug):
        """Start a transaction that serialises writers for one room type.

        SQLite: BEGIN IMMEDIATE takes the database write lock.
        Postgres: lock the room-type row, so concurrent bookings of that type queue up.
        """
        if self.kind == "postgres":
            self.execute("SELECT slug FROM rooms WHERE slug = ? FOR UPDATE", (room_slug,))
        else:
            self.execute("BEGIN IMMEDIATE")

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()


def init_db(rooms):
    """Create tables (idempotent) and sync the room catalogue."""
    db = Database()
    try:
        script = SCHEMA.format(identity=IDENTITY[db.kind])
        if db.kind == "postgres":
            db.execute("SELECT pg_advisory_xact_lock(727274)")  # workers may start together
            for stmt in script.split(";"):
                if stmt.strip():
                    db.execute(stmt)
        else:
            db.conn.executescript(script)
        for room in rooms:
            db.execute(UPSERT_ROOM, room)
        db.commit()
    finally:
        db.close()


def get_db():
    """Per-request connection, closed by close_db() at teardown."""
    from flask import g
    if "db" not in g:
        g.db = Database()
    return g.db


def close_db(_exc=None):
    from flask import g
    db = g.pop("db", None)
    if db is not None:
        db.close()
