"""Rate limiting, login throttling, request ids and security headers."""
import hmac
import re
import threading
import time

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def safe_equal(a, b):
    """Constant-time string comparison."""
    return hmac.compare_digest(str(a).encode(), str(b).encode())


class RateLimiter:
    """In-memory fixed-window limiter (per process)."""

    def __init__(self):
        self.hits = {}
        self.lock = threading.Lock()

    def check(self, key, limit, window=60):
        """Count a hit. Returns 0 if allowed, else seconds until the window resets."""
        now = time.monotonic()
        with self.lock:
            if len(self.hits) > 10000:
                self.hits = {k: v for k, v in self.hits.items() if v[0] > now}
            reset, count = self.hits.get(key, (0, 0))
            if reset <= now:
                reset, count = now + window, 0
            if count >= limit:
                return max(int(reset - now) + 1, 1)
            self.hits[key] = (reset, count + 1)
            return 0


class LoginThrottle:
    """Locks an IP out for `lockout` seconds after `limit` failed logins."""

    def __init__(self, limit=5, lockout=900):
        self.limit, self.lockout = limit, lockout
        self.fails = {}
        self.lock = threading.Lock()

    def blocked_for(self, ip):
        with self.lock:
            count, until = self.fails.get(ip, (0, 0))
            return max(int(until - time.monotonic()) + 1, 0) if until > time.monotonic() else 0

    def failed(self, ip):
        with self.lock:
            count, until = self.fails.get(ip, (0, 0))
            count += 1
            until = time.monotonic() + self.lockout if count >= self.limit else until
            self.fails[ip] = (0 if count >= self.limit else count, until)

    def succeeded(self, ip):
        with self.lock:
            self.fails.pop(ip, None)


def add_security_headers(resp, path):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
    if path.startswith(("/admin", "/api")):
        resp.headers.setdefault("X-Frame-Options", "DENY")
    if path.startswith("/admin"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp
