import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from app.config import DB_PATH


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def get_db():
    db_file = Path(DB_PATH)
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_file), timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_guest INTEGER NOT NULL DEFAULT 0,
    shortcut_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    store_type TEXT NOT NULL DEFAULT 'grocery',
    chain TEXT NOT NULL DEFAULT '',
    departments_json TEXT NOT NULL,
    aisle_departments_json TEXT NOT NULL,
    kroger_location_id TEXT NOT NULL DEFAULT '',
    kroger_location_name TEXT NOT NULL DEFAULT '',
    kroger_location_address TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_store_paths (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    departments_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS product_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    default_department TEXT NOT NULL DEFAULT 'Dry Goods',
    package_size REAL NOT NULL DEFAULT 1,
    package_unit TEXT NOT NULL DEFAULT 'count',
    package_label TEXT NOT NULL DEFAULT '1 item',
    is_pantry_staple INTEGER NOT NULL DEFAULT 0,
    store_type TEXT NOT NULL DEFAULT 'grocery'
);

CREATE TABLE IF NOT EXISTS item_store_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_key TEXT NOT NULL,
    item_display TEXT NOT NULL,
    store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    aisle TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL,
    UNIQUE(item_key, store_id)
);

CREATE TABLE IF NOT EXISTS kroger_product_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    upc TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_key)
);

CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    servings REAL NOT NULL DEFAULT 4,
    prep_minutes INTEGER,
    cook_minutes INTEGER,
    source_url TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    steps_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    calories_per_serving REAL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    fiber_g REAL,
    custom_portions REAL,
    original_ingredients_json TEXT NOT NULL DEFAULT '[]',
    original_steps_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    raw_text TEXT NOT NULL,
    quantity REAL,
    unit TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    prep_notes TEXT NOT NULL DEFAULT '',
    catalog_id INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meal_plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    scale REAL NOT NULL DEFAULT 1.0,
    day_label TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_calendar_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_name TEXT NOT NULL,
    meal_slot TEXT NOT NULL,
    plan_item_id INTEGER REFERENCES meal_plan_items(id) ON DELETE CASCADE,
    custom_title TEXT NOT NULL DEFAULT '',
    servings_used REAL NOT NULL DEFAULT 1.0,
    person_name TEXT NOT NULL DEFAULT 'Everyone',
    notes TEXT NOT NULL DEFAULT '',
    calories REAL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    fiber_g REAL,
    logged_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kroger_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    redirect_uri TEXT NOT NULL DEFAULT '',
    location_id TEXT NOT NULL DEFAULT '',
    location_name TEXT NOT NULL DEFAULT '',
    location_address TEXT NOT NULL DEFAULT '',
    location_chain TEXT NOT NULL DEFAULT 'Kroger',
    linked_store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kroger_user_tokens (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    list_type TEXT NOT NULL DEFAULT 'weekly',
    store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staple_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_template_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    item_key TEXT NOT NULL,
    buy_qty REAL NOT NULL DEFAULT 1,
    buy_unit TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT 'Produce',
    notes TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    staple_list_id INTEGER REFERENCES staple_lists(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_recipe_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, recipe_id)
);

CREATE TABLE IF NOT EXISTS pantry_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    item_key TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL DEFAULT 'Canned & Jarred Goods',
    quantity_note TEXT NOT NULL DEFAULT 'In Stock',
    in_stock INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    item_key TEXT NOT NULL,
    buy_qty REAL NOT NULL DEFAULT 1,
    buy_unit TEXT NOT NULL DEFAULT '',
    needed_summary TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    aisle TEXT NOT NULL DEFAULT '',
    price REAL,
    source_recipes_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,
    checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    checked_at TEXT,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON shopping_list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_store_loc_lookup ON item_store_locations(store_id, item_key);
CREATE INDEX IF NOT EXISTS idx_recipe_ing_recipe ON recipe_ingredients(recipe_id);
"""

GROCERY_DEPARTMENTS = [
    "Produce",
    "Bakery & Deli",
    "Meat & Seafood",
    "Dry Goods",
    "Beverages",
    "Frozen",
    "Dairy & Eggs",
    "Household & Personal",
    "Other",
]

GROCERY_AISLE_DEPTS = ["Dry Goods", "Beverages", "Household & Personal"]

DEFAULT_STORES = [
    {
        "name": "Kroger",
        "store_type": "grocery",
        "chain": "Kroger",
        "departments": GROCERY_DEPARTMENTS,
        "aisle_departments": GROCERY_AISLE_DEPTS,
        "is_default": 1,
    },
    {
        "name": "Publix",
        "store_type": "grocery",
        "chain": "Publix",
        "departments": [
            "Produce",
            "Deli & Bakery",
            "Meat & Seafood",
            "Dry Goods",
            "Beverages",
            "Dairy & Eggs",
            "Frozen",
            "Household & Personal",
            "Other",
        ],
        "aisle_departments": GROCERY_AISLE_DEPTS,
        "is_default": 0,
    },
    {
        "name": "Whole Foods",
        "store_type": "grocery",
        "chain": "Whole Foods",
        "departments": [
            "Produce",
            "Bakery & Prepared",
            "Meat & Seafood",
            "Dry Goods",
            "Dairy & Eggs",
            "Frozen",
            "Beverages",
            "Whole Body & Household",
            "Other",
        ],
        "aisle_departments": ["Dry Goods", "Beverages", "Whole Body & Household"],
        "is_default": 0,
    },
    {
        "name": "Costco",
        "store_type": "warehouse",
        "chain": "Costco",
        "departments": [
            "Produce Walk-In",
            "Bakery",
            "Deli & Prepared",
            "Meat & Seafood",
            "Center Aisles & Dry Goods",
            "Beverages & Snacks",
            "Refrigerated & Dairy",
            "Frozen",
            "Household & Paper",
            "Pharmacy & Other",
        ],
        "aisle_departments": ["Center Aisles & Dry Goods", "Beverages & Snacks", "Household & Paper"],
        "is_default": 0,
    },
    {
        "name": "Home Depot",
        "store_type": "hardware",
        "chain": "Home Depot",
        "departments": [
            "Lumber & Building",
            "Hardware & Fasteners",
            "Tools",
            "Electrical & Lighting",
            "Plumbing",
            "Paint & Supplies",
            "Storage & Organization",
            "Garden & Outdoor",
            "Kitchen, Bath & Flooring",
            "Other",
        ],
        "aisle_departments": [
            "Lumber & Building",
            "Hardware & Fasteners",
            "Tools",
            "Electrical & Lighting",
            "Plumbing",
            "Paint & Supplies",
            "Storage & Organization",
            "Kitchen, Bath & Flooring",
        ],
        "is_default": 0,
    },
    {
        "name": "IKEA",
        "store_type": "home",
        "chain": "IKEA",
        "departments": [
            "Showroom",
            "Cookware & Tableware",
            "Textiles & Rugs",
            "Lighting",
            "Bathroom",
            "Home Organization & Storage",
            "Decoration & Frames",
            "Self-Serve Warehouse",
            "Swedish Food Market",
            "Other",
        ],
        "aisle_departments": ["Self-Serve Warehouse", "Home Organization & Storage"],
        "is_default": 0,
    },
]

# Tuple format:
# (canonical_name, display_name, aliases, default_department, package_size, package_unit, package_label, is_pantry_staple)
SEED_CATALOG = [
    # Produce
    ("garlic", "Garlic", ["cloves garlic", "garlic clove", "garlic cloves", "minced garlic", "head garlic"], "Produce", 10, "clove", "head (~10 cloves)", 0),
    ("yellow onion", "Yellow Onion", ["onion", "onions", "yellow onions", "sweet onion", "white onion", "medium onion", "large onion"], "Produce", 1, "count", "onion", 0),
    ("red onion", "Red Onion", ["red onions"], "Produce", 1, "count", "red onion", 0),
    ("green onion", "Green Onions (Scallions)", ["green onions", "scallion", "scallions", "spring onion", "spring onions"], "Produce", 1, "bunch", "bunch", 0),
    ("shallot", "Shallots", ["shallots"], "Produce", 1, "count", "shallot", 0),
    ("tomato", "Tomatoes", ["tomatoes", "roma tomato", "roma tomatoes", "vine tomato"], "Produce", 1, "count", "tomato", 0),
    ("cherry tomatoes", "Cherry Tomatoes", ["grape tomatoes", "pint cherry tomatoes"], "Produce", 10, "oz", "10 oz pint", 0),
    ("potato", "Potatoes", ["potatoes", "russet potato", "russet potatoes", "yukon gold potatoes", "gold potatoes"], "Produce", 5, "lb", "5 lb bag", 0),
    ("sweet potato", "Sweet Potatoes", ["sweet potatoes", "yam", "yams"], "Produce", 1, "lb", "lb", 0),
    ("carrot", "Carrots", ["carrots", "baby carrots"], "Produce", 16, "oz", "1 lb bag", 0),
    ("celery", "Celery", ["celery stalk", "celery stalks", "celery rib", "celery ribs"], "Produce", 1, "bunch", "bunch", 0),
    ("bell pepper", "Bell Pepper", ["bell peppers", "red bell pepper", "green bell pepper", "yellow bell pepper", "orange bell pepper"], "Produce", 1, "count", "bell pepper", 0),
    ("jalapeno", "Jalapeño", ["jalapenos", "jalapeño", "jalapeños"], "Produce", 1, "count", "jalapeño", 0),
    ("broccoli", "Broccoli", ["broccoli crowns", "broccoli florets", "head broccoli"], "Produce", 1, "lb", "lb / crown", 0),
    ("spinach", "Fresh Spinach", ["spinach", "baby spinach"], "Produce", 5, "oz", "5 oz clamshell", 0),
    ("kale", "Kale", ["lacinato kale", "curly kale"], "Produce", 1, "bunch", "bunch", 0),
    ("lettuce", "Lettuce / Greens", ["romaine", "romaine lettuce", "mixed greens", "spring mix", "iceberg lettuce"], "Produce", 1, "head", "head / clamshell", 0),
    ("cucumber", "Cucumber", ["cucumbers", "english cucumber"], "Produce", 1, "count", "cucumber", 0),
    ("zucchini", "Zucchini", ["zucchinis", "courgette"], "Produce", 1, "count", "zucchini", 0),
    ("mushroom", "Mushrooms", ["mushrooms", "cremini mushrooms", "baby bella", "button mushrooms", "white mushrooms"], "Produce", 8, "oz", "8 oz package", 0),
    ("avocado", "Avocado", ["avocados"], "Produce", 1, "count", "avocado", 0),
    ("lemon", "Lemon", ["lemons", "lemon juice", "fresh lemon juice"], "Produce", 1, "count", "lemon", 0),
    ("lime", "Lime", ["limes", "lime juice", "fresh lime juice"], "Produce", 1, "count", "lime", 0),
    ("banana", "Bananas", ["bananas"], "Produce", 1, "bunch", "bunch (~6 bananas)", 0),
    ("apple", "Apples", ["apples", "honeycrisp", "gala apples", "granny smith"], "Produce", 1, "count", "apple", 0),
    ("cilantro", "Fresh Cilantro", ["cilantro", "fresh cilantro leaves"], "Produce", 1, "bunch", "bunch", 0),
    ("parsley", "Fresh Parsley", ["parsley", "flat-leaf parsley", "italian parsley"], "Produce", 1, "bunch", "bunch", 0),
    ("basil", "Fresh Basil", ["basil", "fresh basil leaves", "sweet basil"], "Produce", 0.75, "oz", "0.75 oz clamshell", 0),
    ("ginger", "Fresh Ginger", ["ginger", "fresh ginger root", "ginger root", "grated ginger"], "Produce", 1, "count", "piece (~4 oz)", 0),

    # Meat & Seafood
    ("chicken breast", "Chicken Breast", ["boneless skinless chicken breast", "boneless skinless chicken breasts", "chicken breasts"], "Meat & Seafood", 1.5, "lb", "1.5 lb pack", 0),
    ("chicken thighs", "Chicken Thighs", ["boneless skinless chicken thighs", "chicken thigh"], "Meat & Seafood", 1.5, "lb", "1.5 lb pack", 0),
    ("ground beef", "Ground Beef", ["lean ground beef", "80/20 ground beef", "90/10 ground beef", "beef"], "Meat & Seafood", 1, "lb", "1 lb pack", 0),
    ("ground turkey", "Ground Turkey", ["lean ground turkey"], "Meat & Seafood", 1, "lb", "1 lb pack", 0),
    ("italian sausage", "Italian Sausage", ["sausage", "pork sausage", "mild italian sausage", "hot italian sausage"], "Meat & Seafood", 16, "oz", "16 oz pack", 0),
    ("bacon", "Bacon", ["thick cut bacon", "strips bacon", "slices bacon"], "Meat & Seafood", 16, "oz", "16 oz pack", 0),
    ("salmon", "Salmon Fillets", ["salmon fillet", "atlantic salmon"], "Meat & Seafood", 1, "lb", "1 lb", 0),
    ("shrimp", "Shrimp", ["raw shrimp", "peeled shrimp", "large shrimp"], "Meat & Seafood", 16, "oz", "16 oz bag", 0),
    ("pork chops", "Pork Chops", ["boneless pork chops", "pork tenderloin"], "Meat & Seafood", 1.5, "lb", "1.5 lb pack", 0),

    # Dairy & Eggs
    ("eggs", "Eggs", ["egg", "large eggs", "large egg"], "Dairy & Eggs", 12, "count", "dozen (12)", 0),
    ("butter", "Butter", ["unsalted butter", "salted butter", "stick butter", "sticks butter"], "Dairy & Eggs", 16, "oz", "1 lb box (4 sticks)", 0),
    ("milk", "Milk", ["whole milk", "2% milk", "skim milk"], "Dairy & Eggs", 64, "fl_oz", "half gallon (64 oz)", 0),
    ("heavy cream", "Heavy Whipping Cream", ["heavy whipping cream", "whipping cream", "cream"], "Dairy & Eggs", 16, "fl_oz", "16 oz pint", 0),
    ("half and half", "Half & Half", ["half & half"], "Dairy & Eggs", 16, "fl_oz", "16 oz pint", 0),
    ("sour cream", "Sour Cream", ["light sour cream"], "Dairy & Eggs", 16, "oz", "16 oz tub", 0),
    ("cream cheese", "Cream Cheese", ["neufchatel cheese"], "Dairy & Eggs", 8, "oz", "8 oz block", 0),
    ("greek yogurt", "Greek Yogurt", ["plain greek yogurt", "yogurt"], "Dairy & Eggs", 32, "oz", "32 oz tub", 0),
    ("cheddar cheese", "Shredded Cheddar Cheese", ["shredded cheddar", "sharp cheddar", "cheddar"], "Dairy & Eggs", 8, "oz", "8 oz bag", 0),
    ("mozzarella cheese", "Mozzarella Cheese", ["shredded mozzarella", "fresh mozzarella", "mozzarella"], "Dairy & Eggs", 8, "oz", "8 oz bag/ball", 0),
    ("parmesan cheese", "Parmesan Cheese", ["grated parmesan", "parmigiano reggiano", "shredded parmesan", "parmesan"], "Dairy & Eggs", 5, "oz", "5 oz tub/wedge", 0),
    ("feta cheese", "Feta Cheese", ["crumbled feta", "feta"], "Dairy & Eggs", 6, "oz", "6 oz tub", 0),

    # Dry Goods (Aisle items!)
    ("all-purpose flour", "All-Purpose Flour", ["flour", "all purpose flour", "unbleached flour"], "Dry Goods", 80, "oz", "5 lb bag", 1),
    ("granulated sugar", "Granulated Sugar", ["sugar", "white sugar"], "Dry Goods", 64, "oz", "4 lb bag", 1),
    ("brown sugar", "Brown Sugar", ["light brown sugar", "dark brown sugar", "packed brown sugar"], "Dry Goods", 32, "oz", "2 lb bag", 1),
    ("powdered sugar", "Powdered Sugar", ["confectioners sugar", "icing sugar"], "Dry Goods", 32, "oz", "2 lb bag", 1),
    ("baking powder", "Baking Powder", [], "Dry Goods", 8.1, "oz", "8.1 oz can", 1),
    ("baking soda", "Baking Soda", [], "Dry Goods", 16, "oz", "16 oz box", 1),
    ("vanilla extract", "Vanilla Extract", ["pure vanilla extract", "vanilla"], "Dry Goods", 2, "fl_oz", "2 oz bottle", 1),
    ("cornstarch", "Cornstarch", ["corn starch"], "Dry Goods", 16, "oz", "16 oz tub", 1),
    ("olive oil", "Olive Oil", ["extra virgin olive oil", "extra-virgin olive oil", "evoo"], "Dry Goods", 16.9, "fl_oz", "16.9 oz bottle", 1),
    ("vegetable oil", "Vegetable / Canola Oil", ["canola oil", "neutral oil", "cooking oil"], "Dry Goods", 48, "fl_oz", "48 oz bottle", 1),
    ("sesame oil", "Toasted Sesame Oil", ["toasted sesame oil"], "Dry Goods", 5, "fl_oz", "5 oz bottle", 1),
    ("soy sauce", "Soy Sauce", ["low sodium soy sauce", "low-sodium soy sauce", "tamari"], "Dry Goods", 15, "fl_oz", "15 oz bottle", 1),
    ("balsamic vinegar", "Balsamic Vinegar", [], "Dry Goods", 16.9, "fl_oz", "16.9 oz bottle", 1),
    ("apple cider vinegar", "Apple Cider Vinegar", ["cider vinegar"], "Dry Goods", 16, "fl_oz", "16 oz bottle", 1),
    ("white vinegar", "White Vinegar", ["distilled white vinegar"], "Dry Goods", 32, "fl_oz", "32 oz bottle", 1),
    ("rice vinegar", "Rice Vinegar", ["seasoned rice vinegar"], "Dry Goods", 12, "fl_oz", "12 oz bottle", 1),
    ("honey", "Honey", [], "Dry Goods", 12, "oz", "12 oz bear/bottle", 1),
    ("maple syrup", "Maple Syrup", ["pure maple syrup"], "Dry Goods", 12, "fl_oz", "12 oz bottle", 1),
    ("dijon mustard", "Dijon Mustard", ["mustard"], "Dry Goods", 12, "oz", "12 oz jar", 1),
    ("mayonnaise", "Mayonnaise", ["mayo"], "Dry Goods", 30, "fl_oz", "30 oz jar", 1),
    ("ketchup", "Ketchup", [], "Dry Goods", 20, "oz", "20 oz bottle", 1),
    ("peanut butter", "Peanut Butter", ["creamy peanut butter"], "Dry Goods", 16, "oz", "16 oz jar", 0),
    ("chicken broth", "Chicken Broth", ["chicken stock", "low sodium chicken broth", "low-sodium chicken broth"], "Dry Goods", 32, "fl_oz", "32 oz carton", 0),
    ("beef broth", "Beef Broth", ["beef stock"], "Dry Goods", 32, "fl_oz", "32 oz carton", 0),
    ("vegetable broth", "Vegetable Broth", ["vegetable stock"], "Dry Goods", 32, "fl_oz", "32 oz carton", 0),
    ("black beans", "Black Beans (Canned)", ["canned black beans"], "Dry Goods", 15, "oz", "15 oz can", 0),
    ("kidney beans", "Kidney Beans (Canned)", ["red kidney beans"], "Dry Goods", 15, "oz", "15 oz can", 0),
    ("chickpeas", "Chickpeas (Garbanzo Beans)", ["garbanzo beans", "canned chickpeas"], "Dry Goods", 15, "oz", "15 oz can", 0),
    ("diced tomatoes", "Diced Tomatoes (Canned)", ["canned diced tomatoes", "fire roasted diced tomatoes"], "Dry Goods", 14.5, "oz", "14.5 oz can", 0),
    ("crushed tomatoes", "Crushed Tomatoes (Canned)", ["tomato puree", "san marzano tomatoes", "whole peeled tomatoes"], "Dry Goods", 28, "oz", "28 oz can", 0),
    ("tomato paste", "Tomato Paste", [], "Dry Goods", 6, "oz", "6 oz can / 4.5 oz tube", 0),
    ("tomato sauce", "Marinara / Pasta Sauce", ["pasta sauce", "marinara", "marinara sauce"], "Dry Goods", 24, "oz", "24 oz jar", 0),
    ("coconut milk", "Coconut Milk (Canned)", ["full fat coconut milk", "unsweetened coconut milk"], "Dry Goods", 13.5, "fl_oz", "13.5 oz can", 0),
    ("sun-dried tomatoes", "Sun-Dried Tomatoes", ["sundried tomatoes"], "Dry Goods", 8.5, "oz", "8.5 oz jar", 0),
    ("pasta", "Pasta (Dry)", ["spaghetti", "penne", "rigatoni", "fettuccine", "rotini", "macaroni", "elbow macaroni"], "Dry Goods", 16, "oz", "16 oz (1 lb) box", 0),
    ("white rice", "White Rice", ["jasmine rice", "basmati rice", "long grain rice", "rice"], "Dry Goods", 32, "oz", "2 lb bag", 0),
    ("brown rice", "Brown Rice", [], "Dry Goods", 32, "oz", "2 lb bag", 0),
    ("quinoa", "Quinoa", [], "Dry Goods", 16, "oz", "16 oz bag", 0),
    ("rolled oats", "Rolled Oats", ["old fashioned oats", "oats", "quick oats"], "Dry Goods", 42, "oz", "42 oz canister", 0),
    ("breadcrumbs", "Breadcrumbs / Panko", ["panko", "panko breadcrumbs", "italian breadcrumbs"], "Dry Goods", 8, "oz", "8 oz canister", 0),
    ("tortillas", "Tortillas", ["flour tortillas", "corn tortillas", "taco tortillas"], "Dry Goods", 10, "count", "10-count pack", 0),
    ("salsa", "Salsa", [], "Dry Goods", 16, "oz", "16 oz jar", 0),

    # Spices & Seasonings (Pantry Staples)
    ("kosher salt", "Kosher Salt", ["salt", "sea salt", "table salt", "fine salt"], "Dry Goods", 16, "oz", "box", 1),
    ("black pepper", "Black Pepper", ["pepper", "ground black pepper", "freshly ground black pepper"], "Dry Goods", 3, "oz", "jar", 1),
    ("garlic powder", "Garlic Powder", [], "Dry Goods", 3, "oz", "jar", 1),
    ("onion powder", "Onion Powder", [], "Dry Goods", 3, "oz", "jar", 1),
    ("paprika", "Paprika", ["smoked paprika", "sweet paprika"], "Dry Goods", 2.5, "oz", "jar", 1),
    ("ground cumin", "Ground Cumin", ["cumin"], "Dry Goods", 2.5, "oz", "jar", 1),
    ("chili powder", "Chili Powder", [], "Dry Goods", 2.5, "oz", "jar", 1),
    ("italian seasoning", "Italian Seasoning", [], "Dry Goods", 1, "oz", "jar", 1),
    ("dried oregano", "Dried Oregano", ["oregano"], "Dry Goods", 1, "oz", "jar", 1),
    ("dried thyme", "Dried Thyme", ["thyme"], "Dry Goods", 1, "oz", "jar", 1),
    ("cinnamon", "Ground Cinnamon", ["ground cinnamon"], "Dry Goods", 2.5, "oz", "jar", 1),
    ("red pepper flakes", "Crushed Red Pepper Flakes", ["crushed red pepper", "chili flakes"], "Dry Goods", 1.5, "oz", "jar", 1),
    ("bay leaves", "Bay Leaves", ["bay leaf"], "Dry Goods", 0.5, "oz", "jar", 1),

    # Bakery & Deli
    ("bread", "Bread (Loaf)", ["sandwich bread", "sourdough bread", "sourdough", "french bread", "baguette"], "Bakery & Deli", 1, "count", "loaf", 0),
    ("hamburger buns", "Hamburger / Brioche Buns", ["buns", "brioche buns", "hot dog buns"], "Bakery & Deli", 8, "count", "8-count pack", 0),

    # Frozen
    ("frozen peas", "Frozen Peas", ["green peas", "peas"], "Frozen", 12, "oz", "12 oz bag", 0),
    ("frozen corn", "Frozen Corn", ["sweet corn"], "Frozen", 12, "oz", "12 oz bag", 0),
    ("frozen berries", "Frozen Berries", ["frozen blueberries", "frozen strawberries", "mixed berries"], "Frozen", 16, "oz", "16 oz bag", 0),

    # Beverages & Household
    ("coffee", "Coffee", ["ground coffee", "coffee beans", "whole bean coffee"], "Beverages", 12, "oz", "12 oz bag", 0),
    ("paper towels", "Paper Towels", [], "Household & Personal", 6, "count", "6-roll pack", 0),
    ("toilet paper", "Toilet Paper", [], "Household & Personal", 12, "count", "12-roll pack", 0),
    ("dish soap", "Dish Soap", [], "Household & Personal", 16, "fl_oz", "16 oz bottle", 0),
    ("trash bags", "Trash Bags", ["garbage bags"], "Household & Personal", 40, "count", "40-count box", 0),
    ("chicken tenderloins", "Chicken Tenderloins", ["chicken tenders", "boneless chicken tenderloins"], "Meat & Seafood", 1.25, "lb", "1.25 lb pack", 0),
    ("salad mix", "Salad Mix", ["salad kit", "chopped salad kit", "spring mix salad"], "Produce", 1, "bag", "bag / clamshell", 0),
    ("brussels sprouts", "Brussels Sprouts", ["brussel sprouts", "fresh brussels sprouts"], "Produce", 1, "lb", "1 lb bag", 0),
]

SEED_WEEKLY_TEMPLATE = [
    ("Bananas", "banana", 1, "bunch (~6 bananas)", "Produce"),
    ("Chicken Tenderloins", "chicken tenderloins", 1, "1.25 lb pack", "Meat & Seafood"),
    ("Salad Mix", "salad mix", 2, "bag / clamshell", "Produce"),
    ("Eggs", "eggs", 1, "dozen (12)", "Dairy & Eggs"),
    ("Milk", "milk", 1, "half gallon (64 oz)", "Dairy & Eggs"),
]

SEED_PANTRY = [
    # Spices & Seasonings
    ("Kosher Salt", "kosher salt", "Spices & Seasonings", "Full box", 1),
    ("Black Pepper", "black pepper", "Spices & Seasonings", "Full grinder", 1),
    ("Garlic Powder", "garlic powder", "Spices & Seasonings", "In Stock", 1),
    ("Onion Powder", "onion powder", "Spices & Seasonings", "In Stock", 1),
    ("Paprika", "paprika", "Spices & Seasonings", "In Stock", 1),
    ("Ground Cumin", "ground cumin", "Spices & Seasonings", "In Stock", 1),
    ("Chili Powder", "chili powder", "Spices & Seasonings", "In Stock", 1),
    ("Italian Seasoning", "italian seasoning", "Spices & Seasonings", "In Stock", 1),
    ("Dried Oregano", "dried oregano", "Spices & Seasonings", "In Stock", 1),
    ("Dried Thyme", "dried thyme", "Spices & Seasonings", "In Stock", 1),
    ("Ground Cinnamon", "cinnamon", "Spices & Seasonings", "In Stock", 1),
    ("Crushed Red Pepper Flakes", "red pepper flakes", "Spices & Seasonings", "In Stock", 1),
    # Oils, Vinegars & Condiments
    ("Olive Oil", "olive oil", "Oils, Vinegars & Condiments", "1 bottle", 1),
    ("Vegetable / Canola Oil", "vegetable oil", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Soy Sauce", "soy sauce", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Balsamic Vinegar", "balsamic vinegar", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Apple Cider Vinegar", "apple cider vinegar", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Dijon Mustard", "dijon mustard", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Mayonnaise", "mayonnaise", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Ketchup", "ketchup", "Oils, Vinegars & Condiments", "In Stock", 1),
    ("Honey", "honey", "Oils, Vinegars & Condiments", "In Stock", 1),
    # Canned & Jarred Goods
    ("Black Beans (Canned)", "black beans", "Canned & Jarred Goods", "2 cans", 1),
    ("Diced Tomatoes (Canned)", "diced tomatoes", "Canned & Jarred Goods", "2 cans", 1),
    ("Chicken Broth", "chicken broth", "Canned & Jarred Goods", "1 carton", 1),
    ("Marinara / Pasta Sauce", "tomato sauce", "Canned & Jarred Goods", "1 jar", 1),
    # Baking & Cooking Staples
    ("All-Purpose Flour", "all-purpose flour", "Baking & Cooking Staples", "5 lb bag", 1),
    ("Granulated Sugar", "granulated sugar", "Baking & Cooking Staples", "In Stock", 1),
    ("Brown Sugar", "brown sugar", "Baking & Cooking Staples", "In Stock", 1),
    ("Baking Powder", "baking powder", "Baking & Cooking Staples", "In Stock", 1),
    ("Baking Soda", "baking soda", "Baking & Cooking Staples", "In Stock", 1),
    ("Vanilla Extract", "vanilla extract", "Baking & Cooking Staples", "In Stock", 1),
    ("Cornstarch", "cornstarch", "Baking & Cooking Staples", "In Stock", 1),
    # Grains, Pasta & Dry Goods
    ("White Rice", "white rice", "Grains, Pasta & Dry Goods", "2 lb bag", 1),
    ("Pasta (Dry)", "pasta", "Grains, Pasta & Dry Goods", "1 box", 1),
    ("Rolled Oats", "rolled oats", "Grains, Pasta & Dry Goods", "In Stock", 1),
]


def _run_migrations(conn: sqlite3.Connection):
    store_cols = {r["name"] for r in conn.execute("PRAGMA table_info(stores)").fetchall()}
    if "sort_order" not in store_cols:
        conn.execute("ALTER TABLE stores ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE stores SET sort_order = id WHERE sort_order = 0")

    list_cols = {r["name"] for r in conn.execute("PRAGMA table_info(shopping_lists)").fetchall()}
    if "sort_order" not in list_cols:
        conn.execute("ALTER TABLE shopping_lists ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE shopping_lists SET sort_order = id WHERE sort_order = 0")

    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "shortcut_verified" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN shortcut_verified INTEGER NOT NULL DEFAULT 0")
    if "is_guest" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_store_paths (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
            departments_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, store_id)
        )
        """
    )

    recipe_cols = {r["name"] for r in conn.execute("PRAGMA table_info(recipes)").fetchall()}
    for col_name, col_type in [
        ("calories_per_serving", "REAL"),
        ("protein_g", "REAL"),
        ("carbs_g", "REAL"),
        ("fat_g", "REAL"),
        ("fiber_g", "REAL"),
        ("custom_portions", "REAL"),
        ("original_ingredients_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("original_steps_json", "TEXT NOT NULL DEFAULT '[]'"),
    ]:
        if col_name not in recipe_cols:
            conn.execute(f"ALTER TABLE recipes ADD COLUMN {col_name} {col_type}")

    # Backfill baseline original_ingredients_json and original_steps_json for existing recipes
    recipes_to_backfill = conn.execute(
        """
        SELECT id, steps_json, original_ingredients_json, original_steps_json
        FROM recipes
        WHERE original_ingredients_json IS NULL
           OR original_ingredients_json = ''
           OR original_ingredients_json = '[]'
           OR original_steps_json IS NULL
           OR original_steps_json = ''
           OR original_steps_json = '[]'
        """
    ).fetchall()
    for r in recipes_to_backfill:
        orig_ings_json = r["original_ingredients_json"] or "[]"
        if orig_ings_json in ("", "[]"):
            ing_rows = conn.execute(
                """
                SELECT raw_text, quantity, unit, name, prep_notes
                FROM recipe_ingredients
                WHERE recipe_id = ?
                ORDER BY sort_order ASC, id ASC
                """,
                (r["id"],),
            ).fetchall()
            if ing_rows:
                orig_ings_json = json.dumps([dict(x) for x in ing_rows])
        orig_steps_json = r["original_steps_json"] or "[]"
        if orig_steps_json in ("", "[]") and r["steps_json"] not in (None, "", "[]"):
            orig_steps_json = r["steps_json"]
        conn.execute(
            "UPDATE recipes SET original_ingredients_json = ?, original_steps_json = ? WHERE id = ?",
            (orig_ings_json, orig_steps_json, r["id"]),
        )

    slot_cols = {r["name"] for r in conn.execute("PRAGMA table_info(meal_calendar_slots)").fetchall()}
    for col_name, col_type in [
        ("calories", "REAL"),
        ("protein_g", "REAL"),
        ("carbs_g", "REAL"),
        ("fat_g", "REAL"),
        ("fiber_g", "REAL"),
        ("logged_at", "TEXT"),
    ]:
        if col_name not in slot_cols:
            conn.execute(f"ALTER TABLE meal_calendar_slots ADD COLUMN {col_name} {col_type}")

    # Seed default nutrition on sample recipes if still NULL
    conn.execute(
        """
        UPDATE recipes
        SET calories_per_serving = 540, protein_g = 46, carbs_g = 11, fat_g = 34, fiber_g = 2
        WHERE title = 'Weeknight Creamy Tuscan Chicken' AND calories_per_serving IS NULL
        """
    )
    conn.execute(
        """
        UPDATE recipes
        SET calories_per_serving = 510, protein_g = 35, carbs_g = 42, fat_g = 22, fiber_g = 9
        WHERE title = 'One-Pot Black Bean & Beef Taco Skillet' AND calories_per_serving IS NULL
        """
    )

    store_cols = {r["name"] for r in conn.execute("PRAGMA table_info(stores)").fetchall()}
    for col_name in ("kroger_location_id", "kroger_location_name", "kroger_location_address"):
        if col_name not in store_cols:
            conn.execute(f"ALTER TABLE stores ADD COLUMN {col_name} TEXT NOT NULL DEFAULT ''")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    # Backfill global Kroger location onto its linked store (or first Kroger store) if not yet assigned
    try:
        kcfg = conn.execute(
            "SELECT location_id, location_name, location_address, linked_store_id FROM kroger_config WHERE id = 1"
        ).fetchone()
    except Exception:
        kcfg = None
    if kcfg and (kcfg["location_id"] or "").strip():
        target_sid = kcfg["linked_store_id"]
        if target_sid:
            target_store = conn.execute(
                "SELECT id, kroger_location_id FROM stores WHERE id = ?",
                (target_sid,),
            ).fetchone()
        else:
            target_store = conn.execute(
                "SELECT id, kroger_location_id FROM stores WHERE LOWER(chain) LIKE '%kroger%' OR LOWER(name) LIKE '%kroger%' ORDER BY sort_order ASC, id ASC LIMIT 1"
            ).fetchone()
        if target_store and not (target_store["kroger_location_id"] or "").strip():
            conn.execute(
                """
                UPDATE stores
                SET kroger_location_id = ?, kroger_location_name = ?, kroger_location_address = ?
                WHERE id = ?
                """,
                (
                    kcfg["location_id"] or "",
                    kcfg["location_name"] or "",
                    kcfg["location_address"] or "",
                    target_store["id"],
                ),
            )

    # Backfill-clean existing recipe ingredients and list items that embed parenthetical or ' - ' prep notes
    from app.units import clean_shopping_item_name, normalize_item_key

    dirty_ings = conn.execute(
        "SELECT id, name, prep_notes FROM recipe_ingredients WHERE name LIKE '%(%' OR name LIKE '% - %'"
    ).fetchall()
    for ing in dirty_ings:
        cleaned_name, extra_prep = clean_shopping_item_name(ing["name"] or "")
        if cleaned_name and cleaned_name != (ing["name"] or ""):
            existing_prep = (ing["prep_notes"] or "").strip()
            if extra_prep and extra_prep.lower() not in existing_prep.lower():
                merged_prep = f"{existing_prep}, {extra_prep}" if existing_prep else extra_prep
            else:
                merged_prep = existing_prep
            conn.execute(
                "UPDATE recipe_ingredients SET name = ?, prep_notes = ? WHERE id = ?",
                (cleaned_name, merged_prep, ing["id"]),
            )

    dirty_list_items = conn.execute(
        "SELECT id, name FROM shopping_list_items WHERE name LIKE '%(%' OR name LIKE '% - %'"
    ).fetchall()
    for li in dirty_list_items:
        cleaned_name, _ = clean_shopping_item_name(li["name"] or "")
        if cleaned_name and cleaned_name != (li["name"] or ""):
            conn.execute(
                "UPDATE shopping_list_items SET name = ?, item_key = ? WHERE id = ?",
                (cleaned_name, normalize_item_key(cleaned_name), li["id"]),
            )

    _run_issue_migrations_v15(conn)


def _run_issue_migrations_v15(conn: sqlite3.Connection):
    """Schema for GitHub issues #3, #5, #7, #8, #9, #10 (v1.5)."""
    now = _now_iso()

    # --- #3: price lives in its own column, never in notes ---
    sli_cols = {r["name"] for r in conn.execute("PRAGMA table_info(shopping_list_items)").fetchall()}
    if "price" not in sli_cols:
        conn.execute("ALTER TABLE shopping_list_items ADD COLUMN price REAL")
    # Move auto-filled "$3.49 @ Kroger" notes into the price column, and drop auto "Weekly staple" notes
    price_rows = conn.execute(
        "SELECT id, notes FROM shopping_list_items WHERE notes LIKE '$%@ Kroger'"
    ).fetchall()
    for pr in price_rows:
        m = re.match(r"^\$(\d+(?:\.\d+)?) @ Kroger$", (pr["notes"] or "").strip())
        if m:
            conn.execute(
                "UPDATE shopping_list_items SET price = ?, notes = '' WHERE id = ?",
                (float(m.group(1)), pr["id"]),
            )
    conn.execute("UPDATE shopping_list_items SET notes = '' WHERE notes IN ('Weekly staple', 'Restock pantry')")

    # --- #5 / #7: remember where an aisle came from (manual vs. kroger API) ---
    loc_cols = {r["name"] for r in conn.execute("PRAGMA table_info(item_store_locations)").fetchall()}
    if "source" not in loc_cols:
        conn.execute("ALTER TABLE item_store_locations ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")

    # --- #5: per-person preferred Kroger product for an item ---
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kroger_product_prefs (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            item_key TEXT NOT NULL,
            upc TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            brand TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, item_key)
        )
        """
    )

    # --- #9: multiple named staple lists (formerly the single "Weekly Template") ---
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS staple_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
    tpl_cols = {r["name"] for r in conn.execute("PRAGMA table_info(weekly_template_items)").fetchall()}
    if "staple_list_id" not in tpl_cols:
        conn.execute(
            "ALTER TABLE weekly_template_items ADD COLUMN staple_list_id INTEGER REFERENCES staple_lists(id) ON DELETE CASCADE"
        )
    first_staple = conn.execute("SELECT id FROM staple_lists ORDER BY sort_order ASC, id ASC LIMIT 1").fetchone()
    if not first_staple:
        cur = conn.execute(
            "INSERT INTO staple_lists (name, sort_order, created_at) VALUES (?, 1, ?)",
            ("Weekly Staples", now),
        )
        first_staple_id = cur.lastrowid
    else:
        first_staple_id = first_staple["id"]
    conn.execute(
        "UPDATE weekly_template_items SET staple_list_id = ? WHERE staple_list_id IS NULL",
        (first_staple_id,),
    )

    # --- #10: per-user recipe page layout (pinned recipes + custom order) ---
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS user_recipe_prefs (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
            pinned INTEGER NOT NULL DEFAULT 0,
            sort_order INTEGER,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, recipe_id)
        )
        """
    )


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA_SQL)
        _run_migrations(conn)
        _seed_defaults(conn)


def _seed_defaults(conn: sqlite3.Connection):
    now = _now_iso()

    # Seed stores if empty
    store_count = conn.execute("SELECT COUNT(*) FROM stores").fetchone()[0]
    if store_count == 0:
        for idx, s in enumerate(DEFAULT_STORES, start=1):
            conn.execute(
                """
                INSERT INTO stores (name, store_type, chain, departments_json, aisle_departments_json, is_default, sort_order, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    s["name"],
                    s["store_type"],
                    s["chain"],
                    json.dumps(s["departments"]),
                    json.dumps(s["aisle_departments"]),
                    s["is_default"],
                    idx,
                    now,
                ),
            )

    # Seed US product catalog if empty
    cat_count = conn.execute("SELECT COUNT(*) FROM product_catalog").fetchone()[0]
    if cat_count == 0:
        for item in SEED_CATALOG:
            canonical, display, aliases, dept, pkg_size, pkg_unit, pkg_label, is_staple = item
            conn.execute(
                """
                INSERT INTO product_catalog (
                    canonical_name, display_name, aliases_json, default_department,
                    package_size, package_unit, package_label, is_pantry_staple, store_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'grocery')
                """,
                (canonical, display, json.dumps(aliases), dept, pkg_size, pkg_unit, pkg_label, is_staple),
            )
    else:
        # Ensure newly added seed catalog items exist on upgrade
        for item in SEED_CATALOG[-3:]:
            canonical, display, aliases, dept, pkg_size, pkg_unit, pkg_label, is_staple = item
            conn.execute(
                """
                INSERT OR IGNORE INTO product_catalog (
                    canonical_name, display_name, aliases_json, default_department,
                    package_size, package_unit, package_label, is_pantry_staple, store_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'grocery')
                """,
                (canonical, display, json.dumps(aliases), dept, pkg_size, pkg_unit, pkg_label, is_staple),
            )

    # Seed default shopping lists if empty
    list_count = conn.execute("SELECT COUNT(*) FROM shopping_lists").fetchone()[0]
    if list_count == 0:
        stores = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM stores").fetchall()}
        default_lists = [
            ("Weekly Grocery Trip", "weekly", stores.get("Kroger")),
            ("Costco Run", "store", stores.get("Costco")),
            ("Home Depot", "store", stores.get("Home Depot")),
            ("IKEA", "store", stores.get("IKEA")),
        ]
        for idx, (lname, ltype, sid) in enumerate(default_lists, start=1):
            conn.execute(
                """
                INSERT INTO shopping_lists (name, list_type, store_id, is_archived, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?, ?)
                """,
                (lname, ltype, sid, idx, now, now),
            )

    # Seed weekly template items if empty
    tpl_count = conn.execute("SELECT COUNT(*) FROM weekly_template_items").fetchone()[0]
    if tpl_count == 0:
        staple_row = conn.execute("SELECT id FROM staple_lists ORDER BY sort_order ASC, id ASC LIMIT 1").fetchone()
        staple_id = staple_row["id"] if staple_row else None
        for idx, (tname, tkey, tqty, tunit, tdept) in enumerate(SEED_WEEKLY_TEMPLATE, start=1):
            conn.execute(
                """
                INSERT INTO weekly_template_items (name, item_key, buy_qty, buy_unit, department, notes, is_active, sort_order, created_at, staple_list_id)
                VALUES (?, ?, ?, ?, ?, '', 1, ?, ?, ?)
                """,
                (tname, tkey, tqty, tunit, tdept, idx, now, staple_id),
            )

    # Seed pantry items if empty
    pantry_count = conn.execute("SELECT COUNT(*) FROM pantry_items").fetchone()[0]
    if pantry_count == 0:
        for pname, pkey, pcat, pnote, pstock in SEED_PANTRY:
            conn.execute(
                """
                INSERT OR IGNORE INTO pantry_items (name, item_key, category, quantity_note, in_stock, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (pname, pkey, pcat, pnote, pstock, now),
            )

    # Seed default quick recipe filter chips if not yet stored
    if not conn.execute("SELECT 1 FROM app_settings WHERE key = 'recipe_quick_queries'").fetchone():
        default_quick_queries = [
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
        conn.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
            ("recipe_quick_queries", json.dumps(default_quick_queries), now),
        )

    # Seed sample recipes if empty
    recipe_count = conn.execute("SELECT COUNT(*) FROM recipes").fetchone()[0]
    if recipe_count == 0:
        _seed_sample_recipes(conn, now)


def _seed_sample_recipes(conn: sqlite3.Connection, now: str):
    from app.units import match_catalog_item, parse_ingredient_line

    samples = [
        {
            "title": "Weeknight Creamy Tuscan Chicken",
            "description": "Pan-seared chicken breasts in a garlicky parmesan cream sauce with sun-dried tomatoes and baby spinach.",
            "servings": 4,
            "prep_minutes": 10,
            "cook_minutes": 20,
            "calories_per_serving": 540,
            "protein_g": 46,
            "carbs_g": 11,
            "fat_g": 34,
            "fiber_g": 2,
            "tags": ["Dinner", "30-Minute", "One-Pan"],
            "steps": [
                "Season 1.5 lbs chicken breasts with kosher salt, black pepper, and Italian seasoning.",
                "Heat 1 tbsp olive oil in a large skillet over medium-high heat. Sear chicken 5-6 minutes per side until golden and cooked through (165°F). Transfer to a plate.",
                "In the same skillet, melt 2 tbsp butter over medium heat. Add 4 cloves minced garlic and cook 30 seconds until fragrant.",
                "Stir in 1/2 cup sun-dried tomatoes, 1/2 cup chicken broth, and 1 cup heavy cream. Simmer 3-4 minutes until slightly thickened.",
                "Stir in 1/2 cup grated parmesan cheese and 3 oz fresh spinach until spinach wilts.",
                "Return chicken and any juices to the skillet, spoon sauce over top, and serve warm.",
            ],
            "ingredients": [
                "1.5 lbs boneless skinless chicken breast",
                "1 tbsp olive oil",
                "2 tbsp butter",
                "4 cloves garlic, minced",
                "1/2 cup sun-dried tomatoes, chopped",
                "1/2 cup chicken broth",
                "1 cup heavy cream",
                "1/2 cup parmesan cheese, grated",
                "3 oz fresh spinach",
                "1 tsp italian seasoning",
                "1 tsp kosher salt",
                "1/2 tsp black pepper",
            ],
        },
        {
            "title": "One-Pot Black Bean & Beef Taco Skillet",
            "description": "Fast, family-friendly skillet dinner with seasoned ground beef, black beans, corn, and melted cheddar.",
            "servings": 4,
            "prep_minutes": 10,
            "cook_minutes": 20,
            "calories_per_serving": 510,
            "protein_g": 35,
            "carbs_g": 42,
            "fat_g": 22,
            "fiber_g": 9,
            "tags": ["Dinner", "Mexican", "Easy"],
            "steps": [
                "Heat 1 tbsp olive oil in a large deep skillet over medium-high heat. Add 1 diced yellow onion and 1 diced bell pepper; cook 4 minutes.",
                "Add 1 lb ground beef and 3 cloves minced garlic. Cook until beef is browned, breaking it up with a spoon; drain excess fat if needed.",
                "Stir in 1 tbsp chili powder, 1 tsp ground cumin, 1 tsp kosher salt, 1 can (15 oz) drained black beans, 1 can (14.5 oz) diced tomatoes, and 1 cup frozen corn.",
                "Bring to a simmer and cook 6-8 minutes until liquid thickens.",
                "Top with 1 cup shredded cheddar cheese, cover 2 minutes to melt, and garnish with fresh cilantro. Serve with tortillas.",
            ],
            "ingredients": [
                "1 lb ground beef",
                "1 yellow onion, diced",
                "1 bell pepper, diced",
                "3 cloves garlic, minced",
                "1 tbsp olive oil",
                "15 oz black beans, drained and rinsed",
                "14.5 oz diced tomatoes",
                "1 cup frozen corn",
                "1 tbsp chili powder",
                "1 tsp ground cumin",
                "1 tsp kosher salt",
                "1 cup cheddar cheese, shredded",
                "1/4 cup fresh cilantro, chopped",
                "8 flour tortillas",
            ],
        },
    ]

    catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
    for r in samples:
        parsed_ings = []
        for line in r["ingredients"]:
            p = parse_ingredient_line(line)
            parsed_ings.append(
                {
                    "raw_text": line,
                    "quantity": p["quantity"],
                    "unit": p["unit"],
                    "name": p["name"],
                    "prep_notes": p["prep_notes"],
                }
            )
        cur = conn.execute(
            """
            INSERT INTO recipes (
                title, description, servings, prep_minutes, cook_minutes,
                source_url, image_url, tags_json, steps_json, notes,
                calories_per_serving, protein_g, carbs_g, fat_g, fiber_g,
                original_ingredients_json, original_steps_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, '', '', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                r["title"],
                r["description"],
                r["servings"],
                r["prep_minutes"],
                r["cook_minutes"],
                json.dumps(r["tags"]),
                json.dumps(r["steps"]),
                r.get("calories_per_serving"),
                r.get("protein_g"),
                r.get("carbs_g"),
                r.get("fat_g"),
                r.get("fiber_g"),
                json.dumps(parsed_ings),
                json.dumps(r["steps"]),
                now,
                now,
            ),
        )
        rid = cur.lastrowid
        for idx, line in enumerate(r["ingredients"]):
            parsed = parse_ingredient_line(line)
            cat = match_catalog_item(parsed["name"], catalog_rows)
            conn.execute(
                """
                INSERT INTO recipe_ingredients (
                    recipe_id, sort_order, raw_text, quantity, unit, name, prep_notes, catalog_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rid,
                    idx,
                    line,
                    parsed["quantity"],
                    parsed["unit"],
                    parsed["name"],
                    parsed["prep_notes"],
                    cat["id"] if cat else None,
                ),
            )
