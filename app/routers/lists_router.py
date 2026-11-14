import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, utc_now_iso
from app.database import GROCERY_DEPARTMENTS, get_db
from app.units import match_catalog_item, normalize_item_key, parse_ingredient_line

router = APIRouter(prefix="/api/lists", tags=["lists"])


class CreateListPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    list_type: str = "one_off"  # weekly | one_off | store
    store_id: Optional[int] = None
    position: Optional[int] = None


class UpdateListPayload(BaseModel):
    name: Optional[str] = None
    list_type: Optional[str] = None
    store_id: Optional[int] = None
    is_archived: Optional[bool] = None
    position: Optional[int] = None


class ListReorderPayload(BaseModel):
    list_ids: list[int]


class TemplateItemPayload(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    buy_qty: float = Field(default=1.0, gt=0)
    buy_unit: str = ""
    department: str = "Produce"
    notes: str = ""
    is_active: bool = True


class TemplateItemUpdatePayload(BaseModel):
    name: Optional[str] = None
    buy_qty: Optional[float] = None
    buy_unit: Optional[str] = None
    department: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class ApplyTemplatePayload(BaseModel):
    item_ids: Optional[list[int]] = None


class AddListItemPayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    buy_qty: Optional[float] = None
    buy_unit: str = ""
    department: str = ""
    aisle: str = ""
    notes: str = ""
    save_to_store: bool = True


class UpdateListItemPayload(BaseModel):
    name: Optional[str] = None
    buy_qty: Optional[float] = None
    buy_unit: Optional[str] = None
    department: Optional[str] = None
    aisle: Optional[str] = None
    notes: Optional[str] = None
    checked: Optional[bool] = None
    save_to_store: bool = True


def natural_sort_key(text: str) -> tuple:
    if not text:
        return (1, ())
    parts = re.split(r"(\d+)", text.strip().lower())
    key = tuple((0, int(p)) if p.isdigit() else (1, p) for p in parts if p)
    return (0, key)


def resolve_store_department(raw_dept: str, store_departments: list[str]) -> str:
    if not store_departments:
        return raw_dept or "Other"
    if not raw_dept:
        return "Other" if "Other" in store_departments else store_departments[-1]
    if raw_dept in store_departments:
        return raw_dept
    rl = raw_dept.lower()
    for d in store_departments:
        if d.lower() == rl:
            return d
    # Fuzzy keyword bridge across store chains (e.g. Kroger "Bakery & Deli" <-> Publix "Deli & Bakery" <-> Costco "Bakery")
    tokens = [t for t in re.split(r"[^a-z]+", rl) if len(t) >= 4 and t != "goods"]
    for d in store_departments:
        dl = d.lower()
        if any(tok in dl for tok in tokens):
            return d
    if "dry" in rl:
        for d in store_departments:
            if "dry" in d.lower() or "center" in d.lower() or "pantry" in d.lower():
                return d
    return "Other" if "Other" in store_departments else store_departments[-1]


def build_list_response(conn, list_row) -> dict:
    store = None
    store_depts = list(GROCERY_DEPARTMENTS)
    aisle_depts = ["Dry Goods", "Beverages", "Household & Personal"]
    if list_row["store_id"]:
        srow = conn.execute("SELECT * FROM stores WHERE id = ?", (list_row["store_id"],)).fetchone()
        if srow:
            store_depts = json.loads(srow["departments_json"] or "[]") or list(GROCERY_DEPARTMENTS)
            aisle_depts = json.loads(srow["aisle_departments_json"] or "[]")
            store = {
                "id": srow["id"],
                "name": srow["name"],
                "store_type": srow["store_type"],
                "chain": srow["chain"],
                "departments": store_depts,
                "aisle_departments": aisle_depts,
            }

    loc_map = {}
    if store:
        loc_rows = conn.execute(
            "SELECT * FROM item_store_locations WHERE store_id = ?",
            (store["id"],),
        ).fetchall()
        loc_map = {r["item_key"]: dict(r) for r in loc_rows}

    catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
    dept_order = {d: idx for idx, d in enumerate(store_depts)}

    item_rows = conn.execute(
        """
        SELECT sli.*, u1.display_name AS added_by_name, u2.display_name AS checked_by_name
        FROM shopping_list_items sli
        LEFT JOIN users u1 ON u1.id = sli.added_by
        LEFT JOIN users u2 ON u2.id = sli.checked_by
        WHERE sli.list_id = ?
        """,
        (list_row["id"],),
    ).fetchall()

    enriched = []
    for r in item_rows:
        loc = loc_map.get(r["item_key"])
        if loc:
            eff_dept = resolve_store_department(loc["department"], store_depts)
            eff_aisle = loc["aisle"]
        else:
            raw_dept = r["department"]
            if not raw_dept:
                cat = match_catalog_item(r["name"], catalog_rows)
                raw_dept = cat["default_department"] if cat else "Other"
            eff_dept = resolve_store_department(raw_dept, store_depts)
            eff_aisle = r["aisle"]

        enriched.append(
            {
                "id": r["id"],
                "list_id": r["list_id"],
                "name": r["name"],
                "item_key": r["item_key"],
                "buy_qty": r["buy_qty"],
                "buy_unit": r["buy_unit"],
                "needed_summary": r["needed_summary"],
                "department": eff_dept,
                "aisle": eff_aisle,
                "source_recipes": json.loads(r["source_recipes_json"] or "[]"),
                "notes": r["notes"],
                "checked": bool(r["checked"]),
                "checked_by_name": r["checked_by_name"] or "",
                "checked_at": r["checked_at"],
                "added_by_name": r["added_by_name"] or "",
                "created_at": r["created_at"],
            }
        )

    enriched.sort(
        key=lambda item: (
            1 if item["checked"] else 0,
            dept_order.get(item["department"], 999),
            natural_sort_key(item["aisle"]),
            item["name"].lower(),
        )
    )

    unchecked_count = sum(1 for i in enriched if not i["checked"])
    checked_count = len(enriched) - unchecked_count

    return {
        "id": list_row["id"],
        "name": list_row["name"],
        "list_type": list_row["list_type"],
        "store_id": list_row["store_id"],
        "store": store,
        "is_archived": bool(list_row["is_archived"]),
        "created_at": list_row["created_at"],
        "updated_at": list_row["updated_at"],
        "unchecked_count": unchecked_count,
        "checked_count": checked_count,
        "items": enriched,
    }


@router.get("")
def list_shopping_lists(include_archived: bool = False, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        query = """
            SELECT sl.*, s.name AS store_name, s.store_type AS store_type,
                   SUM(CASE WHEN sli.checked = 0 THEN 1 ELSE 0 END) AS unchecked_count,
                   SUM(CASE WHEN sli.checked = 1 THEN 1 ELSE 0 END) AS checked_count
            FROM shopping_lists sl
            LEFT JOIN stores s ON s.id = sl.store_id
            LEFT JOIN shopping_list_items sli ON sli.list_id = sl.id
        """
        if not include_archived:
            query += " WHERE sl.is_archived = 0 "
        query += """
            GROUP BY sl.id
            ORDER BY sl.sort_order ASC, CASE sl.list_type WHEN 'weekly' THEN 0 WHEN 'store' THEN 1 ELSE 2 END, sl.id ASC
        """
        rows = conn.execute(query).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "list_type": r["list_type"],
            "store_id": r["store_id"],
            "store_name": r["store_name"] or "",
            "store_type": r["store_type"] or "grocery",
            "is_archived": bool(r["is_archived"]),
            "sort_order": r["sort_order"],
            "unchecked_count": r["unchecked_count"] or 0,
            "checked_count": r["checked_count"] or 0,
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


@router.post("/reorder")
def reorder_shopping_lists(payload: ListReorderPayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        for idx, lid in enumerate(payload.list_ids, start=1):
            conn.execute("UPDATE shopping_lists SET sort_order = ? WHERE id = ?", (idx, lid))
    return list_shopping_lists(False, user)


@router.get("/template/items")
def get_template_items(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM weekly_template_items ORDER BY sort_order ASC, id ASC"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "item_key": r["item_key"],
            "buy_qty": r["buy_qty"],
            "buy_unit": r["buy_unit"],
            "department": r["department"],
            "notes": r["notes"],
            "is_active": bool(r["is_active"]),
            "sort_order": r["sort_order"],
        }
        for r in rows
    ]


@router.post("/template/items")
def add_template_item(payload: TemplateItemPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        cat = match_catalog_item(payload.name, catalog_rows)
        ikey = cat["canonical_name"] if cat else normalize_item_key(payload.name)
        unit = payload.buy_unit.strip() or (cat["package_label"] if cat else "")
        dept = payload.department.strip() or (cat["default_department"] if cat else "Produce")
        max_ord = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM weekly_template_items").fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO weekly_template_items (name, item_key, buy_qty, buy_unit, department, notes, is_active, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.name.strip(),
                ikey,
                payload.buy_qty,
                unit,
                dept,
                payload.notes.strip(),
                1 if payload.is_active else 0,
                max_ord + 1,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM weekly_template_items WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


@router.patch("/template/items/{tpl_id}")
def update_template_item(tpl_id: int, payload: TemplateItemUpdatePayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM weekly_template_items WHERE id = ?", (tpl_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template item not found")
        name = payload.name.strip() if payload.name is not None else row["name"]
        ikey = normalize_item_key(name) if payload.name is not None else row["item_key"]
        qty = payload.buy_qty if payload.buy_qty is not None else row["buy_qty"]
        unit = payload.buy_unit.strip() if payload.buy_unit is not None else row["buy_unit"]
        dept = payload.department.strip() if payload.department is not None else row["department"]
        notes = payload.notes.strip() if payload.notes is not None else row["notes"]
        act = (1 if payload.is_active else 0) if payload.is_active is not None else row["is_active"]
        conn.execute(
            """
            UPDATE weekly_template_items
            SET name = ?, item_key = ?, buy_qty = ?, buy_unit = ?, department = ?, notes = ?, is_active = ?
            WHERE id = ?
            """,
            (name, ikey, qty, unit, dept, notes, act, tpl_id),
        )
        updated = conn.execute("SELECT * FROM weekly_template_items WHERE id = ?", (tpl_id,)).fetchone()
    return dict(updated)


@router.delete("/template/items/{tpl_id}")
def delete_template_item(tpl_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM weekly_template_items WHERE id = ?", (tpl_id,))
    return {"ok": True}


@router.get("/suggestions")
def suggest_items(q: str = "", store_id: Optional[int] = None, user: dict = Depends(get_current_user)):
    ql = q.strip().lower()
    seen = {}
    with get_db() as conn:
        if store_id:
            locs = conn.execute(
                "SELECT item_key, item_display, department, aisle FROM item_store_locations WHERE store_id = ?",
                (store_id,),
            ).fetchall()
            for loc in locs:
                if not ql or ql in loc["item_display"].lower() or ql in loc["item_key"]:
                    seen[loc["item_key"]] = {
                        "item_key": loc["item_key"],
                        "name": loc["item_display"],
                        "department": loc["department"],
                        "aisle": loc["aisle"],
                        "buy_unit": "",
                    }

        cats = conn.execute("SELECT * FROM product_catalog").fetchall()
        for c in cats:
            aliases = json.loads(c["aliases_json"] or "[]")
            if not ql or ql in c["display_name"].lower() or ql in c["canonical_name"] or any(ql in a for a in aliases):
                if c["canonical_name"] not in seen:
                    seen[c["canonical_name"]] = {
                        "item_key": c["canonical_name"],
                        "name": c["display_name"],
                        "department": c["default_department"],
                        "aisle": "",
                        "buy_unit": c["package_label"],
                    }
                elif not seen[c["canonical_name"]]["buy_unit"]:
                    seen[c["canonical_name"]]["buy_unit"] = c["package_label"]

    results = list(seen.values())
    results.sort(key=lambda x: (0 if x["aisle"] else 1, x["name"].lower()))
    return results[:12]


def _reposition_list(conn, list_id: int, target_pos_1based: int):
    rows = conn.execute(
        "SELECT id FROM shopping_lists WHERE is_archived = 0 ORDER BY sort_order ASC, id ASC"
    ).fetchall()
    ordered_ids = [r["id"] for r in rows if r["id"] != list_id]
    idx = max(0, min(len(ordered_ids), target_pos_1based - 1))
    ordered_ids.insert(idx, list_id)
    for order_idx, lid in enumerate(ordered_ids, start=1):
        conn.execute("UPDATE shopping_lists SET sort_order = ? WHERE id = ?", (order_idx, lid))


@router.post("")
def create_shopping_list(payload: CreateListPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        store_id = payload.store_id
        if store_id is None:
            default_store = conn.execute("SELECT id FROM stores WHERE is_default = 1 LIMIT 1").fetchone()
            store_id = default_store["id"] if default_store else None
        max_ord = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM shopping_lists").fetchone()[0]
        cur = conn.execute(
            """
            INSERT INTO shopping_lists (name, list_type, store_id, is_archived, sort_order, created_by, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?)
            """,
            (payload.name.strip(), payload.list_type, store_id, max_ord + 1, user["id"], now, now),
        )
        lid = cur.lastrowid
        if payload.position is not None:
            _reposition_list(conn, lid, payload.position)
        row = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (lid,)).fetchone()
        return build_list_response(conn, row)


@router.get("/{list_id}")
def get_shopping_list(list_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        return build_list_response(conn, row)


@router.patch("/{list_id}")
def update_shopping_list(list_id: int, payload: UpdateListPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        name = payload.name.strip() if payload.name is not None else row["name"]
        ltype = payload.list_type if payload.list_type is not None else row["list_type"]
        sid = payload.store_id if payload.store_id is not None else row["store_id"]
        arch = (1 if payload.is_archived else 0) if payload.is_archived is not None else row["is_archived"]
        conn.execute(
            """
            UPDATE shopping_lists
            SET name = ?, list_type = ?, store_id = ?, is_archived = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, ltype, sid, arch, now, list_id),
        )
        if payload.position is not None:
            _reposition_list(conn, list_id, payload.position)
        updated = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        return build_list_response(conn, updated)


@router.post("/{list_id}/apply-template")
def apply_weekly_template(
    list_id: int,
    payload: ApplyTemplatePayload = ApplyTemplatePayload(),
    user: dict = Depends(get_current_user),
):
    with get_db() as conn:
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")
        if payload.item_ids is not None:
            if not payload.item_ids:
                return build_list_response(conn, lst)
            placeholders = ",".join("?" for _ in payload.item_ids)
            tpl_rows = conn.execute(
                f"SELECT * FROM weekly_template_items WHERE id IN ({placeholders}) ORDER BY sort_order ASC, id ASC",
                tuple(payload.item_ids),
            ).fetchall()
        else:
            tpl_rows = conn.execute(
                "SELECT * FROM weekly_template_items WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
            ).fetchall()

        for t in tpl_rows:
            add_item_to_list_internal(
                conn,
                list_id,
                AddListItemPayload(
                    name=t["name"],
                    buy_qty=t["buy_qty"],
                    buy_unit=t["buy_unit"],
                    department=t["department"],
                    notes=t["notes"] or "Weekly staple",
                    save_to_store=False,
                ),
                user["id"],
            )
        updated = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        return build_list_response(conn, updated)


@router.delete("/{list_id}")
def delete_shopping_list(list_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM shopping_lists WHERE id = ?", (list_id,))
    return {"ok": True}


def add_item_to_list_internal(conn, list_id: int, payload: AddListItemPayload, user_id: Optional[int]) -> dict:
    now = utc_now_iso()
    lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
    if not lst:
        raise HTTPException(status_code=404, detail="Shopping list not found")

    raw_name = payload.name.strip()
    buy_qty = payload.buy_qty
    buy_unit = payload.buy_unit.strip()
    clean_name = raw_name

    # If user typed "2 bananas" or "3 bags chips" into quick add, parse leading quantity
    if buy_qty is None:
        parsed = parse_ingredient_line(raw_name)
        if parsed["quantity"] is not None and parsed["name"]:
            buy_qty = parsed["quantity"]
            if not buy_unit and parsed["unit"]:
                buy_unit = parsed["unit"]
            clean_name = parsed["name"]
        else:
            buy_qty = 1.0

    catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
    cat = match_catalog_item(clean_name, catalog_rows)
    if cat:
        ikey = cat["canonical_name"]
        display_name = clean_name if len(clean_name) > len(cat["display_name"]) else cat["display_name"]
        default_dept = cat["default_department"]
        if not buy_unit:
            buy_unit = cat["package_label"]
    else:
        ikey = normalize_item_key(clean_name)
        display_name = clean_name[:1].upper() + clean_name[1:] if clean_name else raw_name
        default_dept = "Other"

    dept = payload.department.strip() or default_dept
    aisle = payload.aisle.strip()

    # Check if there is an existing store location
    if lst["store_id"] and (not payload.department.strip() or not aisle):
        loc = conn.execute(
            "SELECT * FROM item_store_locations WHERE store_id = ? AND item_key = ?",
            (lst["store_id"], ikey),
        ).fetchone()
        if loc:
            if not payload.department.strip():
                dept = loc["department"]
            if not aisle:
                aisle = loc["aisle"]

    # Save store location if user provided explicit department/aisle
    if lst["store_id"] and payload.save_to_store and (payload.department.strip() or payload.aisle.strip()):
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
            (ikey, display_name, lst["store_id"], dept, aisle, now),
        )

    # Merge if already unchecked on this list
    existing = conn.execute(
        "SELECT * FROM shopping_list_items WHERE list_id = ? AND item_key = ? AND checked = 0 LIMIT 1",
        (list_id, ikey),
    ).fetchone()
    if existing:
        new_qty = round(existing["buy_qty"] + buy_qty, 2)
        conn.execute(
            "UPDATE shopping_list_items SET buy_qty = ?, notes = COALESCE(NULLIF(?, ''), notes) WHERE id = ?",
            (new_qty, payload.notes.strip(), existing["id"]),
        )
    else:
        conn.execute(
            """
            INSERT INTO shopping_list_items (
                list_id, name, item_key, buy_qty, buy_unit, needed_summary,
                department, aisle, source_recipes_json, notes, checked, added_by, created_at
            ) VALUES (?, ?, ?, ?, ?, '', ?, ?, '[]', ?, 0, ?, ?)
            """,
            (
                list_id,
                display_name,
                ikey,
                buy_qty,
                buy_unit,
                dept,
                aisle,
                payload.notes.strip(),
                user_id,
                now,
            ),
        )

    conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
    updated_list = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
    return build_list_response(conn, updated_list)


@router.post("/{list_id}/items")
def add_list_item(list_id: int, payload: AddListItemPayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        return add_item_to_list_internal(conn, list_id, payload, user["id"])


@router.patch("/{list_id}/items/{item_id}")
def update_list_item(
    list_id: int,
    item_id: int,
    payload: UpdateListItemPayload,
    user: dict = Depends(get_current_user),
):
    now = utc_now_iso()
    with get_db() as conn:
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        item = conn.execute(
            "SELECT * FROM shopping_list_items WHERE id = ? AND list_id = ?",
            (item_id, list_id),
        ).fetchone()
        if not lst or not item:
            raise HTTPException(status_code=404, detail="Item not found")

        name = payload.name.strip() if payload.name is not None else item["name"]
        ikey = normalize_item_key(name) if payload.name is not None else item["item_key"]
        buy_qty = payload.buy_qty if payload.buy_qty is not None else item["buy_qty"]
        buy_unit = payload.buy_unit.strip() if payload.buy_unit is not None else item["buy_unit"]
        dept = payload.department.strip() if payload.department is not None else item["department"]
        aisle = payload.aisle.strip() if payload.aisle is not None else item["aisle"]
        notes = payload.notes.strip() if payload.notes is not None else item["notes"]

        checked = item["checked"]
        checked_by = item["checked_by"]
        checked_at = item["checked_at"]
        if payload.checked is not None:
            checked = 1 if payload.checked else 0
            if payload.checked:
                checked_by = user["id"]
                checked_at = now
            else:
                checked_by = None
                checked_at = None

        conn.execute(
            """
            UPDATE shopping_list_items
            SET name = ?, item_key = ?, buy_qty = ?, buy_unit = ?,
                department = ?, aisle = ?, notes = ?, checked = ?, checked_by = ?, checked_at = ?
            WHERE id = ?
            """,
            (name, ikey, buy_qty, buy_unit, dept, aisle, notes, checked, checked_by, checked_at, item_id),
        )

        # Persist department & aisle for this exact store!
        if lst["store_id"] and payload.save_to_store and (payload.department is not None or payload.aisle is not None):
            eff_dept = dept or "Dry Goods"
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
                (ikey, name, lst["store_id"], eff_dept, aisle, now),
            )

        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
        updated_list = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        return build_list_response(conn, updated_list)


@router.delete("/{list_id}/items/{item_id}")
def delete_list_item(list_id: int, item_id: int, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        conn.execute("DELETE FROM shopping_list_items WHERE id = ? AND list_id = ?", (item_id, list_id))
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
        updated_list = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not updated_list:
            raise HTTPException(status_code=404, detail="List not found")
        return build_list_response(conn, updated_list)


@router.post("/{list_id}/clear-checked")
def clear_checked_items(list_id: int, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        conn.execute("DELETE FROM shopping_list_items WHERE list_id = ? AND checked = 1", (list_id,))
        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, list_id))
        updated_list = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not updated_list:
            raise HTTPException(status_code=404, detail="List not found")
        return build_list_response(conn, updated_list)
