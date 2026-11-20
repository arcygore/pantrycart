import json
import math
import re
from typing import Any, Optional

UNICODE_FRACTIONS = {
    "½": 0.5,
    "⅓": 1 / 3,
    "⅔": 2 / 3,
    "¼": 0.25,
    "¾": 0.75,
    "⅕": 0.2,
    "⅖": 0.4,
    "⅗": 0.6,
    "⅘": 0.8,
    "⅙": 1 / 6,
    "⅚": 5 / 6,
    "⅛": 0.125,
    "⅜": 0.375,
    "⅝": 0.625,
    "⅞": 0.875,
}

UNIT_ALIASES = {
    "tsp": "tsp",
    "t": "tsp",
    "teaspoon": "tsp",
    "teaspoons": "tsp",
    "tbsp": "tbsp",
    "tbs": "tbsp",
    "tablespoon": "tbsp",
    "tablespoons": "tbsp",
    "c": "cup",
    "cup": "cup",
    "cups": "cup",
    "fl oz": "fl_oz",
    "fl. oz.": "fl_oz",
    "fl_oz": "fl_oz",
    "fluid ounce": "fl_oz",
    "fluid ounces": "fl_oz",
    "pt": "pint",
    "pint": "pint",
    "pints": "pint",
    "qt": "quart",
    "quart": "quart",
    "quarts": "quart",
    "gal": "gallon",
    "gallon": "gallon",
    "gallons": "gallon",
    "ml": "ml",
    "milliliter": "ml",
    "milliliters": "ml",
    "l": "l",
    "liter": "l",
    "liters": "l",
    "oz": "oz",
    "ounce": "oz",
    "ounces": "oz",
    "lb": "lb",
    "lbs": "lb",
    "pound": "lb",
    "pounds": "lb",
    "g": "g",
    "gram": "g",
    "grams": "g",
    "kg": "kg",
    "kilogram": "kg",
    "kilograms": "kg",
    "clove": "clove",
    "cloves": "clove",
    "head": "head",
    "heads": "head",
    "bunch": "bunch",
    "bunches": "bunch",
    "can": "can",
    "cans": "can",
    "jar": "jar",
    "jars": "jar",
    "bottle": "bottle",
    "bottles": "bottle",
    "package": "package",
    "packages": "package",
    "pkg": "package",
    "pack": "package",
    "bag": "bag",
    "bags": "bag",
    "box": "box",
    "boxes": "box",
    "stick": "stick",
    "sticks": "stick",
    "slice": "slice",
    "slices": "slice",
    "sprig": "sprig",
    "sprigs": "sprig",
    "stalk": "stalk",
    "stalks": "stalk",
    "rib": "stalk",
    "ribs": "stalk",
    "pinch": "pinch",
    "pinches": "pinch",
    "dash": "pinch",
    "count": "count",
}

SIZE_ADJECTIVES = {"large", "medium", "small", "extra-large", "xl"}

FILLER_PREFIXES = [
    "fresh",
    "freshly",
    "organic",
    "boneless",
    "skinless",
    "boneless skinless",
    "boneless, skinless",
    "extra virgin",
    "extra-virgin",
    "unsalted",
    "salted",
    "low sodium",
    "low-sodium",
    "reduced sodium",
    "lean",
    "whole",
    "raw",
    "dried",
    "ground",
    "minced",
    "diced",
    "chopped",
    "sliced",
    "shredded",
    "grated",
    "crushed",
    "frozen",
    "canned",
    "packed",
    "plain",
    "pure",
    "unbleached",
    "sweet",
    "baby",
    "large",
    "medium",
    "small",
]

# Base volume units in teaspoons (tsp)
VOLUME_TO_TSP = {
    "tsp": 1.0,
    "tbsp": 3.0,
    "fl_oz": 6.0,
    "cup": 48.0,
    "pint": 96.0,
    "quart": 192.0,
    "gallon": 768.0,
    "ml": 0.202884,
    "l": 202.884,
}

# Base weight units in grams (g)
WEIGHT_TO_G = {
    "g": 1.0,
    "kg": 1000.0,
    "oz": 28.3495,
    "lb": 453.592,
}

WEIGHT_UNITS = {"lb", "oz", "g", "kg"}


def is_weight_unit(unit: str) -> bool:
    u = (unit or "").strip().lower().rstrip(".")
    if not u:
        return False
    return UNIT_ALIASES.get(u, u) in WEIGHT_UNITS

# Approximate oz per 1 cup for common items when recipe uses cups/tbsp and store uses oz/lb
CUP_TO_OZ_DENSITY = {
    "all-purpose flour": 4.25,
    "granulated sugar": 7.0,
    "brown sugar": 7.5,
    "powdered sugar": 4.0,
    "butter": 8.0,
    "cheddar cheese": 4.0,
    "mozzarella cheese": 4.0,
    "parmesan cheese": 3.5,
    "feta cheese": 5.0,
    "white rice": 6.5,
    "brown rice": 6.5,
    "quinoa": 6.0,
    "rolled oats": 3.0,
    "breadcrumbs": 4.0,
    "cornstarch": 4.5,
    "sour cream": 8.0,
    "greek yogurt": 8.5,
    "cream cheese": 8.0,
    "peanut butter": 9.0,
    "honey": 12.0,
    "sun-dried tomatoes": 4.0,
    "spinach": 1.0,
    "frozen peas": 5.0,
    "frozen corn": 5.5,
    "frozen berries": 5.0,
    "black beans": 6.5,
    "kidney beans": 6.5,
    "chickpeas": 6.5,
    "diced tomatoes": 8.0,
    "crushed tomatoes": 8.5,
    "tomato sauce": 8.5,
}


def normalize_item_key(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"[^a-z0-9\s&-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _replace_unicode_fractions(text: str) -> str:
    for sym, val in UNICODE_FRACTIONS.items():
        # Handle "1½" -> "1 0.5"
        text = re.sub(rf"(\d)\s*{re.escape(sym)}", lambda m, v=val: f"{m.group(1)} {v}", text)
        text = text.replace(sym, str(val))
    return text


def _parse_number_token(token: str) -> Optional[float]:
    token = token.strip()
    if not token:
        return None
    if "/" in token:
        parts = token.split("/")
        if len(parts) == 2:
            try:
                num = float(parts[0])
                den = float(parts[1])
                if den != 0:
                    return num / den
            except ValueError:
                return None
        return None
    try:
        return float(token)
    except ValueError:
        return None


def parse_leading_quantity(text: str) -> tuple[Optional[float], str]:
    raw_stripped = text.strip()
    s = _replace_unicode_fractions(raw_stripped)

    # Do not treat percentages (e.g. "2% milk", "1% cottage cheese") as quantities
    if re.match(r"^\d+(?:\.\d+)?\s*%", s):
        return None, raw_stripped

    # Do not treat fat/lean ratios (e.g. "80/20 ground beef", "93/7 turkey") as fractions
    ratio_match = re.match(r"^(\d+)/(\d+)\b", s)
    if ratio_match:
        a, b = int(ratio_match.group(1)), int(ratio_match.group(2))
        if a >= 50 and b <= 50 and a + b == 100:
            return None, raw_stripped

    # Support leading multiplier syntax: "2x bananas" or "2× milk"
    mult_lead = re.match(r"^(\d+(?:\.\d+)?)\s*[x×]\s+(.+)$", s, re.IGNORECASE)
    if mult_lead:
        try:
            return float(mult_lead.group(1)), mult_lead.group(2).strip()
        except ValueError:
            pass

    # Handle ranges like "2-3", "2 - 3", "2 to 3" -> take upper bound for shopping safety
    range_match = re.match(
        r"^(\d+(?:\.\d+)?(?:\s+\d+/\d+|\s+\d+\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?(?:\s+\d+/\d+|\s+\d+\.\d+)?)\b(.*)$",
        s,
        re.IGNORECASE,
    )
    if range_match:
        upper_str = range_match.group(2).strip()
        rest = range_match.group(3).strip()
        val = _eval_mixed_number(upper_str)
        if val is not None:
            return val, rest

    # Standard mixed number or single number: "1 1/2", "1.5", "3/4", "2"
    num_match = re.match(r"^(\d+\s+\d+/\d+|\d+\s+0\.\d+|\d+/\d+|\d+(?:\.\d+)?)\b(.*)$", s)
    if num_match:
        val = _eval_mixed_number(num_match.group(1).strip())
        if val is not None:
            return val, num_match.group(2).strip()

    # Support trailing multiplier syntax: "bananas x3" or "bananas ×3"
    mult_trail = re.match(r"^(.+?)\s+[x×]\s*(\d+(?:\.\d+)?)$", s, re.IGNORECASE)
    if mult_trail:
        try:
            return float(mult_trail.group(2)), mult_trail.group(1).strip()
        except ValueError:
            pass

    return None, raw_stripped


def _eval_mixed_number(expr: str) -> Optional[float]:
    parts = expr.split()
    total = 0.0
    for p in parts:
        v = _parse_number_token(p)
        if v is None:
            return None
        total += v
    return total


def clean_shopping_item_name(raw_name: str) -> tuple[str, str]:
    """Strip cut/prep notes (parentheticals or ' - prep') from an ingredient/item name.

    Returns ``(clean_name, extracted_prep_notes)`` so recipe prep instructions
    remain on the recipe while shopping lists and Kroger product searches use
    the clean canonical product name.
    """
    text = (raw_name or "").strip()
    if not text:
        return "", ""

    prep_parts: list[str] = []

    def _collect_paren(match: re.Match) -> str:
        inner = match.group(1).strip(" ,;-")
        if inner:
            prep_parts.append(inner)
        return " "

    cleaned = re.sub(r"\(([^)]*)\)", _collect_paren, text)

    # Also separate trailing ' - trimmed and halved' style prep suffixes
    dash_match = re.match(r"^(.*?)\s+[-–—]\s+(.+)$", cleaned)
    if dash_match and dash_match.group(1).strip():
        cleaned = dash_match.group(1)
        trailing = dash_match.group(2).strip(" ,;-")
        if trailing:
            prep_parts.append(trailing)

    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,;-")
    if not cleaned:
        return text, ""
    return cleaned, ", ".join(prep_parts)


def _merge_prep_notes(*parts: str) -> str:
    seen: list[str] = []
    for part in parts:
        cleaned = (part or "").strip(" ,;-")
        if cleaned and cleaned.lower() not in {s.lower() for s in seen}:
            seen.append(cleaned)
    return ", ".join(seen)


def parse_ingredient_line(raw: str) -> dict[str, Any]:
    original = raw.strip()
    if not original:
        return {"raw_text": "", "quantity": None, "unit": "", "name": "", "prep_notes": ""}

    # Separate prep notes after comma
    prep_notes = ""
    working = original
    if "," in working:
        left, right = working.split(",", 1)
        working = left.strip()
        prep_notes = right.strip()

    qty, rest = parse_leading_quantity(working)

    # Check for US packaged-can pattern like: "2 (15 oz) cans black beans" or "1 (14.5-oz) can diced tomatoes"
    pack_match = re.match(
        r"^\(\s*(\d+(?:\.\d+)?)\s*[-\s]?\s*(fl\.?\s*oz\.?|oz|ounce|ounces|lb|lbs|g|ml|l)\s*\)\s*(?:cans?|jars?|bottles?|packages?|pkgs?|bags?|boxes?|cartons?)?\s*(.+)$",
        rest,
        re.IGNORECASE,
    )
    if pack_match:
        inner_qty = float(pack_match.group(1))
        inner_unit = UNIT_ALIASES.get(pack_match.group(2).lower().strip("."), pack_match.group(2).lower())
        mult = qty if qty is not None else 1.0
        clean_name, extra_prep = clean_shopping_item_name(pack_match.group(3).strip())
        return {
            "raw_text": original,
            "quantity": round(mult * inner_qty, 3),
            "unit": inner_unit,
            "name": clean_name,
            "prep_notes": _merge_prep_notes(prep_notes, extra_prep),
        }

    # Try matching unit at start of rest
    unit = ""
    rest_clean = rest.strip()
    # Check two-word units first ("fl oz", "fluid ounce", etc.)
    two_word = re.match(r"^(fl\.?\s*oz\.?|fluid\s+ounces?)\b\.?\s*(?:of\s+)?(.*)$", rest_clean, re.IGNORECASE)
    if two_word:
        u_raw = re.sub(r"\s+", " ", two_word.group(1).lower().replace(".", "")).strip()
        unit = UNIT_ALIASES.get(u_raw, "fl_oz")
        rest_clean = two_word.group(2).strip()
    else:
        one_word = re.match(r"^([a-zA-Z]+)\.?\s+(?:of\s+)?(.*)$", rest_clean)
        if one_word:
            cand = one_word.group(1).lower()
            has_of = bool(re.match(r"^[a-zA-Z]+\.?\s+of\s+", rest_clean, re.IGNORECASE))
            if cand in UNIT_ALIASES and (qty is not None or cand in ("pinch", "dash") or has_of):
                unit = UNIT_ALIASES[cand]
                rest_clean = one_word.group(2).strip()
            elif cand in SIZE_ADJECTIVES and qty is not None:
                # e.g., "2 large yellow onions" -> unit stays count/empty, keep name clean
                rest_clean = one_word.group(2).strip()

    # Clean trailing "or to taste" / "(optional)"
    rest_clean = re.sub(r"\s*\((?:optional|divided|to taste)\)\s*", " ", rest_clean, flags=re.IGNORECASE).strip()

    clean_name, extra_prep = clean_shopping_item_name(rest_clean or working)
    return {
        "raw_text": original,
        "quantity": qty,
        "unit": unit,
        "name": clean_name,
        "prep_notes": _merge_prep_notes(prep_notes, extra_prep),
    }


def _strip_fillers(text: str) -> str:
    s = normalize_item_key(text)
    changed = True
    while changed:
        changed = False
        for pref in FILLER_PREFIXES:
            if s.startswith(pref + " "):
                s = s[len(pref) + 1 :].strip()
                changed = True
    return s


def _expand_singulars(terms: list[str]) -> list[str]:
    out: list[str] = []
    for c in terms:
        if c and c not in out:
            out.append(c)
        if c.endswith("es") and len(c) > 4:
            s = c[:-2]
            if s not in out:
                out.append(s)
        if c.endswith("s") and len(c) > 3:
            s = c[:-1]
            if s not in out:
                out.append(s)
    return out


def match_catalog_item(name: str, catalog_rows: list[dict]) -> Optional[dict]:
    if not name:
        return None
    norm = normalize_item_key(name)
    stripped = _strip_fillers(name)
    norm_candidates = _expand_singulars([norm])
    stripped_candidates = [c for c in _expand_singulars([stripped]) if c not in norm_candidates]
    all_candidates = norm_candidates + stripped_candidates

    # 1a. Exact canonical or alias match on the unstripped name first
    # (prevents e.g. "sweet potato" from matching "potato" before "sweet potato")
    for row in catalog_rows:
        cname = row["canonical_name"].lower()
        aliases = [a.lower() for a in json.loads(row.get("aliases_json") or "[]")]
        if any(c == cname or c in aliases for c in norm_candidates):
            return row

    # 1b. Exact canonical or alias match after stripping filler prefixes
    if stripped_candidates:
        for row in catalog_rows:
            cname = row["canonical_name"].lower()
            aliases = [a.lower() for a in json.loads(row.get("aliases_json") or "[]")]
            if any(c == cname or c in aliases for c in stripped_candidates):
                return row

    # 2. Longest substring match (canonical or alias inside ingredient name)
    best_row = None
    best_len = 0
    for row in catalog_rows:
        terms = [row["canonical_name"].lower()] + [a.lower() for a in json.loads(row.get("aliases_json") or "[]")]
        for term in terms:
            if len(term) < 4:
                continue
            for c in all_candidates:
                if re.search(rf"\b{re.escape(term)}\b", c) and len(term) > best_len:
                    best_len = len(term)
                    best_row = row
    return best_row


def convert_quantity(
    qty: float,
    from_unit: str,
    to_unit: str,
    canonical_name: str = "",
) -> Optional[float]:
    if qty is None:
        return None
    fu = (from_unit or "count").lower()
    tu = (to_unit or "count").lower()

    if fu == tu:
        return qty
    if fu == "" and tu == "count":
        return qty
    if fu == "count" and tu == "":
        return qty

    # Special culinary equivalents
    if canonical_name == "garlic":
        if fu == "head" and tu == "clove":
            return qty * 10.0
        if fu == "clove" and tu == "head":
            return qty / 10.0
        if fu == "tsp" and tu == "clove":
            return qty * 1.0
        if fu == "tbsp" and tu == "clove":
            return qty * 3.0

    if canonical_name == "butter":
        # 1 stick = 4 oz = 8 tbsp = 0.5 cup
        if fu == "stick":
            oz_val = qty * 4.0
            return convert_quantity(oz_val, "oz", tu, canonical_name)
        if tu == "stick":
            oz_val = convert_quantity(qty, fu, "oz", canonical_name)
            return oz_val / 4.0 if oz_val is not None else None

    if canonical_name in {"lemon", "lime"}:
        juice_tbsp = 3.0 if canonical_name == "lemon" else 2.0
        if fu in VOLUME_TO_TSP and tu == "count":
            tbsp_needed = (qty * VOLUME_TO_TSP[fu]) / 3.0
            return tbsp_needed / juice_tbsp

    # Standard volume -> volume
    if fu in VOLUME_TO_TSP and tu in VOLUME_TO_TSP:
        return qty * VOLUME_TO_TSP[fu] / VOLUME_TO_TSP[tu]

    # Standard weight -> weight
    if fu in WEIGHT_TO_G and tu in WEIGHT_TO_G:
        return qty * WEIGHT_TO_G[fu] / WEIGHT_TO_G[tu]

    # Water/broth/oil/milk: 1 fl_oz ~= 1 oz
    if fu in VOLUME_TO_TSP and tu in WEIGHT_TO_G:
        cups = qty * VOLUME_TO_TSP[fu] / VOLUME_TO_TSP["cup"]
        oz_per_cup = CUP_TO_OZ_DENSITY.get(canonical_name, 8.0)
        oz_val = cups * oz_per_cup
        return oz_val * WEIGHT_TO_G["oz"] / WEIGHT_TO_G[tu]

    if fu in WEIGHT_TO_G and tu in VOLUME_TO_TSP:
        oz_val = qty * WEIGHT_TO_G[fu] / WEIGHT_TO_G["oz"]
        oz_per_cup = CUP_TO_OZ_DENSITY.get(canonical_name, 8.0)
        cups = oz_val / oz_per_cup
        return cups * VOLUME_TO_TSP["cup"] / VOLUME_TO_TSP[tu]

    # Canned item fallback: 1 can ~= 15 oz
    if fu == "can" and tu in WEIGHT_TO_G:
        return (qty * 15.0) * WEIGHT_TO_G["oz"] / WEIGHT_TO_G[tu]
    if fu == "can" and tu in VOLUME_TO_TSP:
        return (qty * 15.0) * VOLUME_TO_TSP["fl_oz"] / VOLUME_TO_TSP[tu]

    return None


def format_qty(val: Optional[float]) -> str:
    if val is None:
        return ""
    if abs(val - round(val)) < 0.02:
        return str(int(round(val)))
    return f"{val:.2f}".rstrip("0").rstrip(".")


def compute_grocery_packages(
    aggregated_entries: list[dict[str, Any]],
    catalog_rows: list[dict],
    in_stock_pantry_keys: Optional[set[str]] = None,
) -> list[dict[str, Any]]:
    """
    Takes a list of recipe ingredient occurrences:
      [{"name": str, "quantity": float|None, "unit": str, "recipe_title": str, "catalog_id": int|None}]
    Merges identical items, converts units, and calculates US store package quantities.
    """
    pantry_set = in_stock_pantry_keys or set()
    cat_by_id = {r["id"]: r for r in catalog_rows}
    buckets: dict[str, dict[str, Any]] = {}

    for entry in aggregated_entries:
        cleaned_entry_name, _ = clean_shopping_item_name(entry["name"])
        effective_name = cleaned_entry_name or entry["name"]
        cat = cat_by_id.get(entry.get("catalog_id")) if entry.get("catalog_id") else None
        if not cat:
            cat = match_catalog_item(effective_name, catalog_rows)

        if cat:
            key = cat["canonical_name"]
            display = cat["display_name"]
            dept = cat["default_department"]
            is_staple = bool(cat["is_pantry_staple"]) or (key in pantry_set)
        else:
            key = _strip_fillers(effective_name) or normalize_item_key(effective_name)
            display = effective_name.strip().title()
            dept = "Other"
            is_staple = key in pantry_set

        if key not in buckets:
            buckets[key] = {
                "item_key": key,
                "name": display,
                "catalog": cat,
                "default_department": dept,
                "is_pantry_staple": is_staple,
                "occurrences": [],
                "recipes": [],
            }

        b = buckets[key]
        b["occurrences"].append({"quantity": entry.get("quantity"), "unit": entry.get("unit") or ""})
        rtitle = entry.get("recipe_title")
        if rtitle and rtitle not in b["recipes"]:
            b["recipes"].append(rtitle)

    results = []
    for key, b in buckets.items():
        cat = b["catalog"]
        occs = b["occurrences"]
        buy_qty = 1.0
        buy_unit = ""
        needed_summary = ""

        if cat:
            pkg_size = float(cat["package_size"] or 1.0)
            pkg_unit = cat["package_unit"]
            pkg_label = cat["package_label"]
            converted_total = 0.0
            unconverted = []

            for occ in occs:
                q = occ["quantity"]
                u = occ["unit"] or "count"
                if q is None:
                    unconverted.append("to taste" if b["is_pantry_staple"] else "1")
                    continue
                conv = convert_quantity(q, u, pkg_unit, cat["canonical_name"])
                if conv is not None:
                    converted_total += conv
                else:
                    unconverted.append(f"{format_qty(q)} {u}".strip())

            is_bulk_weight = (
                pkg_unit in WEIGHT_UNITS
                and abs(pkg_size - 1.0) < 0.01
                and pkg_label.strip().lower() in ("lb", "lbs", "oz", "g", "kg", "1 lb", "1 oz", "lb / crown")
            )

            if converted_total > 0:
                if is_bulk_weight:
                    buy_qty = round(converted_total, 2)
                    buy_unit = pkg_unit
                else:
                    raw_packs = converted_total / pkg_size
                    # Tolerance so 16.01 oz doesn't round up to 2 x 16 oz packs
                    buy_qty = float(max(1, math.ceil(raw_packs - 0.03)))
                    buy_unit = pkg_label
                need_str = f"{format_qty(converted_total)} {pkg_unit.replace('_', ' ')}"
                if unconverted:
                    need_str += f" + {', '.join(unconverted)}"
                needed_summary = f"Need {need_str} · Std: {pkg_label}"
            else:
                buy_qty = 1.0
                buy_unit = pkg_unit if is_bulk_weight else pkg_label
                needed_summary = f"Std: {pkg_label}" + (f" ({', '.join(unconverted)})" if unconverted else "")
        else:
            # No catalog match: sum compatible quantities directly
            numeric_occs = [o for o in occs if o["quantity"] is not None]
            if numeric_occs:
                target_u = numeric_occs[0]["unit"]
                total = 0.0
                mixed = []
                for o in numeric_occs:
                    c = convert_quantity(o["quantity"], o["unit"], target_u)
                    if c is not None:
                        total += c
                    else:
                        mixed.append(f"{format_qty(o['quantity'])} {o['unit']}".strip())
                buy_qty = float(math.ceil(total)) if target_u in ("", "count") else round(total, 2)
                buy_unit = target_u
                if mixed:
                    needed_summary = "Also: " + ", ".join(mixed)
            else:
                buy_qty = 1.0
                buy_unit = ""

        results.append(
            {
                "item_key": b["item_key"],
                "name": b["name"],
                "buy_qty": buy_qty,
                "buy_unit": buy_unit,
                "is_weight": is_weight_unit(buy_unit),
                "needed_summary": needed_summary,
                "default_department": b["default_department"],
                "is_pantry_staple": b["is_pantry_staple"],
                "source_recipes": b["recipes"],
                "include_by_default": not b["is_pantry_staple"],
                "catalog_id": cat["id"] if cat else None,
                "package_size": float(cat["package_size"]) if cat else 1.0,
                "package_unit": cat["package_unit"] if cat else (buy_unit or "count"),
                "package_label": cat["package_label"] if cat else (buy_unit or "1 item"),
            }
        )

    results.sort(key=lambda x: (x["is_pantry_staple"], x["default_department"], x["name"].lower()))
    return results
