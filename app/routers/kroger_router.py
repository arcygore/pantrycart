import asyncio
import base64
import math
import re
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.auth import get_current_user, require_non_guest, utc_now_iso
from app.database import get_db
from app.units import clean_shopping_item_name, normalize_item_key

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
    department: str = ""
    limit: int = Field(default=8, ge=1, le=15)


class KrogerPrefPayload(BaseModel):
    item_key: str = Field(min_length=1, max_length=160)
    upc: str = Field(min_length=1, max_length=64)
    description: str = ""
    brand: str = ""
    size: str = ""
    image_url: str = ""
    list_id: Optional[int] = None
    item_id: Optional[int] = None
    aisle: Optional[str] = None
    price: Optional[float] = None


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
    """Return (location_id, location_name) strictly for the given store.

    When ``store_id`` is selected (e.g. Publix or Costco), NEVER fall back to
    the global ``kroger_config`` location — only return a location if that
    specific PantryCart store has its own ``kroger_location_id`` linked.
    """
    if store_id is not None:
        srow = conn.execute(
            "SELECT name, kroger_location_id, kroger_location_name FROM stores WHERE id = ?",
            (store_id,),
        ).fetchone()
        if srow and (srow["kroger_location_id"] or "").strip():
            loc_id = srow["kroger_location_id"].strip()
            loc_name = (srow["kroger_location_name"] or srow["name"] or "").strip()
            return loc_id, loc_name
        return "", ""
    return (cfg.get("location_id") or "").strip(), (cfg.get("location_name") or "").strip()


def _basic_auth_header(client_id: str, client_secret: str) -> str:
    token = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


async def _get_client_credentials_token(client_id: str, client_secret: str, timeout: float = 15.0) -> str:
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail="Kroger Client ID & Client Secret are not configured yet. Go to Settings → Kroger to set them up.",
        )
    async with httpx.AsyncClient(timeout=timeout) as client:
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
            detail="Your Kroger account is not connected yet. Connect your Kroger login in Settings → Kroger or click 'Connect Kroger' below.",
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
    categories = [str(c).strip() for c in (prod.get("categories") or []) if c]

    items = prod.get("items") or []
    first_item = items[0] if items else {}
    size = first_item.get("size") or ""
    price_obj = first_item.get("price") or {}
    price = price_obj.get("promo") or price_obj.get("regular")

    aisle_locs = prod.get("aisleLocations") or []
    aisle_str = ""
    aisle_detail = ""
    aisle_desc = ""
    # Prefer the first entry with a concrete aisle number so grouping stays clean (e.g. "7")
    chosen_loc = None
    for loc in aisle_locs:
        if isinstance(loc, dict) and str(loc.get("number") or "").strip():
            chosen_loc = loc
            break
    if not chosen_loc:
        for loc in aisle_locs:
            if isinstance(loc, dict) and str(loc.get("description") or "").strip():
                chosen_loc = loc
                break
    if chosen_loc:
        aisle_num = str(chosen_loc.get("number") or "").strip()
        bay = str(chosen_loc.get("bayNumber") or "").strip()
        side = str(chosen_loc.get("side") or "").strip()
        aisle_desc = str(chosen_loc.get("description") or "").strip()
        extras = [x for x in (f"Side {side}" if side else "", f"Bay {bay}" if bay else "") if x]
        if aisle_num:
            aisle_str = aisle_num
            aisle_detail = ", ".join(extras) if extras else aisle_desc
        elif aisle_desc:
            aisle_str = aisle_desc
            aisle_detail = aisle_desc

    # Prefer front-facing product image
    img_url = ""
    images = prod.get("images") or []
    ordered_imgs = sorted(
        images,
        key=lambda im: 0 if (im.get("perspective") or "").lower() == "front" else 1,
    )
    for im in ordered_imgs:
        sizes = im.get("sizes") or []
        for pref_sz in ("medium", "small", "thumbnail", "large"):
            hit = next((s.get("url") for s in sizes if s.get("size") == pref_sz and s.get("url")), "")
            if hit:
                img_url = hit
                break
        if not img_url and sizes and sizes[0].get("url"):
            img_url = sizes[0]["url"]
        if img_url:
            break

    return {
        "upc": upc,
        "description": desc,
        "brand": brand,
        "size": size,
        "price": price,
        "aisle": aisle_str,
        "aisle_detail": aisle_detail,
        "aisle_description": aisle_desc,
        "categories": categories,
        "image_url": img_url,
    }


_DEPT_CAT_MATCHERS = {
    "produce": (("produce", "fruit", "vegetable", "fresh"), ("frozen", "canned", "snack", "chips", "condiment", "spice", "sauce", "candy")),
    "meat": (("meat", "seafood", "poultry", "beef", "chicken", "pork", "deli"), ("frozen", "canned", "snack", "soup", "broth", "seasoning", "spice")),
    "dairy": (("dairy", "egg", "cheese", "milk", "yogurt", "refrigerated"), ("frozen", "candy", "snack")),
    "frozen": (("frozen", "ice cream"), ()),
    "bakery": (("bakery", "deli", "bread"), ("frozen",)),
    "beverage": (("beverage", "drink", "coffee", "tea", "juice", "water", "soda"), ()),
    "snack": (("snack", "chips", "cracker", "cookie", "candy"), ()),
    "dry": (("pantry", "canned", "pasta", "baking", "condiment", "cereal", "grain", "rice", "sauce", "spice", "dry"), ()),
    "household": (("cleaning", "paper", "health", "beauty", "personal", "household", "pet"), ()),
}


def _score_kroger_candidate(summary: dict, search_term: str, department: str = "") -> float:
    score = 0.0
    if summary.get("aisle"):
        score += 50.0

    desc_l = (summary.get("description") or "").lower()
    desc_tokens = set(re.findall(r"[a-z0-9]+", desc_l))
    query_tokens = [t for t in re.findall(r"[a-z0-9]+", (search_term or "").lower()) if len(t) >= 2]

    all_matched = bool(query_tokens)
    for tok in query_tokens:
        if tok in desc_tokens:
            score += 15.0
        elif tok in desc_l:
            score += 7.0
        else:
            all_matched = False
    if all_matched:
        score += 20.0

    dept_l = (department or "").lower()
    cats_l = " ".join(c.lower() for c in (summary.get("categories") or []))
    if dept_l and cats_l:
        for key, (positives, negatives) in _DEPT_CAT_MATCHERS.items():
            if key in dept_l:
                has_pos = any(p in cats_l for p in positives)
                if has_pos:
                    score += 18.0
                elif any(n in cats_l for n in negatives):
                    score -= 25.0
                break

    if summary.get("price") is not None:
        score += 2.0
    if summary.get("image_url"):
        score += 1.0
    return score


async def _fetch_kroger_by_upc(
    client: httpx.AsyncClient, token: str, upc: str, loc_id: str
) -> Optional[dict]:
    clean_upc = (upc or "").strip()
    if not clean_upc:
        return None
    try:
        resp = await client.get(
            f"{KROGER_API_BASE}/products/{clean_upc}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"filter.locationId": loc_id},
        )
        if resp.status_code == 200:
            data = resp.json().get("data")
            if isinstance(data, dict):
                s = _extract_kroger_product_summary(data)
                if s["upc"]:
                    return s
        resp2 = await client.get(
            f"{KROGER_API_BASE}/products",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"filter.term": clean_upc, "filter.locationId": loc_id, "filter.limit": 3},
        )
        if resp2.status_code == 200:
            for p in (resp2.json().get("data") or []):
                s = _extract_kroger_product_summary(p)
                if s["upc"] == clean_upc:
                    return s
    except Exception:
        pass
    return None


async def _search_kroger_candidates(
    client: httpx.AsyncClient,
    token: str,
    term: str,
    loc_id: str,
    limit: int = 8,
    department: str = "",
) -> list[dict]:
    resp = await client.get(
        f"{KROGER_API_BASE}/products",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        params={"filter.term": term, "filter.locationId": loc_id, "filter.limit": limit},
    )
    if resp.status_code != 200:
        return []
    candidates = []
    for p in (resp.json().get("data") or []):
        s = _extract_kroger_product_summary(p)
        if s["upc"]:
            s["_score"] = _score_kroger_candidate(s, term, department)
            candidates.append(s)
    candidates.sort(key=lambda c: c.get("_score", 0.0), reverse=True)
    for c in candidates:
        c.pop("_score", None)
    return candidates


async def sync_list_aisles_for_kroger(
    list_id: int,
    user_id: int,
    force_overwrite_manual: bool = False,
) -> dict:
    """Sync Kroger aisles & prices (in ``price``, never ``notes``) for unchecked items on a list."""
    now = utc_now_iso()
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        loc_id, loc_name = _resolve_kroger_location(conn, cfg, lst["store_id"])
        items = conn.execute(
            "SELECT * FROM shopping_list_items WHERE list_id = ? AND checked = 0",
            (list_id,),
        ).fetchall()
        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            return {
                "updated_count": 0,
                "total_unchecked": len(items),
                "location_name": loc_name,
                "skipped": True,
            }
        loc_map = {}
        if lst["store_id"]:
            loc_rows = conn.execute(
                "SELECT item_key, aisle, source FROM item_store_locations WHERE store_id = ?",
                (lst["store_id"],),
            ).fetchall()
            loc_map = {r["item_key"]: dict(r) for r in loc_rows}
        pref_rows = conn.execute(
            "SELECT item_key, upc FROM kroger_product_prefs WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        prefs_map = {r["item_key"]: r["upc"] for r in pref_rows}

    if not items:
        return {"updated_count": 0, "total_unchecked": 0, "location_name": loc_name, "skipped": False}

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    sem = asyncio.Semaphore(5)

    async def _resolve_one(client: httpx.AsyncClient, item) -> Optional[dict]:
        existing_loc = loc_map.get(item["item_key"])
        has_manual_aisle = (
            existing_loc
            and (existing_loc.get("source") or "manual") == "manual"
            and bool((existing_loc.get("aisle") or "").strip())
        )
        if has_manual_aisle and not force_overwrite_manual:
            return None

        clean_term, _ = clean_shopping_item_name(item["name"])
        search_term = clean_term or item["name"]
        async with sem:
            pref_upc = prefs_map.get(item["item_key"])
            if pref_upc:
                pref_hit = await _fetch_kroger_by_upc(client, token, pref_upc, loc_id)
                if pref_hit and (pref_hit["aisle"] or pref_hit["price"] is not None):
                    return {"item_id": item["id"], **pref_hit}
            cands = await _search_kroger_candidates(
                client, token, search_term, loc_id, limit=8, department=item["department"] or ""
            )
            with_aisle = next((c for c in cands if c["aisle"]), None)
            chosen = with_aisle or (cands[0] if cands and cands[0]["price"] is not None else None)
            if chosen:
                return {"item_id": item["id"], **chosen}
        return None

    async with httpx.AsyncClient(timeout=15.0) as client:
        resolved = await asyncio.gather(*(_resolve_one(client, it) for it in items), return_exceptions=True)

    matched_results = [r for r in resolved if isinstance(r, dict)]
    updated_count = 0

    if matched_results:
        target_store_id = lst["store_id"]
        item_by_id = {it["id"]: it for it in items}
        with get_db() as conn:
            for m in matched_results:
                it = item_by_id.get(m["item_id"])
                if not it:
                    continue
                new_aisle = m["aisle"] or it["aisle"]
                new_price = m["price"] if m["price"] is not None else it["price"]
                if m["aisle"]:
                    updated_count += 1
                conn.execute(
                    "UPDATE shopping_list_items SET aisle = ?, price = ? WHERE id = ?",
                    (new_aisle, new_price, m["item_id"]),
                )
                if target_store_id and m["aisle"]:
                    existing_loc = loc_map.get(it["item_key"])
                    keep_manual = (
                        existing_loc
                        and (existing_loc.get("source") or "manual") == "manual"
                        and bool((existing_loc.get("aisle") or "").strip())
                        and not force_overwrite_manual
                    )
                    if not keep_manual:
                        conn.execute(
                            """
                            INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, source, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'kroger', ?)
                            ON CONFLICT(item_key, store_id) DO UPDATE SET
                                aisle = excluded.aisle,
                                source = 'kroger',
                                updated_at = excluded.updated_at
                            """,
                            (
                                it["item_key"],
                                it["name"],
                                target_store_id,
                                it["department"] or "Dry Goods",
                                m["aisle"],
                                now,
                            ),
                        )
            conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))

    return {
        "updated_count": updated_count,
        "total_unchecked": len(items),
        "location_name": loc_name,
        "skipped": False,
    }


async def lookup_single_item_kroger_aisle(list_id: int, item_id: int, user_id: int) -> None:
    """Fast best-effort Kroger aisle & price lookup for a newly added item."""
    try:
        now = utc_now_iso()
        with get_db() as conn:
            cfg = _get_kroger_config(conn)
            lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
            item = conn.execute(
                "SELECT * FROM shopping_list_items WHERE id = ? AND list_id = ?",
                (item_id, list_id),
            ).fetchone()
            if not lst or not item or not cfg["client_id"] or not cfg["client_secret"]:
                return
            loc_id, _ = _resolve_kroger_location(conn, cfg, lst["store_id"])
            if not loc_id:
                return
            if lst["store_id"]:
                loc = conn.execute(
                    "SELECT aisle, source FROM item_store_locations WHERE store_id = ? AND item_key = ?",
                    (lst["store_id"], item["item_key"]),
                ).fetchone()
                if loc and (loc["source"] or "manual") == "manual" and (loc["aisle"] or "").strip():
                    return
            pref = conn.execute(
                "SELECT upc FROM kroger_product_prefs WHERE user_id = ? AND item_key = ?",
                (user_id, item["item_key"]),
            ).fetchone()

        token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"], timeout=4.0)
        clean_term, _ = clean_shopping_item_name(item["name"])
        search_term = clean_term or item["name"]
        chosen = None
        async with httpx.AsyncClient(timeout=4.0) as client:
            if pref and pref["upc"]:
                chosen = await _fetch_kroger_by_upc(client, token, pref["upc"], loc_id)
            if not chosen or not chosen.get("aisle"):
                cands = await _search_kroger_candidates(
                    client, token, search_term, loc_id, limit=6, department=item["department"] or ""
                )
                chosen = next((c for c in cands if c["aisle"]), None) or chosen or (cands[0] if cands else None)
        if not chosen:
            return

        with get_db() as conn:
            new_aisle = chosen["aisle"] or item["aisle"]
            new_price = chosen["price"] if chosen["price"] is not None else item["price"]
            conn.execute(
                "UPDATE shopping_list_items SET aisle = ?, price = ? WHERE id = ?",
                (new_aisle, new_price, item_id),
            )
            if lst["store_id"] and chosen["aisle"]:
                conn.execute(
                    """
                    INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, source, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'kroger', ?)
                    ON CONFLICT(item_key, store_id) DO UPDATE SET
                        aisle = excluded.aisle,
                        source = 'kroger',
                        updated_at = excluded.updated_at
                    """,
                    (item["item_key"], item["name"], lst["store_id"], item["department"] or "Dry Goods", chosen["aisle"], now),
                )
            conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
    except Exception:
        return


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
            old_store = conn.execute(
                "SELECT kroger_location_id FROM stores WHERE id = ?",
                (linked_sid,),
            ).fetchone()
            conn.execute(
                """
                UPDATE stores
                SET kroger_location_id = ?, kroger_location_name = ?, kroger_location_address = ?
                WHERE id = ?
                """,
                (loc_id, loc_name, loc_addr, linked_sid),
            )
            if old_store and (old_store["kroger_location_id"] or "").strip() != loc_id:
                conn.execute(
                    "DELETE FROM item_store_locations WHERE store_id = ? AND COALESCE(source, 'manual') = 'kroger'",
                    (linked_sid,),
                )
    return {"ok": True}


@router.get("/prefs")
def list_kroger_product_prefs(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT item_key, upc, description, brand, size, image_url, updated_at FROM kroger_product_prefs WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
    return {r["item_key"]: dict(r) for r in rows}


@router.put("/prefs")
def save_kroger_product_pref(payload: KrogerPrefPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    ikey = normalize_item_key(payload.item_key)
    if not ikey:
        raise HTTPException(status_code=400, detail="item_key is required")
    upc = payload.upc.strip()

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO kroger_product_prefs (user_id, item_key, upc, description, brand, size, image_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, item_key) DO UPDATE SET
                upc = excluded.upc,
                description = excluded.description,
                brand = excluded.brand,
                size = excluded.size,
                image_url = excluded.image_url,
                updated_at = excluded.updated_at
            """,
            (
                user["id"],
                ikey,
                upc,
                payload.description.strip(),
                payload.brand.strip(),
                payload.size.strip(),
                payload.image_url.strip(),
                now,
            ),
        )
        if payload.list_id is not None and payload.item_id is not None:
            lst = conn.execute("SELECT id, store_id FROM shopping_lists WHERE id = ?", (payload.list_id,)).fetchone()
            it = conn.execute(
                "SELECT * FROM shopping_list_items WHERE id = ? AND list_id = ?",
                (payload.item_id, payload.list_id),
            ).fetchone()
            if lst and it:
                new_aisle = payload.aisle.strip() if payload.aisle is not None else it["aisle"]
                new_price = payload.price if payload.price is not None else it["price"]
                conn.execute(
                    "UPDATE shopping_list_items SET aisle = ?, price = ? WHERE id = ?",
                    (new_aisle, new_price, it["id"]),
                )
                if lst["store_id"] and payload.aisle is not None and payload.aisle.strip():
                    conn.execute(
                        """
                        INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, source, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'kroger', ?)
                        ON CONFLICT(item_key, store_id) DO UPDATE SET
                            aisle = excluded.aisle,
                            source = 'kroger',
                            updated_at = excluded.updated_at
                        """,
                        (it["item_key"], it["name"], lst["store_id"], it["department"] or "Dry Goods", payload.aisle.strip(), now),
                    )
                conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, payload.list_id))

    return {"ok": True, "item_key": ikey, "upc": upc}


@router.delete("/prefs/{item_key}")
def delete_kroger_product_pref(item_key: str, user: dict = Depends(get_current_user)):
    ikey = normalize_item_key(item_key)
    with get_db() as conn:
        conn.execute(
            "DELETE FROM kroger_product_prefs WHERE user_id = ? AND item_key = ?",
            (user["id"], ikey),
        )
    return {"ok": True}


@router.get("/oauth/start")
def start_kroger_oauth(request: Request, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise HTTPException(
            status_code=400,
            detail="Configure Kroger Client ID & Secret in Settings → Kroger first.",
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
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        loc_id, _ = _resolve_kroger_location(conn, cfg, lst["store_id"])
        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger API credentials & link a Kroger store Location (in Stores → Store Settings) first.",
            )
    return await sync_list_aisles_for_kroger(list_id, user["id"], force_overwrite_manual=False)


@router.post("/sync-store/{store_id}")
async def sync_store_aisle_map(store_id: int, user: dict = Depends(require_non_guest)):
    """Sync a PantryCart store's Aisle Map & active list items from its linked Kroger location."""
    now = utc_now_iso()
    with get_db() as conn:
        cfg = _get_kroger_config(conn)
        store = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not store:
            raise HTTPException(status_code=404, detail="Store not found")
        loc_id = (store["kroger_location_id"] or "").strip() if "kroger_location_id" in store.keys() else ""
        loc_name = (
            (store["kroger_location_name"] or store["name"] or "").strip()
            if "kroger_location_name" in store.keys()
            else store["name"]
        )
        if not cfg["client_id"] or not cfg["client_secret"]:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger Client ID & Secret in Settings → Kroger first.",
            )
        if not loc_id:
            raise HTTPException(
                status_code=400,
                detail=f"{store['name']} is not linked to a Kroger store location yet.",
            )

        existing_locs = conn.execute(
            "SELECT item_key, item_display, department, aisle, source FROM item_store_locations WHERE store_id = ?",
            (store_id,),
        ).fetchall()
        manual_keys = {
            r["item_key"]
            for r in existing_locs
            if (r["source"] or "manual") == "manual" and bool((r["aisle"] or "").strip())
        }
        targets_by_key: dict[str, dict] = {}
        for r in existing_locs:
            if r["item_key"] not in manual_keys:
                targets_by_key[r["item_key"]] = {
                    "item_key": r["item_key"],
                    "item_display": r["item_display"],
                    "department": r["department"] or "Dry Goods",
                }
        list_items = conn.execute(
            """
            SELECT sli.item_key, sli.name, sli.department
            FROM shopping_list_items sli
            JOIN shopping_lists sl ON sl.id = sli.list_id
            WHERE sl.store_id = ? AND sli.checked = 0
            """,
            (store_id,),
        ).fetchall()
        for li in list_items:
            if li["item_key"] not in manual_keys and li["item_key"] not in targets_by_key:
                targets_by_key[li["item_key"]] = {
                    "item_key": li["item_key"],
                    "item_display": li["name"],
                    "department": li["department"] or "Dry Goods",
                }

        pref_rows = conn.execute(
            "SELECT item_key, upc FROM kroger_product_prefs WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
        prefs_map = {r["item_key"]: r["upc"] for r in pref_rows}

    targets = list(targets_by_key.values())
    if not targets:
        return {"ok": True, "synced_count": 0, "total_checked": 0, "location_name": loc_name}

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    sem = asyncio.Semaphore(5)

    async def _lookup_target(client: httpx.AsyncClient, t: dict) -> Optional[dict]:
        clean_term, _ = clean_shopping_item_name(t["item_display"])
        search_term = clean_term or t["item_display"]
        async with sem:
            pref_upc = prefs_map.get(t["item_key"])
            if pref_upc:
                pref_hit = await _fetch_kroger_by_upc(client, token, pref_upc, loc_id)
                if pref_hit and (pref_hit["aisle"] or pref_hit["price"] is not None):
                    return {**t, **pref_hit}
            cands = await _search_kroger_candidates(
                client, token, search_term, loc_id, limit=8, department=t["department"]
            )
            chosen = next((c for c in cands if c["aisle"]), None) or (
                cands[0] if cands and cands[0]["price"] is not None else None
            )
            if chosen:
                return {**t, **chosen}
        return None

    async with httpx.AsyncClient(timeout=15.0) as client:
        results = await asyncio.gather(*(_lookup_target(client, t) for t in targets), return_exceptions=True)

    hits = [r for r in results if isinstance(r, dict)]
    synced_count = 0
    with get_db() as conn:
        for h in hits:
            if h["aisle"]:
                synced_count += 1
                conn.execute(
                    """
                    INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, source, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'kroger', ?)
                    ON CONFLICT(item_key, store_id) DO UPDATE SET
                        aisle = excluded.aisle,
                        source = 'kroger',
                        updated_at = excluded.updated_at
                    """,
                    (h["item_key"], h["item_display"], store_id, h["department"], h["aisle"], now),
                )
            if h["aisle"] or h["price"] is not None:
                conn.execute(
                    """
                    UPDATE shopping_list_items
                    SET aisle = COALESCE(NULLIF(?, ''), aisle),
                        price = COALESCE(?, price)
                    WHERE item_key = ? AND checked = 0
                      AND list_id IN (SELECT id FROM shopping_lists WHERE store_id = ?)
                    """,
                    (h["aisle"], h["price"], h["item_key"], store_id),
                )
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))

    return {
        "ok": True,
        "synced_count": synced_count,
        "total_checked": len(targets),
        "location_name": loc_name,
    }


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
                detail="Configure Kroger API credentials & link a Kroger store Location (in Stores → Store Settings) first.",
            )
        items = conn.execute(
            "SELECT * FROM shopping_list_items WHERE list_id = ? AND checked = 0",
            (list_id,),
        ).fetchall()
        pref_rows = conn.execute(
            "SELECT item_key, upc FROM kroger_product_prefs WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
        prefs_map = {r["item_key"]: r["upc"] for r in pref_rows}

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    sem = asyncio.Semaphore(5)

    async def _preview_one(client: httpx.AsyncClient, item) -> dict:
        clean_term, _ = clean_shopping_item_name(item["name"])
        search_term = clean_term or item["name"]
        pref_upc = prefs_map.get(item["item_key"])
        candidates: list[dict] = []
        seen_upcs: set[str] = set()
        async with sem:
            if pref_upc:
                pref_hit = await _fetch_kroger_by_upc(client, token, pref_upc, loc_id)
                if pref_hit:
                    pref_hit["is_preferred"] = True
                    candidates.append(pref_hit)
                    seen_upcs.add(pref_hit["upc"])
            searched = await _search_kroger_candidates(
                client, token, search_term, loc_id, limit=6, department=item["department"] or ""
            )
            for s in searched:
                if s["upc"] not in seen_upcs:
                    s["is_preferred"] = False
                    candidates.append(s)
                    seen_upcs.add(s["upc"])
        return {
            "list_item_id": item["id"],
            "item_key": item["item_key"],
            "list_item_name": item["name"],
            "department": item["department"] or "",
            "search_term": search_term,
            "quantity": max(1, int(math.ceil(float(item["buy_qty"] or 1)))),
            "buy_unit": item["buy_unit"],
            "candidates": candidates,
            "selected_upc": candidates[0]["upc"] if candidates else "",
        }

    async with httpx.AsyncClient(timeout=15.0) as client:
        previews = await asyncio.gather(*(_preview_one(client, it) for it in items))

    return {
        "location_id": loc_id,
        "location_name": loc_name,
        "items": list(previews),
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
        elif not loc_id:
            loc_id = (cfg.get("location_id") or "").strip()
            loc_name = (cfg.get("location_name") or "").strip()
        if loc_id and not loc_name:
            loc_name = (cfg.get("location_name") or "").strip()

        if not cfg["client_id"] or not cfg["client_secret"] or not loc_id:
            raise HTTPException(
                status_code=400,
                detail="Configure Kroger API credentials & link a Kroger store Location (in Stores → Store Settings) first.",
            )

    token = await _get_client_credentials_token(cfg["client_id"], cfg["client_secret"])
    async with httpx.AsyncClient(timeout=15.0) as client:
        candidates = await _search_kroger_candidates(
            client,
            token,
            search_term,
            loc_id,
            limit=payload.limit,
            department=payload.department,
        )

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
