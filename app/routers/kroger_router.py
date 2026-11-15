import base64
import math
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.auth import get_current_user, require_non_guest, utc_now_iso
from app.database import get_db
from app.units import clean_shopping_item_name

router = APIRouter(prefix="/api/kroger", tags=["kroger"])

KROGER_AUTH_URL = "https://api.kroger.com/v1/connect/oauth2/authorize"
KROGER_TOKEN_URL = "https://api.kroger.com/v1/connect/oauth2/token"
KROGER_API_BASE = "https://api.kroger.com/v1"


class KrogerConfigPayload(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    redirect_uri: str = ""
    linked_store_id: Optional[int] = None


class KrogerLocationPayload(BaseModel):
    location_id: str = Field(min_length=1, max_length=32)
    location_name: str = ""
    location_address: str = ""
    location_chain: str = "Kroger"
    linked_store_id: Optional[int] = None


class KrogerPushItem(BaseModel):
    upc: str = Field(min_length=1)
    quantity: int = Field(default=1, ge=1, le=99)


class KrogerPushCartPayload(BaseModel):
    modality: str = "PICKUP"  # PICKUP | DELIVERY
    items: list[KrogerPushItem] = Field(default_factory=list)


class KrogerProductSearchPayload(BaseModel):
    term: str = Field(min_length=1, max_length=160)
    list_id: Optional[int] = None
    location_id: Optional[str] = None
    limit: int = Field(default=6, ge=1, le=15)


def _infer_redirect_uri(request: Request, saved_redirect: str = "") -> str:
    if saved_redirect and saved_redirect.strip():
        return saved_redirect.strip()
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip() or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/api/kroger/oauth/callback"


def _get_kroger_config(conn) -> dict:
    row = conn.execute("SELECT * FROM kroger_config WHERE id = 1").fetchone()
    if not row:
        return {
            "client_id": "",
            "client_secret": "",
            "redirect_uri": "",
            "location_id": "",
            "location_name": "",
            "location_address": "",
            "location_chain": "Kroger",
            "linked_store_id": None,
        }
    return dict(row)


def _resolve_kroger_location(conn, cfg: dict, store_id: Optional[int]) -> tuple[str, str]:
    """Return (location_id, location_name) preferring the store's own linked Kroger store."""
    if store_id:
        srow = conn.execute(
            "SELECT name, kroger_location_id, kroger_location_name FROM stores WHERE id = ?",
            (store_id,),
        ).fetchone()
        if srow and (srow["kroger_location_id"] or "").strip():
            loc_id = srow["kroger_location_id"].strip()
            loc_name = (srow["kroger_location_name"] or srow["name"] or "").strip()
            return loc_id, loc_name
    return (cfg.get("location_id") or "").strip(), (cfg.get("location_name") or "").strip()


def _basic_auth_header(client_id: str, client_secret: str) -> str:
    token = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


async def _get_client_credentials_token(client_id: str, client_secret: str) -> str:
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail="Kroger Client ID & Client Secret are not configured yet. Go to Settings → Kroger API to set them up.",
        )
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            KROGER_TOKEN_URL,
            headers={
                "Authorization": _basic_auth_header(client_id, client_secret),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials", "scope": "product.compact"},
        )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=400,
                detail=f"Kroger API rejected Client ID / Secret ({resp.status_code}): {resp.text[:250]}",
            )
        return resp.json()["access_token"]


async def _get_valid_user_oauth_token(conn, user_id: int, cfg: dict) -> str:
    row = conn.execute("SELECT * FROM kroger_user_tokens WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(
            status_code=401,
            detail="Your Kroger account is not connected yet. Connect your Kroger login in Settings → Kroger API or click 'Connect Kroger' below.",
        )

    now_ts = int(time.time())
    if row["expires_at"] > now_ts + 60:
        return row["access_token"]

    if not row["refresh_token"]:
        raise HTTPException(
            status_code=401,
            detail="Kroger session expired. Please reconnect your Kroger account.",
        )

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            KROGER_TOKEN_URL,
            headers={
                "Authorization": _basic_auth_header(cfg["client_id"], cfg["client_secret"]),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "grant_type": "refresh_token",
                "refresh_token": row["refresh_token"],
            },
        )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=401,
                detail="Kroger authorization expired. Please reconnect your Kroger account.",
            )
        data = resp.json()
        new_access = data["access_token"]
        new_refresh = data.get("refresh_token") or row["refresh_token"]
        expires_in = int(data.get("expires_in", 1800))
        conn.execute(
            """
            UPDATE kroger_user_tokens
            SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
            WHERE user_id = ?
            """,
            (new_access, new_refresh, now_ts + expires_in, utc_now_iso(), user_id),
        )
        return new_access


def _extract_kroger_product_summary(prod: dict) -> dict:
    upc = prod.get("upc") or prod.get("productId") or ""
    desc = prod.get("description") or ""
    brand = prod.get("brand") or ""

    items = prod.get("items") or []
    first_item = items[0] if items else {}
    size = first_item.get("size") or ""
    price_obj = first_item.get("price") or {}
    price = price_obj.get("promo") or price_obj.get("regular")

    aisle_locs = prod.get("aisleLocations") or []
    aisle_str = ""
    aisle_desc = ""
    if aisle_locs and isinstance(aisle_locs[0], dict):
        loc = aisle_locs[0]
        aisle_num = str(loc.get("number") or "").strip()
        bay = str(loc.get("bayNumber") or "").strip()
        side = str(loc.get("side") or "").strip()
        aisle_desc = str(loc.get("description") or "").strip()
        if aisle_num:
            extras = [x for x in (f"Side {side}" if side else "", f"Bay {bay}" if bay else "") if x]
            aisle_str = f"{aisle_num} ({', '.join(extras)})" if extras else aisle_num
        elif aisle_desc:
            aisle_str = aisle_desc

    img_url = ""
    images = prod.get("images") or []
    if images:
        sizes = images[0].get("sizes") or []
        for s in sizes:
            if s.get("size") in ("medium", "small", "thumbnail") and s.get("url"):
                img_url = s["url"]
                break
        if not img_url and sizes and sizes[0].get("url"):
            img_url = sizes[0]["url"]

    return {
        "upc": upc,
        "description": desc,
        "brand": brand,
        "size": size,
        "price": price,
        "aisle": aisle_str,
        "aisle_description": aisle_desc,
        "image_url": img_url,
    }


@router.get("/status")
def get_kroger_status(request: Request, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        tok = conn.execute(
            "SELECT user_id, expires_at, updated_at FROM kroger_user_tokens WHERE user_id = ?",
            (user["id"],),
        ).fetchone()
    return {
        "configured": bool(cfg["client_id"] and cfg["client_secret"]),
        "client_id": cfg["client_id"],
        "has_client_secret": bool(cfg["client_secret"]),
        "redirect_uri": _infer_redirect_uri(request, cfg["redirect_uri"]),
        "location_id": cfg["location_id"],
        "location_name": cfg["location_name"],
        "location_address": cfg["location_address"],
        "location_chain": cfg["location_chain"],
        "linked_store_id": cfg["linked_store_id"],
        "user_connected": bool(tok),
    }


@router.put("/config")
async def save_kroger_config(payload: KrogerConfigPayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        existing = _get_kroger_config(conn)
        cid = payload.client_id.strip()
        csec = payload.client_secret.strip()
        if csec in ("", "********") and existing["client_secret"]:
            csec = existing["client_secret"]

        if cid and csec:
            await _get_client_credentials_token(cid, csec)

        conn.execute(
            """
            INSERT INTO kroger_config (
                id, client_id, client_secret, redirect_uri, location_id, location_name,
                location_address, location_chain, linked_store_id, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                client_id = excluded.client_id,
                client_secret = excluded.client_secret,
                redirect_uri = excluded.redirect_uri,
                linked_store_id = excluded.linked_store_id,
                updated_at = excluded.updated_at
            """,
            (
                cid,
                csec,
                payload.redirect_uri.strip(),
                existing["location_id"],
                existing["location_name"],
                existing["location_address"],
                existing["location_chain"],
                payload.linked_store_id if payload.linked_store_id is not None else existing["linked_store_id"],
                now,
            ),
        )
    return {"ok": True, "verified": bool(cid and csec)}


@router.get("/locations")
async def search_kroger_locations(zip_code: str, user: dict = Depends(get_current_user)):
    zc = zip_code.strip()
    if len(zc) < 5:
        raise HTTPException(status_code=400, detail="Enter a 5-digit US ZIP code")
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{KROGER_API_BASE}/locations",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"filter.zipCode.near": zc[:5], "filter.limit": 12},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Kroger Locations API error ({resp.status_code})")
        raw_locs = resp.json().get("data") or []

    results = []
    for loc in raw_locs:
        addr = loc.get("address") or {}
        address_str = ", ".join(
            x for x in (addr.get("addressLine1"), addr.get("city"), addr.get("state"), addr.get("zipCode")) if x
        )
        results.append(
            {
                "location_id": loc.get("locationId", ""),
                "name": loc.get("name", ""),
                "chain": loc.get("chain", "Kroger"),
                "address": address_str,
            }
        )
    return results


@router.put("/location")
def set_kroger_location(payload: KrogerLocationPayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        existing = _get_kroger_config(conn)
        if not existing["client_id"]:
            raise HTTPException(status_code=400, detail="Configure Kroger Client ID & Secret first")
        linked_sid = payload.linked_store_id if payload.linked_store_id is not None else existing["linked_store_id"]
        loc_id = payload.location_id.strip()
        loc_name = payload.location_name.strip()
        loc_addr = payload.location_address.strip()
        conn.execute(
            """
            UPDATE kroger_config
            SET location_id = ?, location_name = ?, location_address = ?, location_chain = ?,
                linked_store_id = ?, updated_at = ?
            WHERE id = 1
            """,
            (
                loc_id,
                loc_name,
                loc_addr,
                payload.location_chain.strip() or "Kroger",
                linked_sid,
                now,
            ),
        )
        if linked_sid:
            conn.execute(
                """
                UPDATE stores
                SET kroger_location_id = ?, kroger_location_name = ?, kroger_location_address = ?
                WHERE id = ?
                """,
                (loc_id, loc_name, loc_addr, linked_sid),
            )
    return {"ok": True}


@router.get("/oauth/start")
def start_kroger_oauth(request: Request, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(
            status_code=400,
            detail="Configure Kroger Client ID & Secret in Settings → Kroger API first.",
        )
    redirect_uri = _infer_redirect_uri(request, cfg["redirect_uri"])
    params = {
        "scope": "cart.basic:write product.compact",
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "state": str(user["id"]),
    }
    return {"authorize_url": f"{KROGER_AUTH_URL}?{urlencode(params)}"}


@router.get("/oauth/callback", response_class=HTMLResponse)
async def kroger_oauth_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
):
    if error or not code:
        return HTMLResponse(
            f"<html><body style='font-family:sans-serif;padding:30px;'>"
            f"<h2>Kroger Authorization Cancelled or Failed</h2>"
            f"<p>{error or 'No authorization code returned.'}</p>"
            f"<p><a href='/'>Return to PantryCart</a></p></body></html>",
            status_code=400,
        )

    try:
        user_id = int(state)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        redirect_uri = _infer_redirect_uri(request, cfg["redirect_uri"])

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                KROGER_TOKEN_URL,
                headers={
                    "Authorization": _basic_auth_header(cfg["client_id"], cfg["client_secret"]),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
            )
            if resp.status_code != 200:
                return HTMLResponse(
                    f"<html><body style='font-family:sans-serif;padding:30px;'>"
                    f"<h2>Kroger Token Exchange Failed ({resp.status_code})</h2>"
                    f"<pre>{resp.text}</pre>"
                    f"<p>Make sure Redirect URI <code>{redirect_uri}</code> matches your Kroger Developer app settings.</p>"
                    f"<p><a href='/'>Return to PantryCart</a></p></body></html>",
                    status_code=400,
                )
            data = resp.json()
            now_ts = int(time.time())
            expires_at = now_ts + int(data.get("expires_in", 1800))
            conn.execute(
                """
                INSERT INTO kroger_user_tokens (user_id, access_token, refresh_token, expires_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    access_token = excluded.access_token,
                    refresh_token = excluded.refresh_token,
                    expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at
                """,
                (user_id, data["access_token"], data.get("refresh_token", ""), expires_at, utc_now_iso()),
            )

    return HTMLResponse(
        "<html><head><meta http-equiv='refresh' content='1;url=/#lists?kroger_connected=1' /></head>"
        "<body style='font-family:sans-serif;padding:30px;text-align:center;'>"
        "<h2>Kroger Account Connected!</h2>"
        "<p>Redirecting back to PantryCart...</p>"
        "<p><a href='/#lists?kroger_connected=1'>Click here if not redirected</a></p>"
        "</body></html>"
    )


@router.post("/auto-aisles/{list_id}")
async def auto_map_kroger_aisles(list_id: int, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        loc_id, loc_name = _resolve_kroger_location(conn, cfg, lst["store_id"])
        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger API credentials & map a Kroger store Location (in Stores or Settings → Kroger API) first.",
            )
        items = conn.execute(
            "SELECT * FROM shopping_list_items WHERE list_id = ? AND checked = 0",
            (list_id,),
        ).fetchall()

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    updated_count = 0
    matched_results = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for item in items:
            clean_term, _ = clean_shopping_item_name(item["name"])
            search_term = clean_term or item["name"]
            resp = await client.get(
                f"{KROGER_API_BASE}/products",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                params={
                    "filter.term": search_term,
                    "filter.locationId": loc_id,
                    "filter.limit": 3,
                },
            )
            if resp.status_code != 200:
                continue
            prods = resp.json().get("data") or []
            chosen = None
            for p in prods:
                summary = _extract_kroger_product_summary(p)
                if summary["aisle"]:
                    chosen = summary
                    break
            if chosen:
                updated_count += 1
                matched_results.append({"item_id": item["id"], "name": item["name"], **chosen})

    if matched_results:
        target_store_id = lst["store_id"] or cfg["linked_store_id"]
        with get_db() as conn:
            item_by_id = {it["id"]: it for it in items}
            for m in matched_results:
                it = item_by_id.get(m["item_id"])
                if not it:
                    continue
                price_note = f"${m['price']:.2f} @ Kroger" if m.get("price") else ""
                new_notes = it["notes"] or price_note
                conn.execute(
                    "UPDATE shopping_list_items SET aisle = ?, notes = ? WHERE id = ?",
                    (m["aisle"], new_notes, m["item_id"]),
                )
                if target_store_id:
                    conn.execute(
                        """
                        INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(item_key, store_id) DO UPDATE SET
                            aisle = excluded.aisle,
                            updated_at = excluded.updated_at
                        """,
                        (it["item_key"], it["name"], target_store_id, it["department"] or "Dry Goods", m["aisle"], now),
                    )
            conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))

    return {"updated_count": updated_count, "total_unchecked": len(items), "location_name": loc_name}


@router.post("/preview-cart/{list_id}")
async def preview_kroger_cart(list_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        loc_id, loc_name = _resolve_kroger_location(conn, cfg, lst["store_id"])
        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger API credentials & map a Kroger store Location (in Stores or Settings → Kroger API) first.",
            )
        items = conn.execute(
            "SELECT * FROM shopping_list_items WHERE list_id = ? AND checked = 0",
            (list_id,),
        ).fetchall()

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    previews = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for item in items:
            clean_term, _ = clean_shopping_item_name(item["name"])
            search_term = clean_term or item["name"]
            resp = await client.get(
                f"{KROGER_API_BASE}/products",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                params={
                    "filter.term": search_term,
                    "filter.locationId": loc_id,
                    "filter.limit": 3,
                },
            )
            candidates = []
            if resp.status_code == 200:
                for p in (resp.json().get("data") or []):
                    s = _extract_kroger_product_summary(p)
                    if s["upc"]:
                        candidates.append(s)
            previews.append(
                {
                    "list_item_id": item["id"],
                    "list_item_name": item["name"],
                    "search_term": search_term,
                    "quantity": max(1, int(math.ceil(float(item["buy_qty"] or 1)))),
                    "buy_unit": item["buy_unit"],
                    "candidates": candidates,
                    "selected_upc": candidates[0]["upc"] if candidates else "",
                }
            )

    return {
        "location_id": loc_id,
        "location_name": loc_name,
        "items": previews,
    }


@router.post("/search-product")
async def search_kroger_product(payload: KrogerProductSearchPayload, user: dict = Depends(get_current_user)):
    clean_term, _ = clean_shopping_item_name(payload.term)
    search_term = clean_term or payload.term.strip()
    if not search_term:
        raise HTTPException(status_code=400, detail="Enter a search term")

    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        loc_id = (payload.location_id or "").strip()
        loc_name = ""
        if not loc_id and payload.list_id is not None:
            lst = conn.execute("SELECT store_id FROM shopping_lists WHERE id = ?", (payload.list_id,)).fetchone()
            if lst:
                loc_id, loc_name = _resolve_kroger_location(conn, cfg, lst["store_id"])
        if not loc_id:
            loc_id = (cfg.get("location_id") or "").strip()
            loc_name = (cfg.get("location_name") or "").strip()
        elif not loc_name:
            loc_name = (cfg.get("location_name") or "").strip()

        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger API credentials & map a Kroger store Location (in Stores or Settings → Kroger API) first.",
            )

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    candidates = []
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{KROGER_API_BASE}/products",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={
                "filter.term": search_term,
                "filter.locationId": loc_id,
                "filter.limit": payload.limit,
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Kroger product search error ({resp.status_code})")
        for p in (resp.json().get("data") or []):
            s = _extract_kroger_product_summary(p)
            if s["upc"]:
                candidates.append(s)

    return {
        "term": search_term,
        "location_id": loc_id,
        "location_name": loc_name,
        "candidates": candidates,
    }


@router.post("/push-cart")
async def push_items_to_kroger_cart(payload: KrogerPushCartPayload, user: dict = Depends(get_current_user)):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Select at least one Kroger item to add to cart")
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        if not cfg["client_id"] or not cfg["client_secret"]:
            raise HTTPException(status_code=400, detail="Kroger API credentials are not configured")
        user_token = await _get_valid_user_oauth_token(conn, user["id"], cfg)

    kroger_items = [
        {"upc": it.upc.strip(), "quantity": it.quantity, "modality": payload.modality}
        for it in payload.items
        if it.upc.strip()
    ]

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.put(
            f"{KROGER_API_BASE}/cart/add",
            headers={
                "Authorization": f"Bearer {user_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={"items": kroger_items},
        )
        if resp.status_code in (401, 403):
            raise HTTPException(
                status_code=401,
                detail="Kroger login expired or missing cart permission. Reconnect your Kroger account.",
            )
        if resp.status_code not in (200, 204):
            raise HTTPException(
                status_code=502,
                detail=f"Kroger Cart API returned {resp.status_code}: {resp.text[:300]}",
            )

    return {"ok": True, "added_count": len(kroger_items)}
