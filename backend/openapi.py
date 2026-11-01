"""Hand-written OpenAPI 3.0 spec for the public API, plus the Swagger UI page."""

DOCS_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>Luxury Stays API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url: "/api/openapi.json", dom_id: "#ui"});</script></body></html>"""


def ref(name):
    return {"$ref": f"#/components/schemas/{name}"}


def body(name):
    return {"required": True, "content": {"application/json": {"schema": ref(name)}}}


def ok(description, schema):
    return {"description": description, "content": {"application/json": {"schema": schema}}}


def err(description):
    return ok(description, ref("Error"))


STR, INT, BOOL = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}
DATE = {"type": "string", "format": "date", "example": "2026-12-20"}
SLUG = {"type": "string", "enum": ["deluxe", "premier", "executive", "presidential"]}
LIMITED = {"429": err("Rate limit exceeded; see the Retry-After header.")}
REF_PARAM = {"name": "ref", "in": "path", "required": True, "schema": STR, "example": "LS-1A2B3C"}


def obj(required=(), **props):
    return {"type": "object", "required": list(required), "properties": props}


def build_spec():
    stay = obj(["room", "checkin", "checkout"], room=SLUG, checkin=DATE, checkout=DATE,
               guests={"type": "integer", "minimum": 1, "default": 1})
    booking_props = dict(ref=STR, room_slug=SLUG, room_name=STR, guest_name=STR, email=STR, phone=STR,
                         checkin=DATE, checkout=DATE, guests=INT, nights=INT, total=INT,
                         status={"type": "string", "enum": ["confirmed", "cancelled"]}, created_at=STR)
    schemas = {
        "Error": obj(["error"], error=STR),
        "Room": obj(slug=SLUG, name=STR, price=INT, max_guests=INT),
        "StayRequest": stay,
        "Quote": obj(room=SLUG, room_name=STR, checkin=DATE, checkout=DATE, guests=INT, nights=INT,
                     price_per_night=INT, subtotal=INT, taxes=INT, total=INT, rooms_left=INT, available=BOOL),
        "BookingRequest": {"allOf": [ref("StayRequest"), obj(["name", "email"], name=STR,
                                     email={"type": "string", "format": "email"}, phone=STR)]},
        "Booking": obj(**booking_props),
        "EmailRequest": obj(["email"], email={"type": "string", "format": "email"}),
        "ContactRequest": obj(["name", "email", "message"], name=STR, email={"type": "string", "format": "email"},
                              subject=STR, message={"type": "string", "minLength": 10}),
        "Calendar": obj(room=SLUG, name=STR, inventory=INT, price=INT,
                        days={"type": "array", "items": obj(date=DATE, rooms_left=INT)}),
        "Health": obj(status={"type": "string", "enum": ["ok", "degraded"]},
                      database={"type": "string", "enum": ["sqlite", "postgres"]}),
    }
    paths = {
        "/api/health": {"get": {"summary": "Liveness and database check", "responses": {
            "200": ok("Healthy", ref("Health")), "503": ok("Database unreachable", ref("Health"))}}},
        "/api/rooms": {"get": {"summary": "List room types", "responses": {
            "200": ok("Rooms ordered by price", {"type": "array", "items": ref("Room")})}}},
        "/api/rooms/{slug}/calendar": {"get": {
            "summary": "Rooms left per night for a room type",
            "parameters": [
                {"name": "slug", "in": "path", "required": True, "schema": SLUG},
                {"name": "start", "in": "query", "schema": DATE, "description": "Defaults to today; not in the past."},
                {"name": "days", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 90, "default": 14}}],
            "responses": {"200": ok("Calendar", ref("Calendar")), "400": err("Invalid start or days"),
                          "404": err("Unknown room type")}}},
        "/api/availability": {"post": {"summary": "Quote and availability for a stay", "requestBody": body("StayRequest"),
            "responses": {"200": ok("Quote", ref("Quote")), "400": err("Validation error"),
                          "404": err("Unknown room type"), **LIMITED}}},
        "/api/bookings": {"post": {"summary": "Create a booking", "requestBody": body("BookingRequest"),
            "responses": {"201": ok("Created", ref("Booking")), "400": err("Validation error"),
                          "409": err("Fully booked"), **LIMITED}}},
        "/api/bookings/{ref}": {"get": {"summary": "Look up a booking",
            "parameters": [REF_PARAM, {"name": "email", "in": "query", "required": True, "schema": STR}],
            "responses": {"200": ok("Booking", ref("Booking")), "404": err("Not found")}}},
        "/api/bookings/{ref}/cancel": {"post": {"summary": "Cancel a booking", "parameters": [REF_PARAM],
            "requestBody": body("EmailRequest"),
            "responses": {"200": ok("Cancelled", ref("Booking")), "404": err("Not found"),
                          "409": err("Already cancelled"), **LIMITED}}},
        "/api/contact": {"post": {"summary": "Send a contact-form message", "requestBody": body("ContactRequest"),
            "responses": {"201": ok("Stored", obj(ok=BOOL)), "400": err("Validation error"), **LIMITED}}},
        "/api/subscribe": {"post": {"summary": "Newsletter sign-up", "requestBody": body("EmailRequest"),
            "responses": {"201": ok("Subscribed", obj(ok=BOOL, already_subscribed=BOOL)),
                          "400": err("Validation error"), **LIMITED}}},
    }
    return {"openapi": "3.0.3",
            "info": {"title": "Luxury Stays API", "version": "2.0.0",
                     "description": "Booking API for the Luxury Stays demo hotel. Dates are YYYY-MM-DD; prices are INR."},
            "paths": paths, "components": {"schemas": schemas}}
