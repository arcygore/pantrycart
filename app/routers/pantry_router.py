from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, utc_now_iso
from app.database import get_db
from app.units import match_catalog_item, normalize_item_key

router = APIRouter(prefix="/api/pantry", tags=["pantry"])

PANTRY_CATEGORIES = [
    "Spices & Seasonings",
    "Canned & Jarred Goods",
    "Oils, Vinegars & Condiments",
    "Baking & Cooking Staples",
    "Grains, Pasta & Dry Goods",
    "Snacks & Other",
]


class PantryItemPayload(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    category: str = "Canned & Jarred Goods"
    quantity_note: str = "In Stock"
    in_stock: bool = True


class PantryUpdatePayload(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    quantity_note: Optional[str] = None
    in_stock: Optional[bool] = None


def _serialize_pantry(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "item_key": row["item_key"],
        "category": row["category"],
        "quantity_note": row["quantity_note"],
        "in_stock": bool(row["in_stock"]),
        "updated_at": row["updated_at"],
    }


@router.get("")
def list_pantry_items(category: str = "", q: str = "", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pantry_items ORDER BY category ASC, name ASC"
        ).fetchall()
    items = [_serialize_pantry(r) for r in rows]
    if category.strip():
        cl = category.strip().lower()
        items = [i for i in items if i["category"].lower() == cl]
    if q.strip():
        ql = q.strip().lower()
        items = [i for i in items if ql in i["name"].lower() or ql in i["category"].lower()]
    return {
        "categories": PANTRY_CATEGORIES,
        "items": items,
    }


@router.post("")
def create_pantry_item(payload: PantryItemPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        cat = match_catalog_item(payload.name, catalog_rows)
        ikey = cat["canonical_name"] if cat else normalize_item_key(payload.name)
        if not ikey:
            raise HTTPException(status_code=400, detail="Valid item name is required")
        conn.execute(
            """
            INSERT INTO pantry_items (name, item_key, category, quantity_note, in_stock, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_key) DO UPDATE SET
                name = excluded.name,
                category = excluded.category,
                quantity_note = excluded.quantity_note,
                in_stock = excluded.in_stock,
                updated_at = excluded.updated_at
            """,
            (
                payload.name.strip(),
                ikey,
                payload.category.strip() or "Canned & Jarred Goods",
                payload.quantity_note.strip() or ("In Stock" if payload.in_stock else "Out / Low"),
                1 if payload.in_stock else 0,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM pantry_items WHERE item_key = ?", (ikey,)).fetchone()
    return _serialize_pantry(row)


@router.patch("/{pantry_id}")
def update_pantry_item(pantry_id: int, payload: PantryUpdatePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM pantry_items WHERE id = ?", (pantry_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Pantry item not found")
        name = payload.name.strip() if payload.name is not None else row["name"]
        ikey = normalize_item_key(name) if payload.name is not None else row["item_key"]
        category = payload.category.strip() if payload.category is not None else row["category"]
        qnote = payload.quantity_note.strip() if payload.quantity_note is not None else row["quantity_note"]
        in_stock = (1 if payload.in_stock else 0) if payload.in_stock is not None else row["in_stock"]
        conn.execute(
            """
            UPDATE pantry_items
            SET name = ?, item_key = ?, category = ?, quantity_note = ?, in_stock = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, ikey, category, qnote, in_stock, now, pantry_id),
        )
        updated = conn.execute("SELECT * FROM pantry_items WHERE id = ?", (pantry_id,)).fetchone()
    return _serialize_pantry(updated)


@router.delete("/{pantry_id}")
def delete_pantry_item(pantry_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM pantry_items WHERE id = ?", (pantry_id,))
    return {"ok": True}
