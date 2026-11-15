# 📋 PANTRYCART — KANBAN FEEDBACK & REQUIREMENTS BOARD
> **How this board works:**
> 1. **Add new items** anytime under **📥 INBOX / NEW FEEDBACK** (or **📋 BACKLOG / LONG-TERM FEATURES**).
> 2. When the agent finishes an item, it moves it to **👀 READY FOR REVIEW** with `[ ]` **unchecked** and adds an **Agent Resolution Note** explaining how it was built.
> 3. **Your sign-off:** Test the feature, then mark `[x]` to approve it (or add a reply note if you want tweaks). Approved items move to **✅ APPROVED & CLOSED**.

---

## 📥 INBOX / NEW FEEDBACK
*(Drop new DO / DONT items or bug reports here)*

- *(Empty — add your next round of feedback here!)*

---

## 🚧 IN PROGRESS
*(Items currently being built)*

- *(None currently)*

---

## 👀 READY FOR REVIEW (Awaiting Your Official Approval)
*(Check `[x]` once you verify and approve, or add a comment below any item if you want changes)*

- [ ] **FB-08 (DO): Make quantity much more visible (separate bold pill from the green unit/package pill)**
  - **Agent Resolution Note:**
    - Replaced the combined `.item-qty` tag with two distinct pills in `app/static/css/styles.css`, `app/static/js/views/lists.js`, and `app/static/js/views/planner.js`:
      1. **Quantity Badge (`.qty-badge`)**: Placed right in front of the item name (`1×`, `2×`, etc.) with bold `800` weight and high-contrast dark forest green (`#1b4332`) for `1×`, and high-visibility warm amber (`#d97706`) whenever `buy_qty > 1` so multi-item purchases immediately stand out while you shop.
      2. **Package/Unit Pill (`.unit-pill`)**: Separate soft green pill after the item name showing the package size/unit (e.g., `15 oz can`, `1 lb pack`).

- [ ] **FB-19 (DO): Support Guest accounts that can add/check list items and customize their own walking path without deleting main users' items or changing settings**
  - **Agent Resolution Note:**
    - **Database & Auth (`app/database.py`, `app/auth.py`, `app/routers/auth_router.py`)**: Added `users.is_guest`, exposed account roles (`Member`, `Admin`, `Guest`) when creating household accounts in **Settings → + Add Member**, and added the `require_non_guest` FastAPI dependency (`403 Forbidden`).
    - **Backend Guards (`lists_router.py`, `stores_router.py`, `pantry_router.py`, `catalog_router.py`, `kroger_router.py`, `recipes_router.py`, `import_router.py`)**: Guests can add/check list items, edit or delete items they added (`item.added_by == user.id`), request low pantry items (`+ To List`), and set their own per-user store walking path, while `require_non_guest` blocks Guests from deleting/editing other users' items, deleting lists or weekly templates, mutating shared stores/aisles/pantry/recipes/package sizes, generating API keys, changing passwords, or configuring Kroger.
    - **Frontend UI (`app.js`, `lists.js`, `stores.js`, `recipes.js`, `pantry.js`, `settings.js`)**: Added `Guest` badges in the sidebar/header, hid restricted management controls for Guest logins, and replaced full Settings tabs with a Guest Account info + Sign Out view.

- [ ] **FB-20 (DO): Fix recipe Text / HTML parser so steps don't end up in ingredients**
  - **Agent Resolution Note:**
    - Overhauled `parse_recipe_html_or_text` in `app/scraper.py` with `_extract_lines_from_html` (HTML DOM block-tag & `<li>`/`<h*>`/`<p>` extraction instead of line-splitting raw markup), `_smart_parse_recipe_lines` (classifying quantity-led lines vs. imperative cooking verbs/phrases with `_QTY_START_RE`, `_IMPERATIVE_STEP_RE`, `_COOKING_PHRASE_RE`, and stripping UI button/ad noise via `_NOISE_LINE_RE`).
    - Updated `ParseContentPayload` (`app/routers/recipes_router.py`) and `openQuickPasteModal` (`app/static/js/views/recipes.js`) to add a **Separate Ingredients & Steps** toggle mode alongside **Smart Auto-Detect**.

- [ ] **FB-23 (DO): Nutrition information always automatically updates when recipe ingredients change**
  - **Agent Resolution Note:**
    - Updated `update_recipe` in `app/routers/recipes_router.py` and `_insert_recipe_dict` in `app/routers/import_router.py` so whenever ingredients or servings change, per-serving macros are automatically recalculated via `compute_recipe_macros` (while preserving any delta above estimated baseline for scraped recipes) and unlogged weekly `meal_calendar_slots` referencing that recipe are refreshed.
    - Updated `openRecipeEditor` in `app/static/js/views/recipes.js` to run debounced live recalculation (`POST /api/nutrition/estimate-text`) on `ingredients_text` and `servings` edits so updated Calories/Protein/Carbs/Fat/Fiber appear immediately before saving.

- [ ] **FB-24 (DO): Make recipes customizable with a diff view (`+ User Added` / `✎ Modified` / `Removed`) vs. original recipe**
  - **Agent Resolution Note:**
    - **Database & API (`app/database.py`, `app/routers/recipes_router.py`, `app/routers/import_router.py`)**: Added `original_ingredients_json` and `original_steps_json` baseline columns on `recipes` (backfilled on migration for existing recipes), `_compute_recipe_diff` (via `difflib.SequenceMatcher` producing `is_customized`, per-ingredient `diff_status`/`original_raw`, `removed_ingredients`, `step_diffs`, and `removed_steps`), plus `POST /api/recipes/{recipe_id}/reset-to-original` and `POST /api/recipes/{recipe_id}/save-as-original`.
    - **Frontend (`app/static/js/views/recipes.js`, `app/static/css/styles.css`)**: Added **✨ Customized** badges on recipe cards and detail headers, a toggleable diff banner with **Show/Hide Diff**, **↩ Revert to Original**, and **✓ Set as Baseline** actions, inline **`+ User Added`** / **`✎ Modified`** (`Original: ...`) markers on ingredients & steps, and strikethrough **Removed from Original** summaries.

- [ ] **FB-25 (DO): Remove the inline `−`/`+` stepper on shopping lists, restore the high-contrast colored `.qty-badge` pill, and keep quantity editable when pressing Edit**
  - **Agent Resolution Note:**
    - Removed the `.qty-stepper` / `.qty-step-btn` CSS rules (`app/static/css/styles.css`) and inline `qty-dec` / `qty-inc` buttons & click listeners (`app/static/js/views/lists.js`).
    - Restored the standalone high-contrast colored `.qty-badge` pill (`1×` dark forest green, `2×+` warm amber) directly beside each item name, while keeping **Buy Quantity** editable via the **Edit** modal (`✎` or clicking the item).

- [ ] **FB-26 (DO): Allow modifying and re-searching Kroger cart entries when sending a list to Kroger Cart**
  - **Agent Resolution Note:**
    - Added `POST /api/kroger/search-product` in `app/routers/kroger_router.py` (using `clean_shopping_item_name` and the list's resolved store `locationId`) and included `search_term` & `location_id` in `/api/kroger/preview-cart/{list_id}`.
    - Added an editable Kroger search input + **🔍 Search** button (supports `Enter` key) directly inside every item card in `openKrogerCartModal` (`app/static/js/views/lists.js`) so users can refine search terms, load fresh UPC candidates, select the best match, and enable pushing previously unmatched items without losing other row selections.

- [ ] **FB-27 (DO): Strip recipe cut/prep notes (e.g., `(Trimmed and Halved)`) from shopping list items & Kroger searches while keeping them on recipes**
  - **Agent Resolution Note:**
    - Added `clean_shopping_item_name()` and `_merge_prep_notes()` in `app/units.py` and wired them into `parse_ingredient_line()` and `compute_grocery_packages()`, plus added `"brussels sprouts"` to `SEED_CATALOG` (`SEED_CATALOG[-3:]`).
    - Added startup migration logic in `app/database.py` to clean existing `recipe_ingredients` and `shopping_list_items` names embedding `(...)` or ` - ` prep suffixes (preserving the extracted text in `prep_notes`), and wired `clean_shopping_item_name()` into `add_item_to_list_internal()` (`app/routers/lists_router.py`) and `auto_map_kroger_aisles()` / `preview_kroger_cart()` / `search_kroger_product()` (`app/routers/kroger_router.py`).

- [ ] **FB-28 (DO): Add a selectable Dark Mode / Light Mode option**
  - **Agent Resolution Note:**
    - Added `html[data-theme="dark"]` color tokens and component overrides (`.bottom-nav`, `.aisle-divider`, `.nutrition-card`, `.btn-locked`, `.diff-banner`, `.item-note-callout`, inputs, badges, modals) in `app/static/css/styles.css`.
    - Persisted the selected theme in `localStorage` under `pantrycart_theme` (`app/static/js/app.js` via `_applyTheme` / `window.__pantrySetTheme`) and added quick theme toggle buttons in the sidebar footer, mobile header, login/setup card (`app/static/js/views/auth.js`), and **Settings → Household Accounts → Appearance** (`app/static/js/views/settings.js`).

- [ ] **FB-29 (DO): Support mapping different Kroger store locations to individual PantryCart Stores**
  - **Agent Resolution Note:**
    - Added `kroger_location_id`, `kroger_location_name`, and `kroger_location_address` columns to `stores` in `app/database.py` (with automatic migration backfilling the existing global Kroger location onto its linked/first Kroger store) and serialized/updated them in `app/routers/stores_router.py` and `build_list_response()` (`app/routers/lists_router.py`).
    - Added `_resolve_kroger_location()` in `app/routers/kroger_router.py` so `auto-aisles`, `preview-cart`, and `search-product` use the active shopping list's store-specific Kroger location (falling back to global `kroger_config`).
    - Added a **🏪 Link Kroger Store** / **Change Kroger Store** ZIP search & Unlink modal on stores in **Stores & Aisle Maps** (`app/static/js/views/stores.js`), a per-store Kroger mappings overview + store target selector in **Settings → Kroger Step 2** (`app/static/js/views/settings.js`), and the active store's linked Kroger badge on **Shopping Lists** (`app/static/js/views/lists.js`).

- [ ] **FB-30 (DO): Add built-in clickable recipe filter chips (e.g., Dinner, Lunch, Dessert) that users can edit**
  - **Agent Resolution Note:**
    - Added the `app_settings` table (`app/database.py`) seeded with `recipe_quick_queries` (`Dinner`, `Lunch`, `Breakfast`, `Dessert`, `Quick`, `High Protein`, `Chicken`, `Beef`, `Vegetarian`) and `GET/PUT /api/recipes/quick-queries` endpoints in `app/routers/recipes_router.py`.
    - Rendered clickable `.quick-query-chip` buttons beneath the Recipes search bar (`app/static/js/views/recipes.js`) with smart matching for `"Quick"` (`prep + cook <= 35 min`) and `"High Protein"` (`>= 25g` protein), plus a **Clear** button and **✎ Edit Filters** modal (`non-guest` users) to customize or reset chips.

- [ ] **FB-31 (DO): Add a prominent Notes / Acceptable Substitutions section on Weekly Template and Shopping List items**
  - **Agent Resolution Note:**
    - Added an optional **Notes / substitutions** field right next to Quick Add in **Shopping Lists**, added **Notes / Acceptable Substitutions** inputs to both **Weekly Template** add and inline-edit forms, and updated the **Edit Item** modal label in `app/static/js/views/lists.js`.
    - Rendered non-empty item notes as high-visibility amber `.item-note-callout` badges (`📝 ...`, styled in `app/static/css/styles.css` for both light and dark modes) on both Weekly Template rows and Shopping List rows.

- [ ] **FB-32 (DO): Remove real personal name (`Ryan` / `ryan`) from login and planner default placeholders for public GitHub**
  - **Agent Resolution Note:**
    - Replaced `Ryan` / `ryan` placeholders in `app/static/js/views/auth.js` (`e.g. Alex`, `e.g. alex`) and `app/static/js/views/planner.js` (`Blank = Everyone, or type name (e.g. Alex, Partner)`), verified zero remaining `ryan` occurrences under `app/`.

- [ ] **FB-33 (DO): Round portion macros (Calories, Protein, Carbs, Fat, Fiber) to the nearest whole number**
  - **Agent Resolution Note:**
    - Changed all macro rounding on backend calculations (`estimate_single_food_macros` & `compute_recipe_macros` in `app/routers/nutrition_router.py`; `get_meal_plan` & `get_calendar_data` in `app/routers/planner_router.py`) from 1-decimal floats (`round(..., 1)`) to whole integers (`round(...)`).
    - Updated frontend displays, Quick-Entry Card / clipboard copy / iOS Shortcut payloads (`app/static/js/nutrition_ui.js`), weekly calendar totals & meal entries (`app/static/js/views/planner.js`), and recipe editor inputs/live recalculation (`step="1"` & `Math.round(...)` in `app/static/js/views/recipes.js`) to display whole numbers only.

---

## 📋 BACKLOG / LONG-TERM FEATURES
*(Future roadmap items)*

- [ ] **LT-01: Calendar Meal Planning**
  - Allow the user to place meals on a visual calendar so they can plan meals by day/date for the week.
- [ ] **LT-02: Calendar Sync (Home Assistant / Google Calendar)**
  - Allow the meal plan calendar to sync to Home Assistant or Google Calendar (e.g., via an iCal `.ics` feed and HA REST sensor).
- [ ] **LT-03: "Bird's-Eye View" Visual Store Map**
  - Visual 2D store layout where departments/aisles can be placed on a bird's-eye map of the store.
- [ ] **LT-04: Recipe Nutrition & Custom Portion Scaling** *(Implemented & awaiting approval in **FB-14** under Ready for Review!)*
  - Pull in nutrition information for recipes and allow dividing a recipe into custom portions (e.g., "dividing this recipe into 5 servings instead of 6") with automatic per-serving macro calculation.

---

## ✅ APPROVED & CLOSED
*(Items verified and signed off by you)*

- [x] **FB-01 (DO): Allow for a "template list" to start, including weekly purchased items (bananas, chicken tenderloins, salad mixes, etc.)**
  - **Agent Resolution Note:**
    - Added a `weekly_template_items` table in `app/database.py` pre-seeded with **Bananas**, **Chicken Tenderloins**, **Salad Mix**, **Eggs**, and **Milk**.
    - In **Shopping Lists** (`app/static/js/views/lists.js`), added a **Weekly Template (N)** button in the header (to add/remove/toggle your recurring weekly staples) and a **+ Load Weekly Staples** button on any list to drop all active template items onto your trip in one tap.
    - In **This Week** (`app/static/js/views/planner.js`), the **Generate Shopping List** modal now includes an **Include Weekly Template Staples** toggle so you can combine your weekly staples and recipe ingredients in one step.

- [x] **FB-02 (DO): Allow Stores on the top bar to be edited where they are located (e.g. place a custom store anywhere in the list)**
  - **Agent Resolution Note:**
    - Added `sort_order` to both `stores` and `shopping_lists` (`app/database.py`) plus `POST /api/stores/reorder` and `POST /api/lists/reorder`.
    - In **Stores & Aisle Maps** (`app/static/js/views/stores.js`), added a **Position on Top Bar (1 = First)** field inside both **+ Add Custom Store** and **Edit Store & Position**, plus a **Reorder Top Bar** button that lets you move any store up/down to place it anywhere on the bar.
    - Also added a **Reorder Tabs** button in **Shopping Lists** so you can reorder your shopping list pills on the top bar too.

- [x] **FB-03 (DO): Make the checkmark animation more satisfying (slightly slower checkmark and show it flying to bottom of list)**
  - **Agent Resolution Note:**
    - Added a two-stage animation in `app/static/css/styles.css` and `app/static/js/views/lists.js`:
      1. **Stage 1 (`~340ms`)**: Tapping an unchecked circle triggers a bouncy green pop (`checkPop`), draws the SVG checkmark stroke (`drawCheckStroke`), highlights the row in soft sage, and crosses out the item text.
      2. **Stage 2 (`~440ms`)**: The item row smoothly glides downward toward the bottom **Checked / In Cart** drawer (`flyToBottomDrawer`) while collapsing its height before updating the list.

- [x] **FB-04 (DO): Allow the user to edit the "std" unit somehow if their store's standard is different**
  - **Agent Resolution Note:**
    - Added `POST /api/catalog/upsert-std` in `app/routers/catalog_router.py`.
    - In **This Week → Build Shopping List** (`app/static/js/views/planner.js`), every ingredient row now has an inline **✎ Edit Std** button right next to its `Std:` package label. Clicking it opens an inline editor to change the numeric size, unit, and package label (e.g., changing `15 oz can` to `28 oz can`) and clicks **Save & Recalculate** to update the required package count live.
    - Also added a checkbox inside the **Edit Item** modal on any shopping list to save an item's unit/package label as the default Standard (`Std`) size for future recipes.

- [x] **FB-05 (DO): Pull in an image of the recipe if sync'd from the web**
  - **Agent Resolution Note:**
    - Enhanced `app/scraper.py` to extract recipe images from Schema.org JSON-LD (`str`, `list`, or `ImageObject`), fallback to OpenGraph `og:image` / `twitter:image` / `.wprm-recipe-image`, and resolve relative URLs.
    - Updated `app/static/js/views/recipes.js` and `app/static/js/views/planner.js` to display recipe cover photos on **Recipe Cards**, inside **View & Cook** detail mode, as thumbnails in **This Week's Menu**, and with a live preview + editable Photo URL field in the **Save/Edit Recipe** modal.

- [x] **FB-06 (DO): Allow the user to "bulk import" recipes, store layouts, etc. (.csv, .xlsx, .docx, etc.) from a different app**
  - **Agent Resolution Note:**
    - Added `openpyxl` and `python-docx` to `requirements.txt` and created `app/routers/import_router.py`.
    - **Recipes → Bulk Import**: Supports uploading `.csv`, `.xlsx`, `.docx` (Word), `.json`, `.txt`, or `.md` files, plus a **Batch Scrape URLs** option where you can paste up to 25 recipe URLs at once.
    - **Stores → Bulk Import**: Upload a `.csv` or `.xlsx` file (`item`, `department`, `aisle`) to bulk-map aisles for any store.
    - **Pantry → Bulk Import**: Upload a `.csv` or `.xlsx` file (`name`, `category`, `quantity_note`, `in_stock`) to bulk-load pantry items.

- [x] **FB-07 (DONT): Do NOT put "package sizes" and "pantry" together — make a separate area for pantry staples categorized by canned goods, spices, etc.**
  - **Agent Resolution Note:**
    - Created a dedicated `pantry_items` table (`app/database.py`), `/api/pantry` router (`app/routers/pantry_router.py`), and a dedicated **Pantry** tab in the main navigation bar (`app/static/js/views/pantry.js`).
    - Pantry items are organized into category tabs: **Spices & Seasonings**, **Canned & Jarred Goods**, **Oils, Vinegars & Condiments**, **Baking & Cooking Staples**, **Grains, Pasta & Dry Goods**, and **Snacks & Other**, with one-tap **Mark Low / Mark In Stock** and **+ To List** buttons.
    - **Settings → US Store Package Sizes** now focuses strictly on store package sizes without mixing in pantry inventory.

- [x] **FB-09 (DO): Make the Weekly Template items editable (not just delete and add new ones)**
  - **Agent Resolution Note:**
    - In **Shopping Lists → Weekly Template** (`app/static/js/views/lists.js`), added an **Edit** button on every template item row.
    - Clicking **Edit** opens an inline editor right on that row where you can modify the **Item Name**, **Quantity**, **Unit/Package**, and **Department**, and click **Save** (via `PATCH /api/lists/template/items/{id}`).

- [x] **FB-10 (DO): Fix store layout updates and store switching so the shopping list immediately updates to the selected store's walking path**
  - **Agent Resolution Note:**
    - **Backend (`app/routers/lists_router.py` & `app/routers/stores_router.py`)**:
      - Fixed HTML entity escaping (`"Bakery &amp; Deli"` vs `"Bakery & Deli"`) so department names always match cleanly.
      - Upgraded `resolve_store_department` with synonym bridging across store types (e.g., mapping `Frozen` ↔ `Frozen Foods`, `Dry Goods` ↔ `Pantry / Dry Goods`) and catalog fallback so switching from Store A to Store B re-sorts every item into Store B's departments and aisles without leaking Store A's old aisle numbers.
      - Fixed `PATCH /api/lists/{list_id}` (`model_fields_set`) and touched `shopping_lists.updated_at` whenever a store layout or aisle map is edited.
    - **Frontend (`app/static/js/views/lists.js` & `app/static/js/views/stores.js`)**:
      - Seeded `deptGroups` strictly in `activeList.store.departments` order (with `#1`, `#2`, ... walking-order badges on each section header) instead of item arrival order.
      - Added one-tap **↑ / ↓** buttons right on each department row in **Stores & Aisle Maps** so you can adjust a store's walking order on the fly.

- [x] **FB-11 (DO): Redesign the meal planner calendar with optional Breakfast / Lunch / Dinner / Snacks per day, remaining servings counters, list snack integration, and per-person meal/leftover assignment**
  - **Agent Resolution Note:**
    - Added the `meal_calendar_slots` table in `app/database.py` and `/api/planner/calendar` endpoints in `app/routers/planner_router.py`.
    - **This Week's Menu & Servings Pool (`app/static/js/views/planner.js`)**: Each selected recipe now shows a calm pill (`2x of 4 servings left` or `All 4 servings placed ✓`) with no intrusive warnings, plus a **+ Place on Day** button.
    - **Optional Weekly Meal & Leftover Calendar (`Mon`–`Sun`)**:
      - Each day card has optional **Breakfast**, **Lunch**, **Dinner**, and **Snacks** sections.
      - Clicking **+ Add** lets you pick from **This Week's Recipes** (automatically deducting from remaining servings), **Snacks & List Items** (pulled from your active shopping list and weekly template), or a **Custom / Leftover** entry.
      - Includes a **Who is eating this?** selector (`Everyone`, household member pills, or any custom name) so one person can eat leftover soup while another eats a different meal on the same day.

- [x] **FB-12 (DO): Fix `403 Forbidden` when importing recipes from sites like BudgetBytes (`https://www.budgetbytes.com/bacon-spinach-pasta-parmesan/`)**
  - **Agent Resolution Note:**
    - **Automatic WordPress REST API Fallback (`app/scraper.py`)**: Many recipe sites (including BudgetBytes) run on WordPress behind Cloudflare rules that block server-side HTML fetches (`403`) while leaving the public WordPress REST API (`/wp-json/wp/v2/posts?slug=...`) open. When direct HTML scraping returns `403`, PantryCart now automatically queries the site's WP REST API and extracts the full recipe (title, photo, times, servings, ingredients, and steps) from Yoast Schema.org JSON-LD and WP Recipe Maker HTML blocks.
    - **Quick Paste Text/HTML Fallback (`POST /api/recipes/parse-content` & `app/static/js/views/recipes.js`)**: Added a **Paste Text / HTML** button (and automatic modal fallback if a non-WordPress site still blocks server IPs) so you can paste copied recipe text or page HTML source (`Ctrl+U`) to parse and open directly in the Recipe Editor.

- [x] **FB-13 (DO): Kroger Official Public API Integration (`developer.kroger.com`) — Auto-Map Aisles, Prices & Send List to Kroger Cart (Walmart scrapped)**
  - **Agent Resolution Note:**
    - **Database & Config (`app/database.py`, `app/routers/kroger_router.py`)**: Added `kroger_config` and `kroger_user_tokens` tables plus `/api/kroger/*` endpoints supporting OAuth2 Client Credentials (for catalog/aisle/store search) and Authorization Code OAuth2 (`cart.basic:write product.compact`) with automatic refresh tokens for shopper carts across Kroger-family banners (Kroger, Mariano's, Pick 'n Save, Fred Meyer, Ralphs, King Soopers, Harris Teeter, etc.).
    - **Settings → Kroger API & Shortcuts (`app/static/js/views/settings.js`)**: Configure & verify your `Client ID` and `Client Secret`, enter your Redirect URI (`<your-domain>/api/kroger/oauth/callback`), search nearby Kroger-family stores by 5-digit ZIP code (`locationId`), link your Kroger store, and connect your Kroger shopper login via OAuth2.
    - **Shopping Lists (`app/static/js/views/lists.js`)**: Added **🧭 Auto-Map Aisles** (looks up exact Kroger `aisleLocations` + live prices at your selected `locationId` and saves aisle numbers to both the list and your store aisle memory) and **🛒 Send to Kroger Cart** (matches list items to Kroger UPCs with candidate dropdowns, quantity controls, `PICKUP`/`DELIVERY` modality selector, and one-tap `PUT /v1/cart/add`).

- [x] **FB-14 (DO): Recipe Macro Calculator, Custom Portion Scaling, Lose It! Quick-Entry Card & 2-Step iOS Shortcut Meal Logger**
  - **Agent Resolution Note:**
    - **Automatic Nutrition Scraping + Ingredient Macro Estimator (`app/scraper.py`, `app/routers/nutrition_router.py`)**: Automatically pulls Schema.org JSON-LD `nutrition` / WP Recipe Maker HTML nutrition blocks when importing recipes, and adds a built-in ingredient nutrition estimator (`POST /api/nutrition/estimate-recipe/{id}` & `POST /api/nutrition/estimate-text`) plus common single-food snack lookup for non-recipe calendar slots.
    - **Custom Portion Divider (`custom_portions` in `app/database.py`, `app/routers/recipes_router.py`)**: Divide any recipe into your actual meal-prep container/portion count (e.g., dividing a 4-serving recipe into `5` portions) inside **Recipes** or directly inside the **Lose It! Quick-Entry Card**, automatically recalculating per-portion Calories, Protein, Carbs, Fat, and Fiber without changing shopping quantities unless desired.
    - **Lose It! Quick-Entry Card (`app/static/js/nutrition_ui.js`, `app/static/js/views/recipes.js`, `app/static/js/views/planner.js`)**: One-tap **📋 Lose It! / Macro Card** modal displaying clean **Per Portion** and **Whole Batch** macros with 1-click **Copy Per-Portion Summary** and **Copy Lose It! Quick Line** buttons.
    - **2-Step iOS Shortcut Logger (`app/static/js/views/planner.js`, `app/static/js/views/settings.js`, `app/routers/nutrition_router.py`)**:
      - **Step 1 (Shortcut Not Verified — `shortcut_verified = false`)**: All **🔒 Log Meals** buttons on **This Week** day cards and meal slots remain visibly locked/grayed out (`.btn-locked`) while exposing **Step 1: Setup & Verify Shortcut** to guide creating/downloading the `PantryCart Log Macros` iOS Shortcut (`shortcuts://create-shortcut` + `/api/nutrition/ios-shortcut` template) and running an `x-callback-url` test (`#planner?shortcut_verified=1`) or confirming availability.
      - **Step 2 (Shortcut Verified — `shortcut_verified = true`)**: All **📲 Log Meals** buttons unlock into active buttons (`.btn-log-ready` / `.btn-log-done` `✓ Logged`) so you can log an individual meal or an entire day's planned meals (filtered by **Everyone** or a specific household member like `Me` / `Wife`) directly to Apple Health / Shortcuts & mark them logged in PantryCart.

- [x] **FB-15 (DO): Make shopping list items clearly editable with inline quantity adjustment and delete without checking them off first**
  - **Agent Resolution Note:**
    - Updated `app/static/js/views/lists.js` (`renderItemRow` & `bindEvents`) and `app/static/css/styles.css` (`.qty-stepper`, `.qty-step-btn`, `.item-action-btns`, `.item-icon-btn`, `.item-main.editable`):
      - Every editable list item now shows an inline **`−` / `+` quantity stepper** around the quantity badge so you can increment or decrement `buy_qty` in one tap (or confirm removal when stepping down from `1×`).
      - Item titles are clickable to open the full **Edit Item** modal, alongside explicit **`✎` Edit** and **`✕` Remove** buttons on every row so items can be adjusted or deleted without checking them off first.

- [x] **FB-16 (DO): Hide `+ Aisle` / `Aisle` badges on items in departments not marked as "Sorted by Aisle"**
  - **Agent Resolution Note:**
    - Updated `app/static/js/views/lists.js` so `renderItemRow(item, store, usesAisles)` only renders the `.aisle-pill` (`Aisle X` / `+ Aisle`) button on items inside departments listed in the active store's `aisle_departments` (**Sorted by Aisle**), keeping Produce, Meat & Seafood, Bakery & Deli, Dairy & Eggs, etc. uncluttered.

- [x] **FB-17 (DO): Keep stores & layouts shared between household users while letting each user customize their own walking path (e.g. clockwise vs. counter-clockwise)**
  - **Agent Resolution Note:**
    - **Database & API (`app/database.py`, `app/routers/stores_router.py`, `app/routers/lists_router.py`)**: Added the `user_store_paths` table keyed by `(user_id, store_id)`, added `get_effective_store_departments(conn, store_row, user_id)`, wired per-user department ordering into `GET /api/stores` and `build_list_response(..., user_id=...)`, and added `PUT /api/stores/{store_id}/walking-path` (supports custom `departments` array or `reverse: true`) and `DELETE /api/stores/{store_id}/walking-path` to reset to the shared default.
    - **Frontend (`app/static/js/views/stores.js` & `app/static/js/views/lists.js`)**: Reordering departments (`↑` / `↓`), clicking **⇄ Reverse My Path**, or clicking **Reset to Shared Default** updates only your personal walking path (`Your Custom Path` badge), while store definitions and mapped aisles remain shared household-wide.

- [x] **FB-18 (DO): Convert `User_Feedback_and_Requirements.txt` into a `.md` file for VS Code**
  - **Agent Resolution Note:**
    - Created `User_Feedback_and_Requirements.md` with the full Kanban board and removed the legacy `User_Feedback_and_Requirements.txt` from the repository.

- [x] **FB-21 (DO): Automatically grab missing images for recipes imported via URL**
  - **Agent Resolution Note:**
    - Expanded `_extract_fallback_image` in `app/scraper.py` (supports `og:image:secure_url`, `link[rel="image_src"]`, JSON-LD `@graph` images, and DOM `data-lazy-src` / `data-src` / `srcset`).
    - Added `POST /api/recipes/sync-missing-from-url` and `POST /api/recipes/{recipe_id}/sync-from-url` in `app/routers/recipes_router.py`, automatic image lookup on `create_recipe` / `update_recipe`, auto-backfill trigger when opening **Recipes**, and a manual **🔄 Sync URL Info** button inside recipe details (`app/static/js/views/recipes.js`).

- [x] **FB-22 (DO): Automatically grab missing nutrition info for recipes imported via URL**
  - **Agent Resolution Note:**
    - Expanded `_extract_html_nutrition` in `app/scraper.py` to scan WP Recipe Maker, Tasty Recipes, and general `[class*="nutrition"]` DOM blocks via regex in addition to Schema.org JSON-LD `nutrition`.
    - Wired missing nutrition scraping (with automatic ingredient macro estimation fallback via `compute_recipe_macros` if the webpage has no nutrition block) into `create_recipe`, `update_recipe`, `POST /api/recipes/sync-missing-from-url`, and `POST /api/recipes/{recipe_id}/sync-from-url` in `app/routers/recipes_router.py`, surfaced in `app/static/js/views/recipes.js`.
