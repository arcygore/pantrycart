import json
import os
import sqlite3
import tempfile

from app.database import SEED_CATALOG, init_db
from app.routers.lists_router import natural_sort_key, resolve_store_department
from app.scraper import _extract_instructions, _find_recipe_json_ld
from app.units import compute_grocery_packages, is_weight_unit, parse_ingredient_line, parse_leading_quantity


def _mock_catalog():
    rows = []
    for idx, item in enumerate(SEED_CATALOG, start=1):
        canonical, display, aliases, dept, pkg_size, pkg_unit, pkg_label, is_staple = item
        rows.append(
            {
                "id": idx,
                "canonical_name": canonical,
                "display_name": display,
                "aliases_json": json.dumps(aliases),
                "default_department": dept,
                "package_size": pkg_size,
                "package_unit": pkg_unit,
                "package_label": pkg_label,
                "is_pantry_staple": is_staple,
            }
        )
    return rows


def test_parse_ingredient_lines():
    p1 = parse_ingredient_line("1 ½ lbs boneless skinless chicken breast, diced")
    assert p1["quantity"] == 1.5
    assert p1["unit"] == "lb"
    assert "chicken breast" in p1["name"]
    assert p1["prep_notes"] == "diced"

    p2 = parse_ingredient_line("2 (15 oz) cans black beans, drained and rinsed")
    assert p2["quantity"] == 30.0
    assert p2["unit"] == "oz"
    assert p2["name"] == "black beans"

    p3 = parse_ingredient_line("3-4 cloves garlic, minced")
    assert p3["quantity"] == 4.0
    assert p3["unit"] == "clove"
    assert p3["name"] == "garlic"

    # Issue #6: percentages and lean/fat ratios must stay in the item name
    q_pct, r_pct = parse_leading_quantity("2% milk")
    assert q_pct is None and r_pct == "2% milk"
    q_ratio, r_ratio = parse_leading_quantity("80/20 ground beef")
    assert q_ratio is None and r_ratio == "80/20 ground beef"

    # Issue #6: multiplier syntax ("2x bananas" and "bananas x3")
    q_lead, r_lead = parse_leading_quantity("2x bananas")
    assert q_lead == 2.0 and r_lead == "bananas"
    q_trail, r_trail = parse_leading_quantity("bananas x3")
    assert q_trail == 3.0 and r_trail == "bananas"

    assert is_weight_unit("lb") is True
    assert is_weight_unit("oz") is True
    assert is_weight_unit("15 oz can") is False


def test_compute_us_grocery_packages():
    catalog = _mock_catalog()
    entries = [
        {"name": "garlic", "quantity": 4, "unit": "clove", "recipe_title": "Tuscan Chicken"},
        {"name": "garlic", "quantity": 3, "unit": "clove", "recipe_title": "Taco Skillet"},
        {"name": "chicken broth", "quantity": 3, "unit": "cup", "recipe_title": "Tuscan Chicken"},
        {"name": "chicken broth", "quantity": 2, "unit": "cup", "recipe_title": "Soup"},
        {"name": "kosher salt", "quantity": 1, "unit": "tsp", "recipe_title": "Tuscan Chicken"},
    ]
    pkgs = {p["item_key"]: p for p in compute_grocery_packages(entries, catalog)}

    # 7 cloves total -> 1 head (~10 cloves)
    assert pkgs["garlic"]["buy_qty"] == 1.0
    assert "head" in pkgs["garlic"]["buy_unit"]

    # 5 cups = 40 fl oz -> 2 cartons (32 oz each)
    assert pkgs["chicken broth"]["buy_qty"] == 2.0
    assert "32 oz" in pkgs["chicken broth"]["buy_unit"]

    # Salt is flagged as a pantry staple (unchecked by default)
    assert pkgs["kosher salt"]["is_pantry_staple"] is True
    assert pkgs["kosher salt"]["include_by_default"] is False

    # Issue #4: bulk weight items stay in weight units without ceiling to integer
    w_entries = [{"name": "sweet potato", "quantity": 1.5, "unit": "lb", "recipe_title": "Roast"}]
    w_pkgs = {p["item_key"]: p for p in compute_grocery_packages(w_entries, catalog)}
    assert w_pkgs["sweet potato"]["buy_qty"] == 1.5
    assert w_pkgs["sweet potato"]["buy_unit"] == "lb"
    assert w_pkgs["sweet potato"]["is_weight"] is True


def test_natural_aisle_sort_and_department_bridge():
    aisles = ["10", "2", "7B", "7A", ""]
    sorted_aisles = sorted(aisles, key=natural_sort_key)
    assert sorted_aisles == ["2", "7A", "7B", "10", ""]

    publix_depts = ["Produce", "Deli & Bakery", "Meat & Seafood", "Dry Goods", "Dairy & Eggs"]
    assert resolve_store_department("Bakery & Deli", publix_depts) == "Deli & Bakery"


def test_json_ld_extraction():
    sample = {
        "@context": "https://schema.org",
        "@graph": [
            {"@type": "WebSite", "name": "Blog"},
            {
                "@type": "Recipe",
                "name": "Test Soup",
                "recipeInstructions": [
                    {"@type": "HowToSection", "name": "Prep", "itemListElement": [{"@type": "HowToStep", "text": "Chop onions."}]}
                ],
            },
        ],
    }
    found = _find_recipe_json_ld(sample)
    assert found is not None
    assert found["name"] == "Test Soup"
    steps = _extract_instructions(found["recipeInstructions"])
    assert steps == ["[Prep] Chop onions."]


def test_db_init_smoke():
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["PANTRY_DB_PATH"] = os.path.join(tmpdir, "test.db")
        import app.config
        import app.database

        app.config.DB_PATH = os.environ["PANTRY_DB_PATH"]
        app.database.DB_PATH = os.environ["PANTRY_DB_PATH"]
        init_db()
        assert os.path.exists(app.database.DB_PATH)
        conn = sqlite3.connect(app.database.DB_PATH)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert {"staple_lists", "kroger_product_prefs", "user_recipe_prefs"}.issubset(tables)
        sli_cols = {r[1] for r in conn.execute("PRAGMA table_info(shopping_list_items)").fetchall()}
        assert "price" in sli_cols
        loc_cols = {r[1] for r in conn.execute("PRAGMA table_info(item_store_locations)").fetchall()}
        assert "source" in loc_cols
        tpl_cols = {r[1] for r in conn.execute("PRAGMA table_info(weekly_template_items)").fetchall()}
        assert "staple_list_id" in tpl_cols
        conn.close()
