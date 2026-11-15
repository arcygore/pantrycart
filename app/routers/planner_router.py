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


class CalendarSlotCreatePayload(BaseModel):
    day_name: str = Field(min_length=1, max_length=20)
    meal_slot: str = Field(default="Dinner", min_length=1, max_length=30)
    plan_item_id: Optional[int] = None
    custom_title: str = Field(default="", max_length=160)
    servings_used: float = Field(default=1.0, gt=0, le=50)
    person_name: str = Field(default="", max_length=60)
    notes: str = Field(default="", max_length=200)


class CalendarSlotUpdatePayload(BaseModel):
    day_name: Optional[str] = None
    meal_slot: Optional[str] = None
    servings_used: Optional[float] = Field(default=None, gt=0, le=50)
    person_name: Optional[str] = None
    custom_title: Optional[str] = None
    notes: Optional[str] = None


@router.get("")
def get_meal_plan(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT mp.id, mp.recipe_id, mp.scale, mp.day_label, mp.notes, mp.created_at,
                   r.title, r.servings, r.prep_minutes, r.cook_minutes, r.tags_json, r.image_url,
                   u.display_name AS added_by_name,
                   COALESCE((SELECT SUM(cs.servings_used) FROM meal_calendar_slots cs WHERE cs.plan_item_id = mp.id), 0.0) AS allocated_servings
            FROM meal_plan_items mp
            JOIN recipes r ON r.id = mp.recipe_id
            LEFT JOIN users u ON u.id = mp.added_by
            ORDER BY mp.id ASC
            """
        ).fetchall()
    result = []
    for r in rows:
        eff = round(r["servings"] * r["scale"], 1)
        alloc = round(float(r["allocated_servings"] or 0.0), 1)
        rem = max(0.0, round(eff - alloc, 1))
        result.append(
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
                "effective_servings": eff,
                "allocated_servings": alloc,
                "remaining_servings": rem,
                "prep_minutes": r["prep_minutes"],
                "cook_minutes": r["cook_minutes"],
                "tags": json.loads(r["tags_json"] or "[]"),
                "added_by_name": r["added_by_name"] or "",
            }
        )
    return result


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
        conn.execute("DELETE FROM meal_calendar_slots")
        conn.execute("DELETE FROM meal_plan_items")
    return {"ok": True}


@router.get("/calendar")
def get_calendar_data(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        slot_rows = conn.execute(
            """
            SELECT cs.id, cs.day_name, cs.meal_slot, cs.plan_item_id, cs.custom_title,
                   cs.servings_used, cs.person_name, cs.notes, cs.created_at,
                   r.id AS recipe_id, r.title AS recipe_title
            FROM meal_calendar_slots cs
            LEFT JOIN meal_plan_items mp ON mp.id = cs.plan_item_id
            LEFT JOIN recipes r ON r.id = mp.recipe_id
            ORDER BY cs.id ASC
            """
        ).fetchall()

        user_rows = conn.execute("SELECT display_name FROM users ORDER BY id ASC").fetchall()
        list_items = conn.execute(
            """
            SELECT DISTINCT name, department, buy_qty, buy_unit
            FROM shopping_list_items
            WHERE checked = 0
            ORDER BY department ASC, name ASC
            """
        ).fetchall()
        tpl_items = conn.execute(
            """
            SELECT DISTINCT name, department, buy_qty, buy_unit
            FROM weekly_template_items
            ORDER BY department ASC, name ASC
            """
        ).fetchall()

    slots = []
    custom_people = set()
    for s in slot_rows:
        display_title = s["recipe_title"] or s["custom_title"] or "Meal"
        if s["person_name"] and s["person_name"].strip():
            custom_people.add(s["person_name"].strip())
        slots.append(
            {
                "id": s["id"],
                "day_name": s["day_name"],
                "meal_slot": s["meal_slot"],
                "plan_item_id": s["plan_item_id"],
                "recipe_id": s["recipe_id"],
                "title": display_title,
                "custom_title": s["custom_title"] or "",
                "servings_used": round(float(s["servings_used"] or 1.0), 2),
                "person_name": s["person_name"] or "",
                "notes": s["notes"] or "",
                "created_at": s["created_at"],
            }
        )

    members = [u["display_name"] for u in user_rows if u["display_name"]]
    for p in sorted(custom_people):
        if p not in members:
            members.append(p)

    seen_items = set()
    quick_items = []
    for row in list(list_items) + list(tpl_items):
        nm = (row["name"] or "").strip()
        if not nm or nm.lower() in seen_items:
            continue
        seen_items.add(nm.lower())
        quick_items.append(
            {
                "name": nm,
                "department": row["department"] or "",
                "buy_qty": row["buy_qty"],
                "buy_unit": row["buy_unit"] or "",
            }
        )

    return {
        "slots": slots,
        "household_members": members,
        "list_and_snack_items": quick_items,
    }


@router.post("/calendar")
def create_calendar_slot(payload: CalendarSlotCreatePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        title = payload.custom_title.strip()
        plan_item_id = payload.plan_item_id
        if plan_item_id is not None:
            mp = conn.execute(
                """
                SELECT mp.id, r.title
                FROM meal_plan_items mp
                JOIN recipes r ON r.id = mp.recipe_id
                WHERE mp.id = ?
                """,
                (plan_item_id,),
            ).fetchone()
            if not mp:
                raise HTTPException(status_code=404, detail="Selected meal plan recipe not found")
            if not title:
                title = mp["title"]
        elif not title:
            raise HTTPException(status_code=400, detail="Please select a recipe/snack or enter a meal name")

        cur = conn.execute(
            """
            INSERT INTO meal_calendar_slots (
                day_name, meal_slot, plan_item_id, custom_title, servings_used, person_name, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.day_name.strip(),
                payload.meal_slot.strip(),
                plan_item_id,
                title,
                payload.servings_used,
                payload.person_name.strip(),
                payload.notes.strip(),
                now,
            ),
        )
        slot_id = cur.lastrowid
    return {"id": slot_id}


@router.patch("/calendar/{slot_id}")
def update_calendar_slot(slot_id: int, payload: CalendarSlotUpdatePayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM meal_calendar_slots WHERE id = ?", (slot_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Calendar slot not found")
        day_name = payload.day_name.strip() if payload.day_name is not None else row["day_name"]
        meal_slot = payload.meal_slot.strip() if payload.meal_slot is not None else row["meal_slot"]
        servings_used = payload.servings_used if payload.servings_used is not None else row["servings_used"]
        person_name = payload.person_name.strip() if payload.person_name is not None else row["person_name"]
        custom_title = payload.custom_title.strip() if payload.custom_title is not None else row["custom_title"]
        notes = payload.notes.strip() if payload.notes is not None else row["notes"]
        conn.execute(
            """
            UPDATE meal_calendar_slots
            SET day_name = ?, meal_slot = ?, servings_used = ?, person_name = ?, custom_title = ?, notes = ?
            WHERE id = ?
            """,
            (day_name, meal_slot, servings_used, person_name, custom_title, notes, slot_id),
        )
    return {"ok": True}


@router.delete("/calendar/{slot_id}")
def delete_calendar_slot(slot_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM meal_calendar_slots WHERE id = ?", (slot_id,))
    return {"ok": True}


@router.delete("/calendar")
def clear_calendar_slots(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM meal_calendar_slots")
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
