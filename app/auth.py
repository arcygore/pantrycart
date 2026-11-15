import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, Header, HTTPException, Request, status

from app.config import COOKIE_NAME, COOKIE_SECURE, SESSION_DAYS
from app.database import get_db


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def hash_password(password: str, salt: Optional[str] = None) -> str:
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000)
    return f"pbkdf2_sha256${salt}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, salt, hex_digest = stored_hash.split("$", 2)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hash_password(password, salt)
        return hmac.compare_digest(candidate, stored_hash)
    except ValueError:
        return False


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def should_use_secure_cookie(request: Request) -> bool:
    if COOKIE_SECURE == "true":
        return True
    if COOKIE_SECURE == "false":
        return False
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or proto == "https"


def create_session(user_id: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(36)
    now = utc_now()
    expires = now + timedelta(days=SESSION_DAYS)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires.isoformat()),
        )
    return token, expires.isoformat()


def delete_session(token: str) -> None:
    with get_db() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def get_user_from_token(token: str) -> Optional[dict]:
    if not token:
        return None
    now = utc_now()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.is_admin, u.shortcut_verified, s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()
        if not row:
            return None
        expires_at = datetime.fromisoformat(row["expires_at"])
        if expires_at <= now:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
        # Sliding refresh if less than half lifetime left
        if (expires_at - now).days < max(1, SESSION_DAYS // 2):
            new_exp = (now + timedelta(days=SESSION_DAYS)).isoformat()
            conn.execute("UPDATE sessions SET expires_at = ? WHERE token = ?", (new_exp, token))
        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "is_admin": bool(row["is_admin"]),
            "shortcut_verified": bool(row["shortcut_verified"]) if "shortcut_verified" in row.keys() else False,
        }


def get_current_user(request: Request) -> dict:
    token = request.cookies.get(COOKIE_NAME, "")
    user = get_user_from_token(token)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


def verify_api_key_or_user(
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
    api_key: Optional[str] = None,
) -> dict:
    raw_key = x_api_key or api_key
    if raw_key:
        key_h = hash_api_key(raw_key)
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, name, created_by FROM api_keys WHERE key_hash = ?",
                (key_h,),
            ).fetchone()
            if row:
                conn.execute(
                    "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
                    (utc_now_iso(), row["id"]),
                )
                return {
                    "id": row["created_by"],
                    "username": f"api:{row['name']}",
                    "display_name": row["name"],
                    "is_admin": False,
                    "is_api_key": True,
                }
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")

    return get_current_user(request)
