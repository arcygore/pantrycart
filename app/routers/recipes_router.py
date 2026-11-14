import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, utc_now_iso
from app.database import get_db
from app.scraper import scrape_recipe_url
from app.units import match_catalog_item, parse_ingredient_line

router = APIRouter(prefix="/api/recipes", tags=["recipes"])


class IngredientInput(BaseModel):
    raw_text: str
    quantity: Optional[float] = None
    unit: str = ""
    name: str = ""
    prep_notes: str = ""


class RecipePayload(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    servings: float = Field(default=4.0, gt=0)
    prep_minutes: Optional[int] = None
    cook_minutes: Optional[int] = None
    source_url: str = ""
    image_url: str = ""
    tags: list[str] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list)
    notes: str = ""
    ingredients: list[IngredientInput] = Field(default_factory=list)


class ScrapePayload(BaseModel):
    url: str


def _serialize_recipe(conn, row) -> dict:
    ings = conn.execute(
        """
        SELECT ri.*, pc.display_name AS catalog_name, pc.package_label, pc.default_department
        FROM recipe_ingredients ri
        LEFT JOIN product_catalog pc ON pc.id = ri.catalog_id
        WHERE ri.recipe_id = ?
        ORDER BY ri.sort_order ASC, ri.id ASC
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "servings": row["servings"],
        "prep_minutes": row["prep_minutes"],
        "cook_minutes": row["cook_minutes"],
        "source_url": row["source_url"],
        "image_url": row["image_url"],
        "tags": json.loads(row["tags_json"] or "[]"),
        "steps": json.loads(row["steps_json"] or "[]"),
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "ingredients": [dict(i) for i in ings],
    }


@router.get("")
def list_recipes(q: str = "", tag: str = "", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM recipes ORDER BY updated_at DESC, id DESC").fetchall()
        items = [_serialize_recipe(conn, r) for r in rows]

    if q.strip():
        ql = q.strip().lower()
        items = [
            r
            for r in items
            if ql in r["title"].lower()
            or ql in r["description"].lower()
            or any(ql in t.lower() for t in r["tags"])
            or any(ql in i["name"].lower() for i in r["ingredients"])
        ]
    if tag.strip():
        tl = tag.strip().lower()
        items = [r for r in items if any(tl == t.lower() for t in r["tags"])]
    return items


@router.post("/scrape")
async def scrape_recipe(payload: ScrapePayload, user: dict = Depends(get_current_user)):
    try:
        data = await scrape_recipe_url(payload.url)
        return data
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch recipe page: {exc}")


@router.get("/{recipe_id}")
def get_recipe(recipe_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        return _serialize_recipe(conn, row)


@router.post("")
def create_recipe(payload: RecipePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        cur = conn.execute(
            """
            INSERT INTO recipes (
                title, description, servings, prep_minutes, cook_minutes,
                source_url, image_url, tags_json, steps_json, notes, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.title.strip(),
                payload.description.strip(),
                payload.servings,
                payload.prep_minutes,
                payload.cook_minutes,
                payload.source_url.strip(),
                payload.image_url.strip(),
                json.dumps([t.strip() for t in payload.tags if t.strip()]),
                json.dumps([s.strip() for s in payload.steps if s.strip()]),
                payload.notes.strip(),
                user["id"],
                now,
                now,
            ),
        )
        rid = cur.lastrowid
        _save_recipe_ingredients(conn, rid, payload.ingredients, catalog_rows)
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (rid,)).fetchone()
        return _serialize_recipe(conn, row)


@router.put("/{recipe_id}")
def update_recipe(recipe_id: int, payload: RecipePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Recipe not found")
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        conn.execute(
            """
            UPDATE recipes
            SET title = ?, description = ?, servings = ?, prep_minutes = ?, cook_minutes = ?,
                source_url = ?, image_url = ?, tags_json = ?, steps_json = ?, notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.title.strip(),
                payload.description.strip(),
                payload.servings,
                payload.prep_minutes,
                payload.cook_minutes,
                payload.source_url.strip(),
                payload.image_url.strip(),
                json.dumps([t.strip() for t in payload.tags if t.strip()]),
                json.dumps([s.strip() for s in payload.steps if s.strip()]),
                payload.notes.strip(),
                now,
                recipe_id,
            ),
        )
        conn.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,))
        _save_recipe_ingredients(conn, recipe_id, payload.ingredients, catalog_rows)
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, row)


@router.delete("/{recipe_id}")
def delete_recipe(recipe_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM recipes WHERE id = ?", (recipe_id,))
    return {"ok": True}


def _save_recipe_ingredients(conn, recipe_id: int, ingredients: list[IngredientInput], catalog_rows: list[dict]):
    for idx, ing in enumerate(ingredients):
        raw = ing.raw_text.strip()
        if not raw and not ing.name.strip():
            continue
        if not ing.name.strip():
            parsed = parse_ingredient_line(raw)
            qty = parsed["quantity"]
            unit = parsed["unit"]
            name = parsed["name"]
            prep_notes = parsed["prep_notes"]
        else:
            qty = ing.quantity
            unit = ing.unit.strip()
            name = ing.name.strip()
            prep_notes = ing.prep_notes.strip()

        cat = match_catalog_item(name, catalog_rows)
        conn.execute(
            """
            INSERT INTO recipe_ingredients (
                recipe_id, sort_order, raw_text, quantity, unit, name, prep_notes, catalog_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                recipe_id,
                idx,
                raw or f"{qty or ''} {unit} {name}".strip(),
                qty,
                unit,
                name,
                prep_notes,
                cat["id"] if cat else None,
            ),
        )
