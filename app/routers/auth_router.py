import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.auth import (
    create_session,
    delete_session,
    get_current_user,
    get_user_from_token,
    hash_api_key,
    hash_password,
    require_admin,
    should_use_secure_cookie,
    utc_now_iso,
    verify_password,
)
from app.config import COOKIE_NAME, SESSION_DAYS
from app.database import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SetupPayload(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=4, max_length=128)


class LoginPayload(BaseModel):
    username: str
    password: str


class CreateUserPayload(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=4, max_length=128)
    is_admin: bool = False


class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str = Field(min_length=4, max_length=128)


class CreateApiKeyPayload(BaseModel):
    name: str = Field(min_length=1, max_length=60)


def _user_dict(row) -> dict:
    keys = row.keys() if hasattr(row, "keys") else []
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "is_admin": bool(row["is_admin"]),
        "shortcut_verified": bool(row["shortcut_verified"]) if "shortcut_verified" in keys else False,
    }


def _set_auth_cookie(response: Response, request: Request, token: str):
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=should_use_secure_cookie(request),
        max_age=SESSION_DAYS * 86400,
        path="/",
    )


@router.get("/status")
def auth_status(request: Request):
    with get_db() as conn:
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    token = request.cookies.get(COOKIE_NAME, "")
    user = get_user_from_token(token) if user_count > 0 else None
    return {
        "needs_setup": user_count == 0,
        "user": user,
    }


@router.post("/setup")
def initial_setup(payload: SetupPayload, request: Request, response: Response):
    uname = payload.username.strip().lower()
    with get_db() as conn:
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count > 0:
            raise HTTPException(status_code=400, detail="Household setup already completed.")
        cur = conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
            VALUES (?, ?, ?, 1, ?)
            """,
            (uname, payload.display_name.strip(), hash_password(payload.password), utc_now_iso()),
        )
        uid = cur.lastrowid

    token, _ = create_session(uid)
    _set_auth_cookie(response, request, token)
    return {
        "user": {
            "id": uid,
            "username": uname,
            "display_name": payload.display_name.strip(),
            "is_admin": True,
            "shortcut_verified": False,
        }
    }


@router.post("/login")
def login(payload: LoginPayload, request: Request, response: Response):
    uname = payload.username.strip().lower()
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, username, display_name, password_hash, is_admin, shortcut_verified FROM users WHERE username = ?",
            (uname,),
        ).fetchone()
    if not row or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

    token, _ = create_session(row["id"])
    _set_auth_cookie(response, request, token)
    return {
        "user": _user_dict(row)
    }


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME, "")
    if token:
        delete_session(token)
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/users")
def list_users(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, username, display_name, is_admin, shortcut_verified, created_at FROM users ORDER BY id ASC"
        ).fetchall()
    return [
        {
            **_user_dict(r),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.post("/users")
def create_user(payload: CreateUserPayload, admin: dict = Depends(require_admin)):
    uname = payload.username.strip().lower()
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (uname,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Username already exists")
        cur = conn.execute(
            """
            INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                uname,
                payload.display_name.strip(),
                hash_password(payload.password),
                1 if payload.is_admin else 0,
                utc_now_iso(),
            ),
        )
        uid = cur.lastrowid
    return {
        "id": uid,
        "username": uname,
        "display_name": payload.display_name.strip(),
        "is_admin": payload.is_admin,
    }


@router.delete("/users/{user_id}")
def delete_user(user_id: int, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete your own active account")
    with get_db() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"ok": True}


@router.post("/change-password")
def change_password(payload: ChangePasswordPayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not row or not verify_password(payload.current_password, row["password_hash"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(payload.new_password), user["id"]),
        )
    return {"ok": True}


@router.get("/api-keys")
def list_api_keys(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/api-keys")
def create_api_key(payload: CreateApiKeyPayload, user: dict = Depends(get_current_user)):
    raw_key = "pc_" + secrets.token_urlsafe(28)
    key_h = hash_api_key(raw_key)
    prefix = raw_key[:10] + "..."
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO api_keys (name, key_hash, key_prefix, created_by, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (payload.name.strip(), key_h, prefix, user["id"], utc_now_iso()),
        )
        kid = cur.lastrowid
    return {
        "id": kid,
        "name": payload.name.strip(),
        "key_prefix": prefix,
        "raw_key": raw_key,
    }


@router.delete("/api-keys/{key_id}")
def delete_api_key(key_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    return {"ok": True}
