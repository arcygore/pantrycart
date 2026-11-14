import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, utc_now_iso
from app.database import get_db
from app.units import compute_grocery_packages, normalize_item_key

router = APIRouter(prefix="/api/planner", tags=["planner"])


class MealPlanAddPayload(BaseModel):
    recipe_id: int
    scale: float = Field(default=1.0, gt=0, le=20)
    day_label: str = ""
    notes: str = ""


class MealPlanUpdatePayload(BaseModel):
    scale: Optional[float] = Field(default=None, gt=0, le=20)
    day_label: Optional[str] = None
    notes: Optional[str] = None


class GeneratedItemInput(BaseModel):
    item_key: str
    name: str
    buy_qty: float = Field(gt=0)
    buy_unit: str = ""
    needed_summary: str = ""
    department: str = ""
    source_recipes: list[str] = Field(default_factory=list)


class ApplyPlanPayload(BaseModel):
    list_id: int
    items: list[GeneratedItemInput]
    clear_plan_after: bool = False


@router.get("")
def get_meal_plan(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT mp.id, mp.recipe_id, mp.scale, mp.day_label, mp.notes, mp.created_at,
                   r.title, r.servings, r.prep_minutes, r.cook_minutes, r.tags_json, r.image_url,
                   u.display_name AS added_by_name
            FROM meal_plan_items mp
            JOIN recipes r ON r.id = mp.recipe_id
            LEFT JOIN users u ON u.id = mp.added_by
            ORDER BY mp.id ASC
            """
        ).fetchall()
    return [
        {
            "id": r["id"],
            "recipe_id": r["recipe_id"],
            "scale": r["scale"],
            "day_label": r["day_label"],
            "notes": r["notes"],
            "created_at": r["created_at"],
            "title": r["title"],
            "image_url": r["image_url"] or "",
            "base_servings": r["servings"],
            "effective_servings": round(r["servings"] * r["scale"], 1),
            "prep_minutes": r["prep_minutes"],
            "cook_minutes": r["cook_minutes"],
            "tags": json.loads(r["tags_json"] or "[]"),
            "added_by_name": r["added_by_name"] or "",
        }
        for r in rows
    ]


@router.post("")
def add_to_meal_plan(payload: MealPlanAddPayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        recipe = conn.execute("SELECT id FROM recipes WHERE id = ?", (payload.recipe_id,)).fetchone()
        if not recipe:
            raise HTTPException(status_code=404, detail="Recipe not found")
        cur = conn.execute(
            """
            INSERT INTO meal_plan_items (recipe_id, scale, day_label, notes, added_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.recipe_id,
                payload.scale,
                payload.day_label.strip(),
                payload.notes.strip(),
                user["id"],
                utc_now_iso(),
            ),
        )
        return {"id": cur.lastrowid}


@router.patch("/{plan_item_id}")
def update_meal_plan_item(plan_item_id: int, payload: MealPlanUpdatePayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meal_plan_items WHERE id = ?", (plan_item_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meal plan item not found")
        scale = payload.scale if payload.scale is not None else row["scale"]
        day_label = payload.day_label.strip() if payload.day_label is not None else row["day_label"]
        notes = payload.notes.strip() if payload.notes is not None else row["notes"]
        conn.execute(
            "UPDATE meal_plan_items SET scale = ?, day_label = ?, notes = ? WHERE id = ?",
            (scale, day_label, notes, plan_item_id),
        )
    return {"ok": True}


@router.delete("/{plan_item_id}")
def remove_from_meal_plan(plan_item_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM meal_plan_items WHERE id = ?", (plan_item_id,))
    return {"ok": True}


@router.delete("")
def clear_meal_plan(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM meal_plan_items")
    return {"ok": True}


@router.post("/preview-list")
def preview_shopping_list(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        plan_rows = conn.execute(
            """
            SELECT mp.id, mp.recipe_id, mp.scale, r.title
            FROM meal_plan_items mp
            JOIN recipes r ON r.id = mp.recipe_id
            """
        ).fetchall()
        if not plan_rows:
            return []

        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        pantry_rows = conn.execute("SELECT item_key FROM pantry_items WHERE in_stock = 1").fetchall()
        in_stock_pantry = {r["item_key"] for r in pantry_rows}
        entries = []
        for p in plan_rows:
            ings = conn.execute(
                "SELECT * FROM recipe_ingredients WHERE recipe_id = ?",
                (p["recipe_id"],),
            ).fetchall()
            for ing in ings:
                scaled_qty = (ing["quantity"] * p["scale"]) if ing["quantity"] is not None else None
                entries.append(
                    {
                        "name": ing["name"],
                        "quantity": scaled_qty,
                        "unit": ing["unit"],
                        "recipe_title": p["title"],
                        "catalog_id": ing["catalog_id"],
                    }
                )

    return compute_grocery_packages(entries, catalog_rows, in_stock_pantry)


@router.post("/apply-to-list")
def apply_plan_to_list(payload: ApplyPlanPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        lst = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (payload.list_id,)).fetchone()
        if not lst:
            raise HTTPException(status_code=404, detail="Shopping list not found")

        added_count = 0
        merged_count = 0
        for item in payload.items:
            ikey = normalize_item_key(item.item_key or item.name)
            # If unchecked item with same key already exists on list, merge buy_qty and recipe tags
            existing = conn.execute(
                """
                SELECT * FROM shopping_list_items
                WHERE list_id = ? AND item_key = ? AND checked = 0
                LIMIT 1
                """,
                (payload.list_id, ikey),
            ).fetchone()

            if existing:
                old_recipes = json.loads(existing["source_recipes_json"] or "[]")
                for r in item.source_recipes:
                    if r not in old_recipes:
                        old_recipes.append(r)
                new_qty = round(existing["buy_qty"] + item.buy_qty, 2)
                conn.execute(
                    """
                    UPDATE shopping_list_items
                    SET buy_qty = ?, source_recipes_json = ?, needed_summary = ?
                    WHERE id = ?
                    """,
                    (
                        new_qty,
                        json.dumps(old_recipes),
                        item.needed_summary or existing["needed_summary"],
                        existing["id"],
                    ),
                )
                merged_count += 1
            else:
                conn.execute(
                    """
                    INSERT INTO shopping_list_items (
                        list_id, name, item_key, buy_qty, buy_unit, needed_summary,
                        department, aisle, source_recipes_json, notes, checked, added_by, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '', 0, ?, ?)
                    """,
                    (
                        payload.list_id,
                        item.name.strip(),
                        ikey,
                        item.buy_qty,
                        item.buy_unit.strip(),
                        item.needed_summary.strip(),
                        item.department.strip(),
                        json.dumps(item.source_recipes),
                        user["id"],
                        now,
                    ),
                )
                added_count += 1

        conn.execute("UPDATE shopping_lists SET updated_at = ? WHERE id = ?", (now, payload.list_id))
        if payload.clear_plan_after:
            conn.execute("DELETE FROM meal_plan_items")

    return {"added": added_count, "merged": merged_count}
