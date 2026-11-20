import difflib
import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user, require_non_guest, utc_now_iso
from app.database import get_db
from app.routers.nutrition_router import compute_recipe_macros
from app.scraper import parse_recipe_html_or_text, scrape_recipe_url
from app.units import match_catalog_item, normalize_item_key, parse_ingredient_line

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
    calories_per_serving: Optional[float] = None
    protein_g: Optional[float] = None
    carbs_g: Optional[float] = None
    fat_g: Optional[float] = None
    fiber_g: Optional[float] = None
    custom_portions: Optional[float] = None
    ingredients: list[IngredientInput] = Field(default_factory=list)


class PortionsUpdatePayload(BaseModel):
    custom_portions: Optional[float] = Field(default=None, gt=0, le=100)
    calories_per_serving: Optional[float] = None
    protein_g: Optional[float] = None
    carbs_g: Optional[float] = None
    fat_g: Optional[float] = None
    fiber_g: Optional[float] = None


class ScrapePayload(BaseModel):
    url: str


class ParseContentPayload(BaseModel):
    raw_content: str = ""
    content: str = ""
    ingredients_text: str = ""
    steps_text: str = ""
    title: str = ""
    source_url: str = ""


class RecipeReorderPayload(BaseModel):
    recipe_ids: list[int]


class RecipePinPayload(BaseModel):
    pinned: bool


class RecipeViewPrefsPayload(BaseModel):
    sort_mode: str = "custom"
    card_density: str = "cards"
    show_photos: bool = True
    show_macros: bool = True
    show_description: bool = True


DEFAULT_RECIPE_VIEW_PREFS = {
    "sort_mode": "custom",
    "card_density": "cards",
    "show_photos": True,
    "show_macros": True,
    "show_description": True,
}


def _parsed_ingredient_dicts(ingredients: list[IngredientInput]) -> list[dict]:
    out = []
    for ing in ingredients:
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
        out.append(
            {
                "raw_text": raw or f"{qty or ''} {unit} {name}".strip(),
                "quantity": qty,
                "unit": unit,
                "name": name,
                "prep_notes": prep_notes,
            }
        )
    return out


def _ing_signature(ings: list[dict]) -> list[tuple]:
    return [
        (
            normalize_item_key(i.get("name", "")),
            round(float(i["quantity"]) if i.get("quantity") is not None else 0.0, 3),
            (i.get("unit") or "").strip().lower(),
        )
        for i in ings
    ]


def _compute_recipe_diff(
    current_ings: list[dict],
    orig_ings: list[dict],
    current_steps: list[str],
    orig_steps: list[str],
) -> dict:
    # Tag each ingredient with unchanged | modified | added, plus removed_ingredients
    annotated_ings = [dict(i, diff_status="unchanged", original_raw="") for i in current_ings]
    removed_ingredients: list[str] = []

    if orig_ings:
        orig_keys = [normalize_item_key(i.get("name") or i.get("raw_text") or "") for i in orig_ings]
        curr_keys = [normalize_item_key(i.get("name") or i.get("raw_text") or "") for i in annotated_ings]
        sm = difflib.SequenceMatcher(None, orig_keys, curr_keys)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for oi, ci in zip(range(i1, i2), range(j1, j2)):
                    o_raw = (orig_ings[oi].get("raw_text") or "").strip()
                    c_raw = (annotated_ings[ci].get("raw_text") or "").strip()
                    if o_raw.lower() != c_raw.lower():
                        annotated_ings[ci]["diff_status"] = "modified"
                        annotated_ings[ci]["original_raw"] = o_raw
            elif tag == "replace":
                paired = min(i2 - i1, j2 - j1)
                for k in range(paired):
                    annotated_ings[j1 + k]["diff_status"] = "modified"
                    annotated_ings[j1 + k]["original_raw"] = (orig_ings[i1 + k].get("raw_text") or "").strip()
                for ci in range(j1 + paired, j2):
                    annotated_ings[ci]["diff_status"] = "added"
                for oi in range(i1 + paired, i2):
                    raw = (orig_ings[oi].get("raw_text") or "").strip()
                    if raw:
                        removed_ingredients.append(raw)
            elif tag == "insert":
                for ci in range(j1, j2):
                    annotated_ings[ci]["diff_status"] = "added"
            elif tag == "delete":
                for oi in range(i1, i2):
                    raw = (orig_ings[oi].get("raw_text") or "").strip()
                    if raw:
                        removed_ingredients.append(raw)

    step_diffs = [{"text": s, "diff_status": "unchanged", "original_text": ""} for s in current_steps]
    removed_steps: list[str] = []
    if orig_steps:
        orig_skeys = [s.strip().lower() for s in orig_steps]
        curr_skeys = [s.strip().lower() for s in current_steps]
        sm_s = difflib.SequenceMatcher(None, orig_skeys, curr_skeys)
        for tag, i1, i2, j1, j2 in sm_s.get_opcodes():
            if tag == "equal":
                continue
            elif tag == "replace":
                paired = min(i2 - i1, j2 - j1)
                for k in range(paired):
                    step_diffs[j1 + k]["diff_status"] = "modified"
                    step_diffs[j1 + k]["original_text"] = orig_steps[i1 + k]
                for ci in range(j1 + paired, j2):
                    step_diffs[ci]["diff_status"] = "added"
                for oi in range(i1 + paired, i2):
                    removed_steps.append(orig_steps[oi])
            elif tag == "insert":
                for ci in range(j1, j2):
                    step_diffs[ci]["diff_status"] = "added"
            elif tag == "delete":
                for oi in range(i1, i2):
                    removed_steps.append(orig_steps[oi])

    is_customized = (
        any(i["diff_status"] != "unchanged" for i in annotated_ings)
        or bool(removed_ingredients)
        or any(s["diff_status"] != "unchanged" for s in step_diffs)
        or bool(removed_steps)
    )

    return {
        "ingredients": annotated_ings,
        "removed_ingredients": removed_ingredients,
        "step_diffs": step_diffs,
        "removed_steps": removed_steps,
        "is_customized": is_customized,
    }


def _serialize_recipe(conn, row, pref: Optional[dict] = None) -> dict:
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
    keys = row.keys() if hasattr(row, "keys") else []
    current_ings = [dict(i) for i in ings]
    current_steps = json.loads(row["steps_json"] or "[]")
    orig_ings = json.loads(row["original_ingredients_json"] or "[]") if "original_ingredients_json" in keys else []
    orig_steps = json.loads(row["original_steps_json"] or "[]") if "original_steps_json" in keys else []
    diff = _compute_recipe_diff(current_ings, orig_ings, current_steps, orig_steps)
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
        "steps": current_steps,
        "notes": row["notes"],
        "calories_per_serving": row["calories_per_serving"] if "calories_per_serving" in keys else None,
        "protein_g": row["protein_g"] if "protein_g" in keys else None,
        "carbs_g": row["carbs_g"] if "carbs_g" in keys else None,
        "fat_g": row["fat_g"] if "fat_g" in keys else None,
        "fiber_g": row["fiber_g"] if "fiber_g" in keys else None,
        "custom_portions": row["custom_portions"] if "custom_portions" in keys else None,
        "original_ingredients": orig_ings,
        "original_steps": orig_steps,
        "is_customized": diff["is_customized"],
        "removed_ingredients": diff["removed_ingredients"],
        "step_diffs": diff["step_diffs"],
        "removed_steps": diff["removed_steps"],
        "pinned": bool(pref.get("pinned")) if pref else False,
        "sort_order": pref.get("sort_order") if pref else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "ingredients": diff["ingredients"],
    }


@router.get("")
def list_recipes(q: str = "", tag: str = "", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM recipes ORDER BY updated_at DESC, id DESC").fetchall()
        pref_rows = conn.execute(
            "SELECT recipe_id, pinned, sort_order FROM user_recipe_prefs WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
        pref_map = {p["recipe_id"]: dict(p) for p in pref_rows}
        items = [_serialize_recipe(conn, r, pref_map.get(r["id"])) for r in rows]

    items.sort(
        key=lambda r: (
            0 if r["pinned"] else 1,
            r["sort_order"] if r["sort_order"] is not None else 999999,
        )
    )

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


DEFAULT_QUICK_QUERIES = [
    "Dinner",
    "Lunch",
    "Breakfast",
    "Dessert",
    "Quick",
    "High Protein",
    "Chicken",
    "Beef",
    "Vegetarian",
]


class QuickQueriesPayload(BaseModel):
    queries: list[str] = Field(default_factory=list)


@router.get("/quick-queries")
def get_recipe_quick_queries(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT value_json FROM app_settings WHERE key = 'recipe_quick_queries'").fetchone()
        if row:
            try:
                parsed = json.loads(row["value_json"])
                if isinstance(parsed, list):
                    cleaned = [str(x).strip() for x in parsed if str(x).strip()]
                    return {"queries": cleaned}
            except Exception:
                pass
    return {"queries": list(DEFAULT_QUICK_QUERIES)}


@router.put("/quick-queries")
def update_recipe_quick_queries(payload: QuickQueriesPayload, user: dict = Depends(require_non_guest)):
    seen_lower: set[str] = set()
    cleaned: list[str] = []
    for raw in payload.queries:
        val = (raw or "").strip()
        if val and val.lower() not in seen_lower:
            seen_lower.add(val.lower())
            cleaned.append(val)
    now = utc_now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES ('recipe_quick_queries', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (json.dumps(cleaned), now),
        )
    return {"queries": cleaned}


@router.post("/scrape")
async def scrape_recipe(payload: ScrapePayload, user: dict = Depends(get_current_user)):
    try:
        data = await scrape_recipe_url(payload.url)
        return data
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch recipe page: {exc}")


@router.post("/parse-content")
def parse_recipe_content(payload: ParseContentPayload, user: dict = Depends(get_current_user)):
    ing_txt = (payload.ingredients_text or "").strip()
    stp_txt = (payload.steps_text or "").strip()
    if ing_txt or stp_txt:
        ings = [
            parse_ingredient_line(re.sub(r"^[▢☐☑✓✔•*-]\s*", "", l.strip()))
            for l in ing_txt.splitlines()
            if l.strip()
        ]
        steps = [
            re.sub(r"^(?:step\s*\d+\s*[:.)\-]?\s*|\d+[\.)]\s*|[▢☐☑✓✔•*-]\s*)", "", l.strip(), flags=re.I).strip()
            for l in stp_txt.splitlines()
            if l.strip()
        ]
        nut = compute_recipe_macros(ings, 4.0) if ings else {}
        return {
            "title": payload.title.strip() or "Imported Recipe",
            "description": "",
            "servings": 4.0,
            "prep_minutes": None,
            "cook_minutes": None,
            "source_url": payload.source_url.strip(),
            "image_url": "",
            "tags": [],
            "ingredients": ings,
            "steps": steps,
            **nut,
        }

    raw = (payload.raw_content or payload.content or "").strip()
    if len(raw) < 5:
        raise HTTPException(status_code=400, detail="Please paste recipe text or HTML source.")
    try:
        parsed = parse_recipe_html_or_text(raw, payload.source_url.strip())
        if parsed.get("calories_per_serving") is None and parsed.get("ingredients"):
            est = compute_recipe_macros(parsed["ingredients"], parsed.get("servings") or 4.0)
            parsed.update(est)
        return parsed
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


async def _fetch_missing_from_url_for_recipe(recipe_dict: dict, ings: list[dict]) -> dict:
    src = (recipe_dict.get("source_url") or "").strip()
    need_img = not (recipe_dict.get("image_url") or "").strip()
    need_nut = recipe_dict.get("calories_per_serving") is None
    updates: dict = {}

    if (need_img or need_nut) and src.startswith("http"):
        try:
            scraped = await scrape_recipe_url(src)
            if need_img and scraped.get("image_url"):
                updates["image_url"] = scraped["image_url"]
            if need_nut and scraped.get("calories_per_serving") is not None:
                for k in ("calories_per_serving", "protein_g", "carbs_g", "fat_g", "fiber_g"):
                    updates[k] = scraped.get(k)
        except Exception:
            pass

    if need_nut and "calories_per_serving" not in updates and ings:
        est = compute_recipe_macros(ings, recipe_dict.get("servings") or 4.0)
        if est.get("calories_per_serving"):
            updates.update(est)

    return updates


@router.post("/sync-missing-from-url")
async def sync_missing_recipes_from_url(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        candidates = conn.execute(
            """
            SELECT * FROM recipes
            WHERE source_url LIKE 'http%'
              AND (image_url = '' OR image_url IS NULL OR calories_per_serving IS NULL)
            ORDER BY id DESC
            LIMIT 15
            """
        ).fetchall()
        cand_list = []
        for r in candidates:
            ings = [
                dict(i)
                for i in conn.execute(
                    "SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id = ?",
                    (r["id"],),
                ).fetchall()
            ]
            cand_list.append((dict(r), ings))

    updated_count = 0
    now = utc_now_iso()
    for rdict, ings in cand_list:
        updates = await _fetch_missing_from_url_for_recipe(rdict, ings)
        if updates:
            with get_db() as conn:
                conn.execute(
                    """
                    UPDATE recipes
                    SET image_url = COALESCE(?, image_url),
                        calories_per_serving = COALESCE(?, calories_per_serving),
                        protein_g = COALESCE(?, protein_g),
                        carbs_g = COALESCE(?, carbs_g),
                        fat_g = COALESCE(?, fat_g),
                        fiber_g = COALESCE(?, fiber_g),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        updates.get("image_url"),
                        updates.get("calories_per_serving"),
                        updates.get("protein_g"),
                        updates.get("carbs_g"),
                        updates.get("fat_g"),
                        updates.get("fiber_g"),
                        now,
                        rdict["id"],
                    ),
                )
            updated_count += 1

    return {"updated": updated_count, "checked": len(cand_list)}


@router.post("/{recipe_id}/sync-from-url")
async def sync_single_recipe_from_url(recipe_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        rdict = dict(row)
        ings = [
            dict(i)
            for i in conn.execute(
                "SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id = ?",
                (recipe_id,),
            ).fetchall()
        ]

    # Allow forcing image refresh if blank or nutrition refresh if requested
    updates = await _fetch_missing_from_url_for_recipe(rdict, ings)
    if not updates and (rdict.get("source_url") or "").startswith("http"):
        try:
            scraped = await scrape_recipe_url(rdict["source_url"])
            if scraped.get("image_url") and not rdict.get("image_url"):
                updates["image_url"] = scraped["image_url"]
            if scraped.get("calories_per_serving") is not None and rdict.get("calories_per_serving") is None:
                for k in ("calories_per_serving", "protein_g", "carbs_g", "fat_g", "fiber_g"):
                    updates[k] = scraped.get(k)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Could not sync from URL: {exc}")

    now = utc_now_iso()
    with get_db() as conn:
        if updates:
            conn.execute(
                """
                UPDATE recipes
                SET image_url = COALESCE(?, image_url),
                    calories_per_serving = COALESCE(?, calories_per_serving),
                    protein_g = COALESCE(?, protein_g),
                    carbs_g = COALESCE(?, carbs_g),
                    fat_g = COALESCE(?, fat_g),
                    fiber_g = COALESCE(?, fiber_g),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    updates.get("image_url"),
                    updates.get("calories_per_serving"),
                    updates.get("protein_g"),
                    updates.get("carbs_g"),
                    updates.get("fat_g"),
                    updates.get("fiber_g"),
                    now,
                    recipe_id,
                ),
            )
        refreshed = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, refreshed)


@router.post("/reorder")
def reorder_recipes(payload: RecipeReorderPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        for idx, rid in enumerate(payload.recipe_ids, start=1):
            conn.execute(
                """
                INSERT INTO user_recipe_prefs (user_id, recipe_id, pinned, sort_order, updated_at)
                VALUES (?, ?, 0, ?, ?)
                ON CONFLICT(user_id, recipe_id) DO UPDATE SET
                    sort_order = excluded.sort_order,
                    updated_at = excluded.updated_at
                """,
                (user["id"], rid, idx, now),
            )
    return {"ok": True}


@router.get("/view-prefs")
def get_recipe_view_prefs(user: dict = Depends(get_current_user)):
    key = f"recipe_view_prefs:{user['id']}"
    with get_db() as conn:
        row = conn.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,)).fetchone()
        if row:
            try:
                parsed = json.loads(row["value_json"])
                if isinstance(parsed, dict):
                    return {**DEFAULT_RECIPE_VIEW_PREFS, **parsed}
            except Exception:
                pass
    return dict(DEFAULT_RECIPE_VIEW_PREFS)


@router.put("/view-prefs")
def update_recipe_view_prefs(payload: RecipeViewPrefsPayload, user: dict = Depends(get_current_user)):
    key = f"recipe_view_prefs:{user['id']}"
    val = payload.model_dump()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            (key, json.dumps(val), utc_now_iso()),
        )
    return val


@router.get("/{recipe_id}")
def get_recipe(recipe_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        pref = conn.execute(
            "SELECT recipe_id, pinned, sort_order FROM user_recipe_prefs WHERE user_id = ? AND recipe_id = ?",
            (user["id"], recipe_id),
        ).fetchone()
        return _serialize_recipe(conn, row, dict(pref) if pref else None)


@router.post("/{recipe_id}/pin")
def pin_recipe(recipe_id: int, payload: RecipePinPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        if not conn.execute("SELECT 1 FROM recipes WHERE id = ?", (recipe_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Recipe not found")
        conn.execute(
            """
            INSERT INTO user_recipe_prefs (user_id, recipe_id, pinned, sort_order, updated_at)
            VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(user_id, recipe_id) DO UPDATE SET
                pinned = excluded.pinned,
                updated_at = excluded.updated_at
            """,
            (user["id"], recipe_id, 1 if payload.pinned else 0, now),
        )
    return {"ok": True, "recipe_id": recipe_id, "pinned": payload.pinned}


@router.patch("/{recipe_id}/portions")
def update_recipe_portions(recipe_id: int, payload: PortionsUpdatePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        fset = payload.model_fields_set
        custom_portions = payload.custom_portions if "custom_portions" in fset else row["custom_portions"]
        cal = payload.calories_per_serving if "calories_per_serving" in fset else row["calories_per_serving"]
        pro = payload.protein_g if "protein_g" in fset else row["protein_g"]
        carb = payload.carbs_g if "carbs_g" in fset else row["carbs_g"]
        fat = payload.fat_g if "fat_g" in fset else row["fat_g"]
        fib = payload.fiber_g if "fiber_g" in fset else row["fiber_g"]
        conn.execute(
            """
            UPDATE recipes
            SET custom_portions = ?, calories_per_serving = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?, updated_at = ?
            WHERE id = ?
            """,
            (custom_portions, cal, pro, carb, fat, fib, now, recipe_id),
        )
        updated = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, updated)


@router.post("")
async def create_recipe(payload: RecipePayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    parsed_ings = _parsed_ingredient_dicts(payload.ingredients)
    clean_steps = [s.strip() for s in payload.steps if s.strip()]
    image_url = payload.image_url.strip()
    cal = payload.calories_per_serving
    pro = payload.protein_g
    carb = payload.carbs_g
    fat = payload.fat_g
    fib = payload.fiber_g

    src = payload.source_url.strip()
    if src.startswith("http") and (not image_url or cal is None):
        try:
            scraped = await scrape_recipe_url(src)
            if not image_url and scraped.get("image_url"):
                image_url = scraped["image_url"]
            if cal is None and scraped.get("calories_per_serving") is not None:
                cal = scraped.get("calories_per_serving")
                pro = scraped.get("protein_g")
                carb = scraped.get("carbs_g")
                fat = scraped.get("fat_g")
                fib = scraped.get("fiber_g")
        except Exception:
            pass

    if cal is None and parsed_ings:
        est = compute_recipe_macros(parsed_ings, payload.servings)
        cal = est["calories_per_serving"]
        pro = est["protein_g"]
        carb = est["carbs_g"]
        fat = est["fat_g"]
        fib = est["fiber_g"]

    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        cur = conn.execute(
            """
            INSERT INTO recipes (
                title, description, servings, prep_minutes, cook_minutes,
                source_url, image_url, tags_json, steps_json, notes,
                calories_per_serving, protein_g, carbs_g, fat_g, fiber_g, custom_portions,
                original_ingredients_json, original_steps_json,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.title.strip(),
                payload.description.strip(),
                payload.servings,
                payload.prep_minutes,
                payload.cook_minutes,
                src,
                image_url,
                json.dumps([t.strip() for t in payload.tags if t.strip()]),
                json.dumps(clean_steps),
                payload.notes.strip(),
                cal,
                pro,
                carb,
                fat,
                fib,
                payload.custom_portions,
                json.dumps(parsed_ings),
                json.dumps(clean_steps),
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
async def update_recipe(recipe_id: int, payload: RecipePayload, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    new_ings = _parsed_ingredient_dicts(payload.ingredients)
    clean_steps = [s.strip() for s in payload.steps if s.strip()]

    with get_db() as conn:
        existing = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Recipe not found")
        old_ings = [
            dict(r)
            for r in conn.execute(
                "SELECT raw_text, quantity, unit, name, prep_notes FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order ASC, id ASC",
                (recipe_id,),
            ).fetchall()
        ]

    image_url = payload.image_url.strip()
    src = payload.source_url.strip()
    scraped_nut = None
    if src.startswith("http") and (not image_url or payload.calories_per_serving is None):
        try:
            scraped = await scrape_recipe_url(src)
            if not image_url and scraped.get("image_url"):
                image_url = scraped["image_url"]
            if scraped.get("calories_per_serving") is not None:
                scraped_nut = scraped
        except Exception:
            pass

    def _same_num(a, b) -> bool:
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        return abs(float(a) - float(b)) < 0.2

    ing_or_srv_changed = (
        _ing_signature(old_ings) != _ing_signature(new_ings)
        or abs(float(existing["servings"]) - float(payload.servings)) > 0.01
    )
    submitted_matches_old = (
        _same_num(payload.calories_per_serving, existing["calories_per_serving"])
        and _same_num(payload.protein_g, existing["protein_g"])
        and _same_num(payload.carbs_g, existing["carbs_g"])
        and _same_num(payload.fat_g, existing["fat_g"])
        and _same_num(payload.fiber_g, existing["fiber_g"])
    )

    cal = payload.calories_per_serving
    pro = payload.protein_g
    carb = payload.carbs_g
    fat = payload.fat_g
    fib = payload.fiber_g

    if (ing_or_srv_changed and submitted_matches_old) or (cal is None and new_ings):
        old_est = compute_recipe_macros(old_ings, existing["servings"]) if old_ings else {}
        new_est = compute_recipe_macros(new_ings, payload.servings) if new_ings else {}
        if cal is None and scraped_nut and not ing_or_srv_changed:
            cal = scraped_nut.get("calories_per_serving")
            pro = scraped_nut.get("protein_g")
            carb = scraped_nut.get("carbs_g")
            fat = scraped_nut.get("fat_g")
            fib = scraped_nut.get("fiber_g")
        elif (
            existing["calories_per_serving"] is not None
            and old_est.get("calories_per_serving", 0) > 0
            and new_est.get("calories_per_serving", 0) > 0
            and abs(float(existing["calories_per_serving"]) - float(old_est["calories_per_serving"])) > 25
        ):
            cal = max(0, round(float(existing["calories_per_serving"] or 0) + (new_est["calories_per_serving"] - old_est["calories_per_serving"])))
            pro = max(0.0, round(float(existing["protein_g"] or 0) + (new_est["protein_g"] - old_est["protein_g"]), 1))
            carb = max(0.0, round(float(existing["carbs_g"] or 0) + (new_est["carbs_g"] - old_est["carbs_g"]), 1))
            fat = max(0.0, round(float(existing["fat_g"] or 0) + (new_est["fat_g"] - old_est["fat_g"]), 1))
            fib = max(0.0, round(float(existing["fiber_g"] or 0) + (new_est["fiber_g"] - old_est["fiber_g"]), 1))
        elif new_est:
            cal = new_est["calories_per_serving"]
            pro = new_est["protein_g"]
            carb = new_est["carbs_g"]
            fat = new_est["fat_g"]
            fib = new_est["fiber_g"]

    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        orig_ings_json = existing["original_ingredients_json"] or "[]"
        orig_steps_json = existing["original_steps_json"] or "[]"
        if orig_ings_json in ("", "[]") and old_ings:
            orig_ings_json = json.dumps(old_ings)
        if orig_steps_json in ("", "[]") and existing["steps_json"] not in (None, "", "[]"):
            orig_steps_json = existing["steps_json"]

        conn.execute(
            """
            UPDATE recipes
            SET title = ?, description = ?, servings = ?, prep_minutes = ?, cook_minutes = ?,
                source_url = ?, image_url = ?, tags_json = ?, steps_json = ?, notes = ?,
                calories_per_serving = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?, custom_portions = ?,
                original_ingredients_json = ?, original_steps_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                payload.title.strip(),
                payload.description.strip(),
                payload.servings,
                payload.prep_minutes,
                payload.cook_minutes,
                src,
                image_url,
                json.dumps([t.strip() for t in payload.tags if t.strip()]),
                json.dumps(clean_steps),
                payload.notes.strip(),
                cal,
                pro,
                carb,
                fat,
                fib,
                payload.custom_portions,
                orig_ings_json,
                orig_steps_json,
                now,
                recipe_id,
            ),
        )
        conn.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,))
        _save_recipe_ingredients(conn, recipe_id, payload.ingredients, catalog_rows)

        # Keep unlogged weekly calendar slots in sync with updated recipe macros
        if cal is not None:
            hrow = conn.execute("SELECT value_json FROM app_settings WHERE key = 'household_size'").fetchone()
            hsize = None
            if hrow:
                try:
                    hsize = int(json.loads(hrow["value_json"]))
                except Exception:
                    hsize = None
            if not hsize or hsize < 1:
                hsize = max(1, int(conn.execute("SELECT COUNT(*) FROM users WHERE COALESCE(is_guest, 0) = 0").fetchone()[0] or 1))

            portion_div = float(payload.custom_portions or payload.servings or 1.0)
            srv_ratio = float(payload.servings or 1.0) / max(portion_div, 0.5)
            slots = conn.execute(
                """
                SELECT mcs.id, mcs.servings_used, mcs.person_name
                FROM meal_calendar_slots mcs
                JOIN meal_plan_items mpi ON mpi.id = mcs.plan_item_id
                WHERE mpi.recipe_id = ? AND (mcs.logged_at IS NULL OR mcs.logged_at = '')
                """,
                (recipe_id,),
            ).fetchall()
            for srow in slots:
                is_ev = (srow["person_name"] or "").strip() in ("", "Everyone")
                raw_srv = float(srow["servings_used"] or 1.0)
                eff_srv = (raw_srv / hsize) if (is_ev and hsize > 1) else raw_srv
                mult = eff_srv * srv_ratio
                conn.execute(
                    """
                    UPDATE meal_calendar_slots
                    SET calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?
                    WHERE id = ?
                    """,
                    (
                        round(float(cal or 0) * mult),
                        round(float(pro or 0) * mult, 1),
                        round(float(carb or 0) * mult, 1),
                        round(float(fat or 0) * mult, 1),
                        round(float(fib or 0) * mult, 1),
                        srow["id"],
                    ),
                )

        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, row)


@router.post("/{recipe_id}/reset-to-original")
def reset_recipe_to_original(recipe_id: int, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        orig_ings = json.loads(row["original_ingredients_json"] or "[]")
        orig_steps = json.loads(row["original_steps_json"] or "[]")
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        ing_inputs = [
            IngredientInput(
                raw_text=i.get("raw_text", ""),
                quantity=i.get("quantity"),
                unit=i.get("unit", ""),
                name=i.get("name", ""),
                prep_notes=i.get("prep_notes", ""),
            )
            for i in orig_ings
        ]
        conn.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", (recipe_id,))
        _save_recipe_ingredients(conn, recipe_id, ing_inputs, catalog_rows)
        est = compute_recipe_macros(orig_ings, row["servings"]) if orig_ings else {}
        conn.execute(
            """
            UPDATE recipes
            SET steps_json = ?,
                calories_per_serving = COALESCE(?, calories_per_serving),
                protein_g = COALESCE(?, protein_g),
                carbs_g = COALESCE(?, carbs_g),
                fat_g = COALESCE(?, fat_g),
                fiber_g = COALESCE(?, fiber_g),
                updated_at = ?
            WHERE id = ?
            """,
            (
                json.dumps(orig_steps),
                est.get("calories_per_serving"),
                est.get("protein_g"),
                est.get("carbs_g"),
                est.get("fat_g"),
                est.get("fiber_g"),
                now,
                recipe_id,
            ),
        )
        updated = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, updated)


@router.post("/{recipe_id}/save-as-original")
def save_current_as_original(recipe_id: int, user: dict = Depends(require_non_guest)):
    now = utc_now_iso()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        ing_rows = conn.execute(
            """
            SELECT raw_text, quantity, unit, name, prep_notes
            FROM recipe_ingredients
            WHERE recipe_id = ?
            ORDER BY sort_order ASC, id ASC
            """,
            (recipe_id,),
        ).fetchall()
        conn.execute(
            """
            UPDATE recipes
            SET original_ingredients_json = ?, original_steps_json = steps_json, updated_at = ?
            WHERE id = ?
            """,
            (json.dumps([dict(x) for x in ing_rows]), now, recipe_id),
        )
        updated = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        return _serialize_recipe(conn, updated)


@router.delete("/{recipe_id}")
def delete_recipe(recipe_id: int, user: dict = Depends(require_non_guest)):
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
