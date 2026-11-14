import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DB_PATH = os.environ.get("PANTRY_DB_PATH", str(BASE_DIR.parent / "data" / "pantry.db"))
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "90"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").lower()
COOKIE_NAME = "pantrycart_session"
