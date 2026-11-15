import plistlib
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app.auth import get_current_user, utc_now_iso
from app.database import get_db
from app.units import VOLUME_TO_TSP, WEIGHT_TO_G, normalize_item_key, parse_ingredient_line

router = APIRouter(prefix="/api/nutrition", tags=["nutrition"])

# Nutrition per 100g: (calories, protein_g, carbs_g, fat_g, fiber_g, grams_per_count, cup_grams)
NUTRITION_DB: dict[str, tuple[float, float, float, float, float, float, float]] = {
    # Poultry & Meat
    "chicken breast": (165, 31.0, 0.0, 3.6, 0.0, 175.0, 140.0),
    "chicken tenderloins": (110, 23.0, 0.0, 1.5, 0.0, 50.0, 140.0),
    "chicken thighs": (209, 26.0, 0.0, 10.9, 0.0, 140.0, 140.0),
    "ground beef": (250, 26.0, 0.0, 15.0, 0.0, 113.0, 225.0),
    "ground turkey": (170, 21.0, 0.0, 9.4, 0.0, 113.0, 225.0),
    "italian sausage": (300, 18.0, 2.0, 25.0, 0.0, 85.0, 150.0),
    "bacon": (541, 37.0, 1.4, 42.0, 0.0, 15.0, 120.0),
    "salmon": (208, 20.0, 0.0, 13.0, 0.0, 170.0, 150.0),
    "shrimp": (99, 24.0, 0.2, 0.3, 0.0, 15.0, 145.0),
    "pork chops": (231, 25.0, 0.0, 14.0, 0.0, 170.0, 140.0),
    # Dairy & Eggs
    "eggs": (143, 12.6, 0.7, 9.5, 0.0, 50.0, 240.0),
    "butter": (717, 0.9, 0.1, 81.1, 0.0, 113.0, 227.0),
    "milk": (61, 3.2, 4.8, 3.3, 0.0, 244.0, 244.0),
    "heavy cream": (340, 2.8, 2.8, 36.1, 0.0, 15.0, 238.0),
    "half and half": (131, 3.0, 4.3, 11.5, 0.0, 30.0, 242.0),
    "sour cream": (198, 2.4, 4.6, 19.4, 0.0, 30.0, 230.0),
    "cream cheese": (342, 5.9, 4.1, 34.2, 0.0, 28.0, 232.0),
    "greek yogurt": (73, 10.0, 3.9, 1.9, 0.0, 170.0, 245.0),
    "cheddar cheese": (403, 22.9, 3.1, 33.3, 0.0, 28.0, 113.0),
    "mozzarella cheese": (280, 28.0, 3.1, 17.0, 0.0, 28.0, 113.0),
    "parmesan cheese": (431, 38.5, 4.1, 29.0, 0.0, 28.0, 100.0),
    "feta cheese": (264, 14.2, 4.1, 21.3, 0.0, 28.0, 150.0),
    # Oils, Condiments & Liquids
    "olive oil": (884, 0.0, 0.0, 100.0, 0.0, 13.5, 216.0),
    "vegetable oil": (884, 0.0, 0.0, 100.0, 0.0, 13.5, 218.0),
    "sesame oil": (884, 0.0, 0.0, 100.0, 0.0, 13.5, 218.0),
    "soy sauce": (53, 8.1, 4.9, 0.6, 0.8, 16.0, 255.0),
    "balsamic vinegar": (88, 0.5, 17.0, 0.0, 0.0, 16.0, 255.0),
    "honey": (304, 0.3, 82.4, 0.0, 0.2, 21.0, 339.0),
    "maple syrup": (260, 0.0, 67.0, 0.1, 0.0, 20.0, 315.0),
    "peanut butter": (588, 25.1, 20.0, 50.4, 6.0, 32.0, 258.0),
    "mayonnaise": (680, 1.0, 0.6, 75.0, 0.0, 15.0, 220.0),
    "ketchup": (112, 1.7, 25.8, 0.1, 0.3, 17.0, 272.0),
    "chicken broth": (15, 1.6, 1.1, 0.5, 0.0, 240.0, 240.0),
    "beef broth": (15, 1.8, 0.8, 0.3, 0.0, 240.0, 240.0),
    "vegetable broth": (12, 0.5, 2.0, 0.1, 0.0, 240.0, 240.0),
    # Grains, Pasta, Breads & Legumes
    "pasta": (371, 13.0, 74.7, 1.5, 3.2, 85.0, 105.0),
    "white rice": (365, 7.1, 80.0, 0.7, 1.3, 185.0, 185.0),
    "brown rice": (362, 7.5, 76.2, 2.7, 3.4, 185.0, 185.0),
    "quinoa": (368, 14.1, 64.2, 6.1, 7.0, 170.0, 170.0),
    "rolled oats": (389, 16.9, 66.3, 6.9, 10.6, 40.0, 81.0),
    "all-purpose flour": (364, 10.3, 76.3, 1.0, 2.7, 125.0, 125.0),
    "granulated sugar": (387, 0.0, 100.0, 0.0, 0.0, 200.0, 200.0),
    "brown sugar": (380, 0.1, 98.1, 0.0, 0.0, 213.0, 213.0),
    "breadcrumbs": (395, 13.4, 72.0, 5.3, 4.5, 28.0, 108.0),
    "bread": (265, 9.0, 49.0, 3.2, 2.7, 30.0, 60.0),
    "hamburger buns": (279, 9.5, 50.0, 4.2, 2.2, 50.0, 100.0),
    "tortillas": (304, 8.1, 51.0, 7.5, 3.2, 45.0, 120.0),
    "black beans": (132, 8.9, 23.7, 0.5, 8.7, 172.0, 172.0),
    "kidney beans": (127, 8.7, 22.8, 0.5, 7.4, 172.0, 172.0),
    "chickpeas": (164, 8.9, 27.4, 2.6, 7.6, 164.0, 164.0),
    # Tomatoes, Canned Goods & Produce
    "diced tomatoes": (32, 1.6, 7.0, 0.3, 1.9, 180.0, 240.0),
    "crushed tomatoes": (32, 1.6, 7.3, 0.3, 1.9, 180.0, 240.0),
    "tomato paste": (82, 4.3, 18.9, 0.5, 4.1, 16.0, 262.0),
    "tomato sauce": (50, 1.5, 8.0, 1.5, 1.8, 125.0, 245.0),
    "sun-dried tomatoes": (258, 14.1, 55.8, 3.0, 12.3, 54.0, 110.0),
    "coconut milk": (230, 2.3, 5.5, 23.8, 2.2, 240.0, 240.0),
    "salsa": (36, 1.5, 7.0, 0.2, 1.5, 32.0, 250.0),
    "potato": (77, 2.0, 17.5, 0.1, 2.2, 170.0, 150.0),
    "sweet potato": (86, 1.6, 20.1, 0.1, 3.0, 150.0, 133.0),
    "yellow onion": (40, 1.1, 9.3, 0.1, 1.7, 110.0, 160.0),
    "red onion": (40, 1.1, 9.3, 0.1, 1.7, 110.0, 160.0),
    "green onion": (32, 1.8, 7.3, 0.2, 2.6, 15.0, 100.0),
    "garlic": (149, 6.4, 33.1, 0.5, 2.1, 3.0, 136.0),
    "carrot": (41, 0.9, 9.6, 0.2, 2.8, 61.0, 128.0),
    "celery": (14, 0.7, 3.0, 0.2, 1.6, 40.0, 101.0),
    "bell pepper": (31, 1.0, 6.0, 0.3, 2.1, 120.0, 149.0),
    "broccoli": (34, 2.8, 6.6, 0.4, 2.6, 150.0, 91.0),
    "spinach": (23, 2.9, 3.6, 0.4, 2.2, 30.0, 30.0),
    "kale": (49, 4.3, 8.8, 0.9, 3.6, 67.0, 67.0),
    "lettuce": (17, 1.2, 3.3, 0.3, 2.1, 47.0, 47.0),
    "salad mix": (20, 1.5, 3.6, 0.3, 2.0, 85.0, 50.0),
    "mushroom": (22, 3.1, 3.3, 0.3, 1.0, 18.0, 70.0),
    "zucchini": (17, 1.2, 3.1, 0.3, 1.0, 196.0, 124.0),
    "cucumber": (15, 0.7, 3.6, 0.1, 0.5, 150.0, 104.0),
    "tomato": (18, 0.9, 3.9, 0.2, 1.2, 123.0, 180.0),
    "cherry tomatoes": (18, 0.9, 3.9, 0.2, 1.2, 17.0, 150.0),
    "avocado": (160, 2.0, 8.5, 14.7, 6.7, 150.0, 150.0),
    "lemon": (29, 1.1, 9.3, 0.3, 2.8, 58.0, 212.0),
    "lime": (30, 0.7, 10.5, 0.2, 2.8, 44.0, 212.0),
    "banana": (89, 1.1, 22.8, 0.3, 2.6, 118.0, 150.0),
    "apple": (52, 0.3, 13.8, 0.2, 2.4, 182.0, 125.0),
    "frozen peas": (81, 5.4, 14.5, 0.4, 5.7, 145.0, 145.0),
    "frozen corn": (86, 3.2, 19.0, 1.2, 2.0, 150.0, 150.0),
    "frozen berries": (50, 0.7, 12.0, 0.3, 3.5, 140.0, 140.0),
    # Common Snacks & Household Additions
    "chips": (536, 7.0, 53.0, 35.0, 4.8, 28.0, 30.0),
    "protein bar": (380, 33.0, 40.0, 12.0, 8.0, 60.0, 60.0),
    "granola bar": (440, 8.0, 68.0, 15.0, 5.0, 35.0, 80.0),
    "almonds": (579, 21.2, 21.6, 49.9, 12.5, 28.0, 143.0),
    "hummus": (166, 7.9, 14.3, 9.6, 6.0, 30.0, 246.0),
}

# Keyword fallbacks mapped to canonical NUTRITION_DB keys
NUTRITION_KEYWORDS = [
    ("chicken breast", "chicken breast"),
    ("chicken tender", "chicken tenderloins"),
    ("chicken thigh", "chicken thighs"),
    ("chicken broth", "chicken broth"),
    ("chicken stock", "chicken broth"),
    ("chicken", "chicken breast"),
    ("ground beef", "ground beef"),
    ("steak", "ground beef"),
    ("beef broth", "beef broth"),
    ("beef", "ground beef"),
    ("turkey", "ground turkey"),
    ("sausage", "italian sausage"),
    ("bacon", "bacon"),
    ("salmon", "salmon"),
    ("shrimp", "shrimp"),
    ("pork", "pork chops"),
    ("egg", "eggs"),
    ("unsalted butter", "butter"),
    ("salted butter", "butter"),
    ("butter", "butter"),
    ("heavy cream", "heavy cream"),
    ("whipping cream", "heavy cream"),
    ("half & half", "half and half"),
    ("half and half", "half and half"),
    ("sour cream", "sour cream"),
    ("cream cheese", "cream cheese"),
    ("greek yogurt", "greek yogurt"),
    ("yogurt", "greek yogurt"),
    ("milk", "milk"),
    ("parmesan", "parmesan cheese"),
    ("mozzarella", "mozzarella cheese"),
    ("cheddar", "cheddar cheese"),
    ("feta", "feta cheese"),
    ("cheese", "cheddar cheese"),
    ("olive oil", "olive oil"),
    ("canola oil", "vegetable oil"),
    ("vegetable oil", "vegetable oil"),
    ("sesame oil", "sesame oil"),
    ("oil", "olive oil"),
    ("soy sauce", "soy sauce"),
    ("honey", "honey"),
    ("maple syrup", "maple syrup"),
    ("peanut butter", "peanut butter"),
    ("mayonnaise", "mayonnaise"),
    ("mayo", "mayonnaise"),
    ("ketchup", "ketchup"),
    ("spaghetti", "pasta"),
    ("penne", "pasta"),
    ("rigatoni", "pasta"),
    ("fettuccine", "pasta"),
    ("rotini", "pasta"),
    ("macaroni", "pasta"),
    ("noodle", "pasta"),
    ("pasta", "pasta"),
    ("brown rice", "brown rice"),
    ("rice", "white rice"),
    ("quinoa", "quinoa"),
    ("oat", "rolled oats"),
    ("flour", "all-purpose flour"),
    ("brown sugar", "brown sugar"),
    ("sugar", "granulated sugar"),
    ("panko", "breadcrumbs"),
    ("breadcrumb", "breadcrumbs"),
    ("tortilla", "tortillas"),
    ("bun", "hamburger buns"),
    ("bread", "bread"),
    ("black bean", "black beans"),
    ("kidney bean", "kidney beans"),
    ("chickpea", "chickpeas"),
    ("garbanzo", "chickpeas"),
    ("sun-dried tomato", "sun-dried tomatoes"),
    ("sundried tomato", "sun-dried tomatoes"),
    ("tomato paste", "tomato paste"),
    ("tomato sauce", "tomato sauce"),
    ("marinara", "tomato sauce"),
    ("diced tomato", "diced tomatoes"),
    ("crushed tomato", "crushed tomatoes"),
    ("cherry tomato", "cherry tomatoes"),
    ("tomato", "tomato"),
    ("coconut milk", "coconut milk"),
    ("salsa", "salsa"),
    ("sweet potato", "sweet potato"),
    ("potato", "potato"),
    ("scallion", "green onion"),
    ("green onion", "green onion"),
    ("onion", "yellow onion"),
    ("garlic", "garlic"),
    ("carrot", "carrot"),
    ("celery", "celery"),
    ("bell pepper", "bell pepper"),
    ("broccoli", "broccoli"),
    ("spinach", "spinach"),
    ("kale", "kale"),
    ("salad", "salad mix"),
    ("lettuce", "lettuce"),
    ("mushroom", "mushroom"),
    ("zucchini", "zucchini"),
    ("cucumber", "cucumber"),
    ("avocado", "avocado"),
    ("lemon", "lemon"),
    ("lime", "lime"),
    ("banana", "banana"),
    ("apple", "apple"),
    ("pea", "frozen peas"),
    ("corn", "frozen corn"),
    ("berr", "frozen berries"),
    ("protein bar", "protein bar"),
    ("granola", "granola bar"),
    ("almond", "almonds"),
    ("hummus", "hummus"),
    ("chip", "chips"),
]


class EstimateTextPayload(BaseModel):
    ingredients_text: str = ""
    servings: float = Field(default=4.0, gt=0)


class ShortcutVerifiedPayload(BaseModel):
    verified: bool = True


class MarkLoggedPayload(BaseModel):
    slot_ids: list[int] = Field(default_factory=list)
    day_name: Optional[str] = None
    person_name: Optional[str] = None


def _lookup_nutrition_key(name: str) -> Optional[str]:
    key = normalize_item_key(name)
    if key in NUTRITION_DB:
        return key
    for kw, target in NUTRITION_KEYWORDS:
        if kw in key:
            return target
    return None


def estimate_ingredient_macros(name: str, quantity: Optional[float], unit: str) -> dict[str, float]:
    nkey = _lookup_nutrition_key(name)
    if not nkey:
        return {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "fiber_g": 0.0}

    cal100, pro100, carb100, fat100, fib100, grams_per_count, cup_grams = NUTRITION_DB[nkey]
    qty = float(quantity) if (quantity is not None and quantity > 0) else 1.0
    u = (unit or "").strip().lower()

    if u in WEIGHT_TO_G:
        grams = qty * WEIGHT_TO_G[u]
    elif u in VOLUME_TO_TSP:
        cups = (qty * VOLUME_TO_TSP[u]) / VOLUME_TO_TSP["cup"]
        grams = cups * cup_grams
    elif u == "can":
        grams = qty * 425.0  # Standard ~15 oz US can
    elif u in ("stick",):
        grams = qty * 113.0
    elif u in ("clove",):
        grams = qty * 3.0
    elif u in ("slice",):
        grams = qty * 28.0
    elif u == "bunch":
        grams = qty * max(grams_per_count, 85.0)
    elif u == "pinch":
        grams = qty * 0.5
    else:
        grams = qty * grams_per_count

    factor = grams / 100.0
    return {
        "calories": cal100 * factor,
        "protein_g": pro100 * factor,
        "carbs_g": carb100 * factor,
        "fat_g": fat100 * factor,
        "fiber_g": fib100 * factor,
    }


def estimate_single_food_macros(food_name: str, servings_used: float = 1.0) -> dict[str, Optional[float]]:
    nkey = _lookup_nutrition_key(food_name)
    if not nkey:
        return {
            "calories": None,
            "protein_g": None,
            "carbs_g": None,
            "fat_g": None,
            "fiber_g": None,
        }
    m = estimate_ingredient_macros(food_name, servings_used, "count")
    return {
        "calories": round(m["calories"]),
        "protein_g": round(m["protein_g"]),
        "carbs_g": round(m["carbs_g"]),
        "fat_g": round(m["fat_g"]),
        "fiber_g": round(m["fiber_g"]),
    }


def compute_recipe_macros(ingredients: list[dict], servings: float) -> dict[str, float]:
    totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "fiber_g": 0.0}
    for ing in ingredients:
        m = estimate_ingredient_macros(ing.get("name", ""), ing.get("quantity"), ing.get("unit", ""))
        for k in totals:
            totals[k] += m[k]
    srv = max(float(servings or 1.0), 0.5)
    return {
        "calories_per_serving": round(totals["calories"] / srv),
        "protein_g": round(totals["protein_g"] / srv),
        "carbs_g": round(totals["carbs_g"] / srv),
        "fat_g": round(totals["fat_g"] / srv),
        "fiber_g": round(totals["fiber_g"] / srv),
    }


@router.post("/estimate-recipe/{recipe_id}")
def estimate_recipe_nutrition(recipe_id: int, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        recipe = conn.execute("SELECT * FROM recipes WHERE id = ?", (recipe_id,)).fetchone()
        if not recipe:
            raise HTTPException(status_code=404, detail="Recipe not found")
        ings = [
            dict(r)
            for r in conn.execute(
                "SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id = ?",
                (recipe_id,),
            ).fetchall()
        ]
        macros = compute_recipe_macros(ings, recipe["servings"])
        conn.execute(
            """
            UPDATE recipes
            SET calories_per_serving = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                macros["calories_per_serving"],
                macros["protein_g"],
                macros["carbs_g"],
                macros["fat_g"],
                macros["fiber_g"],
                now,
                recipe_id,
            ),
        )
    return {"recipe_id": recipe_id, **macros}


@router.post("/estimate-text")
def estimate_text_nutrition(payload: EstimateTextPayload, user: dict = Depends(get_current_user)):
    parsed_ings = []
    for line in payload.ingredients_text.splitlines():
        txt = line.strip()
        if txt:
            parsed_ings.append(parse_ingredient_line(txt))
    return compute_recipe_macros(parsed_ings, payload.servings)


@router.get("/shortcut-status")
def get_shortcut_status(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute("SELECT shortcut_verified FROM users WHERE id = ?", (user["id"],)).fetchone()
    verified = bool(row["shortcut_verified"]) if row else False
    return {
        "shortcut_verified": verified,
        "shortcut_name": "PantryCart Log Macros",
    }


@router.post("/shortcut-verified")
def set_shortcut_verified(payload: ShortcutVerifiedPayload, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET shortcut_verified = ? WHERE id = ?",
            (1 if payload.verified else 0, user["id"]),
        )
    return {"ok": True, "shortcut_verified": payload.verified}


@router.post("/mark-logged")
def mark_slots_logged(payload: MarkLoggedPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    with get_db() as conn:
        if payload.slot_ids:
            placeholders = ",".join("?" for _ in payload.slot_ids)
            conn.execute(
                f"UPDATE meal_calendar_slots SET logged_at = ? WHERE id IN ({placeholders})",
                [now, *payload.slot_ids],
            )
        elif payload.day_name:
            if payload.person_name:
                conn.execute(
                    """
                    UPDATE meal_calendar_slots SET logged_at = ?
                    WHERE day_name = ? AND (person_name = ? OR person_name = '' OR person_name = 'Everyone')
                    """,
                    (now, payload.day_name.strip(), payload.person_name.strip()),
                )
            else:
                conn.execute(
                    "UPDATE meal_calendar_slots SET logged_at = ? WHERE day_name = ?",
                    (now, payload.day_name.strip()),
                )
    return {"ok": True, "logged_at": now}


@router.get("/ios-shortcut")
def download_ios_shortcut_template():
    """
    Generates a standard binary plist .shortcut definition for 'PantryCart Log Macros'.
    Note: iOS 15+ requires local macOS `shortcuts sign` if importing via file; our UI also
    includes a 1-tap `shortcuts://create-shortcut` guided builder directly on iPhone/iPad.
    """
    shortcut_plist = {
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowClientVersion": "2605.0.5",
        "WFWorkflowIcon": {
            "WFWorkflowIconStartColor": 4282601983,
            "WFWorkflowIconGlyphNumber": 59771,
        },
        "WFWorkflowImportQuestions": [],
        "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
        "WFWorkflowTypes": ["NCWidget", "WatchKit"],
        "WFWorkflowActions": [
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.detect.dictionary",
                "WFWorkflowActionParameters": {
                    "WFInput": {
                        "Value": {"Type": "ExtensionInput"},
                        "WFSerializationType": "WFTextTokenAttachment",
                    }
                },
            },
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.health.log",
                "WFWorkflowActionParameters": {
                    "WFHealthCategoryType": "Dietary Energy",
                    "WFHealthQuantityValue": {"Value": 0, "Unit": "kcal"},
                },
            },
        ],
    }
    raw_bytes = plistlib.dumps(shortcut_plist, fmt=plistlib.FMT_BINARY)
    return Response(
        content=raw_bytes,
        media_type="application/x-apple-shortcut",
        headers={"Content-Disposition": 'attachment; filename="PantryCart Log Macros.shortcut"'},
    )
