import html
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, require_non_guest, utc_now_iso
from app.database import GROCERY_AISLE_DEPTS, GROCERY_DEPARTMENTS, get_db
from app.units import normalize_item_key

router = APIRouter(prefix="/api/stores", tags=["stores"])


class StorePayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    store_type: str = "grocery"
    chain: str = ""
    departments: list[str] = Field(default_factory=lambda: list(GROCERY_DEPARTMENTS))
    aisle_departments: list[str] = Field(default_factory=lambda: list(GROCERY_AISLE_DEPTS))
    clone_locations_from_store_id: Optional[int] = None
    position: Optional[int] = None  # 1-based position in top bar


class StoreUpdatePayload(BaseModel):
    name: Optional[str] = None
    store_type: Optional[str] = None
    chain: Optional[str] = None
    departments: Optional[list[str]] = None
    aisle_departments: Optional[list[str]] = None
    position: Optional[int] = None  # 1-based position in top bar


class StoreReorderPayload(BaseModel):
    store_ids: list[int]


class LocationUpsertPayload(BaseModel):
    item_key: str = ""
    item_display: str = Field(min_length=1, max_length=150)
    department: str = Field(min_length=1, max_length=100)
    aisle: str = ""


class WalkingPathPayload(BaseModel):
    departments: Optional[list[str]] = None
    reverse: bool = False


def _merge_custom_path(custom_depts: list[str], base_depts: list[str]) -> list[str]:
    base_map = {d.lower(): d for d in base_depts}
    seen: set[str] = set()
    merged: list[str] = []
    for d in custom_depts:
        canonical = base_map.get(d.lower())
        if canonical and canonical.lower() not in seen:
            seen.add(canonical.lower())
            merged.append(canonical)
    for d in base_depts:
        if d.lower() not in seen:
            seen.add(d.lower())
            merged.append(d)
    return merged


def get_effective_store_departments(conn, store_row, user_id: Optional[int]) -> tuple[list[str], list[str], bool]:
    raw_depts = json.loads(store_row["departments_json"] or "[]")
    base_depts = [html.unescape(d).strip() for d in raw_depts if d and d.strip()]
    if user_id is None:
        return base_depts, base_depts, False
    path_row = conn.execute(
        "SELECT departments_json FROM user_store_paths WHERE user_id = ? AND store_id = ?",
        (user_id, store_row["id"]),
    ).fetchone()
    if not path_row:
        return base_depts, base_depts, False
    raw_custom = json.loads(path_row["departments_json"] or "[]")
    custom_depts = [html.unescape(d).strip() for d in raw_custom if d and d.strip()]
    if not custom_depts:
        return base_depts, base_depts, False
    return _merge_custom_path(custom_depts, base_depts), base_depts, True


def _serialize_store(conn, row, user_id: Optional[int] = None) -> dict:
    effective_depts, base_depts, has_custom = get_effective_store_departments(conn, row, user_id)
    raw_adepts = json.loads(row["aisle_departments_json"] or "[]")
    return {
        "id": row["id"],
        "name": row["name"],
        "store_type": row["store_type"],
        "chain": row["chain"],
        "departments": effective_depts,
        "shared_departments": base_depts,
        "has_custom_path": has_custom,
        "aisle_departments": [html.unescape(d).strip() for d in raw_adepts if d and d.strip()],
        "is_default": bool(row["is_default"]),
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
    }


def _reposition_store(conn, store_id: int, target_pos_1based: int):
    rows = conn.execute("SELECT id FROM stores ORDER BY sort_order ASC, id ASC").fetchall()
    ordered_ids = [r["id"] for r in rows if r["id"] != store_id]
    idx = max(0, min(len(ordered_ids), target_pos_1based - 1))
    ordered_ids.insert(idx, store_id)
    for order_idx, sid in enumerate(ordered_ids, start=1):
        conn.execute("UPDATE stores SET sort_order = ? WHERE id = ?", (order_idx, sid))


@router.get("")
def list_stores(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM stores ORDER BY sort_order ASC, id ASC").fetchall()
        return [_serialize_store(conn, r, user["id"]) for r in rows]


@router.post("/reorder")
def reorder_stores(payload: StoreReorderPayload, user: dict = Depends(require_non_guest)):
    with get_db() as conn:
        for idx, sid in enumerate(payload.store_ids, start=1):
            conn.execute("UPDATE stores SET sort_order = ? WHERE id = ?", (idx, sid))
        rows = conn.execute("SELECT * FROM stores ORDER BY sort_order ASC, id ASC").fetchall()
        return [_serialize_store(conn, r, user["id"]) for r in rows]


@router.post("")
def create_store(payload: StorePayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    depts = [html.unescape(d).strip() for d in payload.departments if d.strip()] or list(GROCERY_DEPARTMENTS)
    aisle_depts = [html.unescape(d).strip() for d in payload.aisle_departments if d.strip()]
    with get_db() as conn:
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM stores").fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO stores (name, store_type, chain, departments_json, aisle_departments_json, is_default, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                payload.name.strip(),
                payload.store_type.strip() or "grocery",
                payload.chain.strip() or payload.name.strip(),
                json.dumps(depts),
                json.dumps(aisle_depts),
                max_order + 1,
                now,
            ),
        )
        sid = cur.lastrowid
        if payload.position is not None:
            _reposition_store(conn, sid, payload.position)
        if payload.clone_locations_from_store_id:
            src_locs = conn.execute(
                "SELECT item_key, item_display, department, aisle FROM item_store_locations WHERE store_id = ?",
                (payload.clone_locations_from_store_id,),
            ).fetchall()
            for loc in src_locs:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO item_store_locations (item_key, item_display, store_id, department, aisle, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (loc["item_key"], loc["item_display"], sid, loc["department"], loc["aisle"], now),
                )
        row = conn.execute("SELECT * FROM stores WHERE id = ?", (sid,)).fetchone()
        return _serialize_store(conn, row, user["id"])


@router.put("/{store_id}/walking-path")
def update_user_walking_path(store_id: int, payload: WalkingPathPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Store not found")
        effective_depts, base_depts, _ = get_effective_store_departments(conn, row, user["id"])
        if payload.reverse:
            target = list(reversed(effective_depts))
        elif payload.departments is not None:
            clean_req = [html.unescape(d).strip() for d in payload.departments if d and d.strip()]
            target = _merge_custom_path(clean_req, base_depts)
        else:
            target = effective_depts
        conn.execute(
            """
            INSERT INTO user_store_paths (user_id, store_id, departments_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, store_id) DO UPDATE SET
                departments_json = excluded.departments_json,
                updated_at = excluded.updated_at
            """,
            (user["id"], store_id, json.dumps(target), now),
        )
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))
        updated = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        return _serialize_store(conn, updated, user["id"])


@router.delete("/{store_id}/walking-path")
def reset_user_walking_path(store_id: int, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Store not found")
        conn.execute(
            "DELETE FROM user_store_paths WHERE user_id = ? AND store_id = ?",
            (user["id"], store_id),
        )
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))
        updated = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        return _serialize_store(conn, updated, user["id"])


@router.put("/{store_id}")
def update_store(store_id: int, payload: StoreUpdatePayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Store not found")
        name = payload.name.strip() if payload.name is not None else row["name"]
        stype = payload.store_type.strip() if payload.store_type is not None else row["store_type"]
        chain = payload.chain.strip() if payload.chain is not None else row["chain"]
        depts = (
            json.dumps([html.unescape(d).strip() for d in payload.departments if d.strip()])
            if payload.departments is not None
            else row["departments_json"]
        )
        adepts = (
            json.dumps([html.unescape(d).strip() for d in payload.aisle_departments if d.strip()])
            if payload.aisle_departments is not None
            else row["aisle_departments_json"]
        )
        conn.execute(
            """
            UPDATE stores
            SET name = ?, store_type = ?, chain = ?, departments_json = ?, aisle_departments_json = ?
            WHERE id = ?
            """,
            (name, stype, chain, depts, adepts, store_id),
        )
        if payload.position is not None:
            _reposition_store(conn, store_id, payload.position)
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))
        updated = conn.execute("SELECT * FROM stores WHERE id = ?", (store_id,)).fetchone()
        return _serialize_store(conn, updated, user["id"])


@router.delete("/{store_id}")
def delete_store(store_id: int, user: dict = Depends(require_non_guest)):
    with get_db() as conn:
        conn.execute("DELETE FROM stores WHERE id = ?", (store_id,))
    return {"ok": True}


@router.get("/{store_id}/locations")
def list_store_locations(store_id: int, q: str = "", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        store = conn.execute("SELECT id FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not store:
            raise HTTPException(status_code=404, detail="Store not found")
        rows = conn.execute(
            "SELECT * FROM item_store_locations WHERE store_id = ? ORDER BY department ASC, aisle ASC, item_display ASC",
            (store_id,),
        ).fetchall()
    items = [dict(r) for r in rows]
    if q.strip():
        ql = q.strip().lower()
        items = [i for i in items if ql in i["item_display"].lower() or ql in i["aisle"].lower() or ql in i["department"].lower()]
    return items


@router.put("/{store_id}/locations")
def upsert_store_location(store_id: int, payload: LocationUpsertPayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    ikey = normalize_item_key(payload.item_key or payload.item_display)
    if not ikey:
        raise HTTPException(status_code=400, detail="Item name is required")
    with get_db() as conn:
        store = conn.execute("SELECT id FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not store:
            raise HTTPException(status_code=404, detail="Store not found")
        conn.execute(
            """
            INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_key, store_id) DO UPDATE SET
                item_display = excluded.item_display,
                department = excluded.department,
                aisle = excluded.aisle,
                updated_at = excluded.updated_at
            """,
            (ikey, payload.item_display.strip(), store_id, html.unescape(payload.department).strip(), payload.aisle.strip(), now),
        )
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))
        row = conn.execute(
            "SELECT * FROM item_store_locations WHERE store_id = ? AND item_key = ?",
            (store_id, ikey),
        ).fetchone()
    return dict(row)


@router.delete("/{store_id}/locations/{loc_id}")
def delete_store_location(store_id: int, loc_id: int, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        conn.execute("DELETE FROM item_store_locations WHERE id = ? AND store_id = ?", (loc_id, store_id))
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE store_id = ?", (now, store_id))
    return {"ok": True}
