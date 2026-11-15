import html
import json
import re
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from app.units import parse_ingredient_line

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": "https://www.google.com/",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


def _clean_text(val: Any) -> str:
    if val is None:
        return ""
    s = html.unescape(str(val))
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _parse_iso_duration_minutes(val: Any) -> Optional[int]:
    if not val or not isinstance(val, str):
        return None
    m = re.match(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$", val.strip(), re.IGNORECASE)
    if not m:
        return None
    days = int(m.group(1) or 0)
    hours = int(m.group(2) or 0)
    mins = int(m.group(3) or 0)
    total = days * 1440 + hours * 60 + mins
    return total if total > 0 else None


def _parse_servings(val: Any) -> float:
    if val is None:
        return 4.0
    if isinstance(val, (int, float)):
        return float(val) if val > 0 else 4.0
    if isinstance(val, list) and val:
        return _parse_servings(val[0])
    m = re.search(r"(\d+(?:\.\d+)?)", str(val))
    if m:
        n = float(m.group(1))
        return n if n > 0 else 4.0
    return 4.0


def _is_recipe_type(obj: dict) -> bool:
    t = obj.get("@type")
    if isinstance(t, str):
        return t.lower() == "recipe" or t.lower().endswith("/recipe")
    if isinstance(t, list):
        return any(isinstance(x, str) and (x.lower() == "recipe" or x.lower().endswith("/recipe")) for x in t)
    return False


def _find_recipe_json_ld(data: Any) -> Optional[dict]:
    if isinstance(data, dict):
        if _is_recipe_type(data):
            return data
        if "@graph" in data and isinstance(data["@graph"], list):
            for node in data["@graph"]:
                found = _find_recipe_json_ld(node)
                if found:
                    return found
        for v in data.values():
            if isinstance(v, (dict, list)):
                found = _find_recipe_json_ld(v)
                if found:
                    return found
    elif isinstance(data, list):
        for item in data:
            found = _find_recipe_json_ld(item)
            if found:
                return found
    return None


def _extract_instructions(raw: Any) -> list[str]:
    steps: list[str] = []
    if not raw:
        return steps
    if isinstance(raw, str):
        for line in re.split(r"\r?\n+", raw):
            c = _clean_text(line)
            if c:
                steps.append(c)
        return steps
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                c = _clean_text(item)
                if c:
                    steps.append(c)
            elif isinstance(item, dict):
                itype = str(item.get("@type", "")).lower()
                if itype == "howtosection" and isinstance(item.get("itemListElement"), list):
                    sec_name = _clean_text(item.get("name"))
                    sub_steps = _extract_instructions(item["itemListElement"])
                    if sec_name and sub_steps:
                        sub_steps[0] = f"[{sec_name}] {sub_steps[0]}"
                    steps.extend(sub_steps)
                else:
                    txt = _clean_text(item.get("text") or item.get("name") or "")
                    if txt:
                        steps.append(txt)
    return steps


def _extract_image(img: Any) -> str:
    if isinstance(img, str):
        return img.strip()
    if isinstance(img, list) and img:
        for item in img:
            cand = _extract_image(item)
            if cand:
                return cand
        return ""
    if isinstance(img, dict):
        return str(img.get("url") or img.get("contentUrl") or "").strip()
    return ""


def _extract_fallback_image(soup: BeautifulSoup, base_url: str) -> str:
    def _valid_img(url_candidate: str) -> str:
        raw = str(url_candidate or "").strip()
        if not raw or raw.startswith("data:image/svg"):
            return ""
        low = raw.lower()
        if any(bad in low for bad in ("gravatar", "avatar", "/icon", "favicon", "sprite", "1x1", "pixel", "logo")):
            return ""
        return urljoin(base_url, raw) if base_url else raw

    for sel, attr in [
        ("meta[property='og:image:secure_url']", "content"),
        ("meta[property='og:image']", "content"),
        ("meta[property='og:image:url']", "content"),
        ("meta[name='twitter:image:src']", "content"),
        ("meta[name='twitter:image']", "content"),
        ("link[rel='image_src']", "href"),
    ]:
        el = soup.select_one(sel)
        if el and el.get(attr):
            cand = _valid_img(el.get(attr))
            if cand:
                return cand

    # Check any JSON-LD object for an image/thumbnailUrl even if no Recipe node exists
    for script in soup.find_all("script", type=re.compile(r"application/ld\+json", re.I)):
        raw_json = script.string or script.get_text()
        if not raw_json or not raw_json.strip():
            continue
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        stack = [data]
        while stack:
            node = stack.pop(0)
            if isinstance(node, dict):
                img = _extract_image(node.get("image") or node.get("thumbnailUrl"))
                cand = _valid_img(img)
                if cand:
                    return cand
                for v in node.values():
                    if isinstance(v, (dict, list)):
                        stack.append(v)
            elif isinstance(node, list):
                stack.extend(node)

    for sel in [
        ".wprm-recipe-image img",
        ".tasty-recipes-image img",
        ".mv-create-image img",
        "img[itemprop='image']",
        "article img",
        "main img",
        ".entry-content img",
        ".post-content img",
        "img",
    ]:
        for el in soup.select(sel):
            for attr in ("data-lazy-src", "data-src", "data-pin-media", "src"):
                if el.get(attr):
                    cand = _valid_img(el.get(attr))
                    if cand:
                        return cand
            srcset = el.get("srcset") or el.get("data-srcset") or ""
            if srcset:
                first_src = srcset.split(",")[0].strip().split(" ")[0]
                cand = _valid_img(first_src)
                if cand:
                    return cand
    return ""


def _extract_tags(recipe_obj: dict) -> list[str]:
    tags: list[str] = []
    for key in ("recipeCategory", "recipeCuisine"):
        v = recipe_obj.get(key)
        if isinstance(v, str):
            tags.extend([_clean_text(x) for x in v.split(",") if _clean_text(x)])
        elif isinstance(v, list):
            tags.extend([_clean_text(x) for x in v if _clean_text(x)])
    seen = set()
    out = []
    for t in tags:
        tl = t.lower()
        if tl not in seen:
            seen.add(tl)
            out.append(t)
    return out[:6]


def _parse_nutrient_number(val: Any) -> Optional[float]:
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return round(float(val), 1)
    m = re.search(r"(\d+(?:\.\d+)?)", str(val))
    if m:
        return round(float(m.group(1)), 1)
    return None


def _extract_nutrition(recipe_ld: dict) -> dict[str, Optional[float]]:
    nut = recipe_ld.get("nutrition")
    if not isinstance(nut, dict):
        return {
            "calories_per_serving": None,
            "protein_g": None,
            "carbs_g": None,
            "fat_g": None,
            "fiber_g": None,
        }
    return {
        "calories_per_serving": _parse_nutrient_number(nut.get("calories")),
        "protein_g": _parse_nutrient_number(nut.get("proteinContent")),
        "carbs_g": _parse_nutrient_number(nut.get("carbohydrateContent")),
        "fat_g": _parse_nutrient_number(nut.get("fatContent")),
        "fiber_g": _parse_nutrient_number(nut.get("fiberContent")),
    }


def _extract_html_nutrition(soup: BeautifulSoup) -> dict[str, Optional[float]]:
    def _sel_num(selectors: list[str]) -> Optional[float]:
        for sel in selectors:
            el = soup.select_one(sel)
            if el:
                val = _parse_nutrient_number(el.get_text(" "))
                if val is not None:
                    return val
        return None

    res = {
        "calories_per_serving": _sel_num([
            "[itemprop='calories']",
            ".wprm-nutrition-label-text-nutrition-container-calories .wprm-nutrition-label-text-nutrition-value",
            ".tasty-recipes-calories",
        ]),
        "protein_g": _sel_num([
            "[itemprop='proteinContent']",
            ".wprm-nutrition-label-text-nutrition-container-protein .wprm-nutrition-label-text-nutrition-value",
            ".tasty-recipes-protein",
        ]),
        "carbs_g": _sel_num([
            "[itemprop='carbohydrateContent']",
            ".wprm-nutrition-label-text-nutrition-container-carbohydrates .wprm-nutrition-label-text-nutrition-value",
            ".tasty-recipes-carbohydrates",
        ]),
        "fat_g": _sel_num([
            "[itemprop='fatContent']",
            ".wprm-nutrition-label-text-nutrition-container-fat .wprm-nutrition-label-text-nutrition-value",
            ".tasty-recipes-fat",
        ]),
        "fiber_g": _sel_num([
            "[itemprop='fiberContent']",
            ".wprm-nutrition-label-text-nutrition-container-fiber .wprm-nutrition-label-text-nutrition-value",
            ".tasty-recipes-fiber",
        ]),
    }

    if all(v is not None for v in res.values()):
        return res

    # Fallback: search nutrition text boxes or nutrition sections in page text
    nut_blocks = [
        el.get_text(" ", strip=True)
        for el in soup.select(
            ".wprm-nutrition-label-container, .tasty-recipes-nutrition, .mv-create-nutrition-box, [class*='nutrition'], #nutrition"
        )
    ]
    search_text = " \n ".join(nut_blocks) if nut_blocks else _clean_text(soup.get_text(" "))

    def _re_num(pattern: str) -> Optional[float]:
        m = re.search(pattern, search_text, re.I)
        return round(float(m.group(1)), 1) if m else None

    if res["calories_per_serving"] is None:
        res["calories_per_serving"] = _re_num(r"(?:Calories|Energy)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:kcal|cal)?\b")
    if res["protein_g"] is None:
        res["protein_g"] = _re_num(r"Protein\s*:?\s*(\d+(?:\.\d+)?)\s*g?\b")
    if res["carbs_g"] is None:
        res["carbs_g"] = _re_num(r"(?:Total\s+)?(?:Carbohydrates?|Carbs?)\s*:?\s*(\d+(?:\.\d+)?)\s*g?\b")
    if res["fat_g"] is None:
        res["fat_g"] = _re_num(r"(?:Total\s+)?Fat\s*:?\s*(\d+(?:\.\d+)?)\s*g?\b")
    if res["fiber_g"] is None:
        res["fiber_g"] = _re_num(r"(?:Dietary\s+)?Fiber\s*:?\s*(\d+(?:\.\d+)?)\s*g?\b")

    return res


def _build_recipe_from_ld(recipe_ld: dict, base_url: str, fallback_image: str = "") -> Optional[dict[str, Any]]:
    title = _clean_text(recipe_ld.get("name") or "")
    desc = _clean_text(recipe_ld.get("description") or "")
    servings = _parse_servings(recipe_ld.get("recipeYield"))
    prep_mins = _parse_iso_duration_minutes(recipe_ld.get("prepTime"))
    cook_mins = _parse_iso_duration_minutes(recipe_ld.get("cookTime"))
    raw_ings = recipe_ld.get("recipeIngredient") or []
    if isinstance(raw_ings, str):
        raw_ings = [x.strip() for x in raw_ings.splitlines() if x.strip()]
    ingredients = [parse_ingredient_line(_clean_text(x)) for x in raw_ings if _clean_text(x)]
    steps = _extract_instructions(recipe_ld.get("recipeInstructions"))
    image_url = _extract_image(recipe_ld.get("image"))
    if image_url and base_url:
        image_url = urljoin(base_url, image_url)
    elif not image_url:
        image_url = fallback_image
    tags = _extract_tags(recipe_ld)
    nut = _extract_nutrition(recipe_ld)

    if title and (ingredients or steps):
        return {
            "title": title,
            "description": desc,
            "servings": servings,
            "prep_minutes": prep_mins,
            "cook_minutes": cook_mins,
            "source_url": base_url,
            "image_url": image_url,
            "tags": tags,
            "ingredients": ingredients,
            "steps": steps,
            **nut,
        }
    return None


_QTY_START_RE = re.compile(
    r"^(?:\d+[\d\s/.,-]*|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]+|\d+(?:\.\d+)?\s*(?:cups?|c\.|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|pinch|dash|cloves?|cans?|jars?|packages?|pkgs?|bunches?|heads?|stalks?|slices?|sprigs?|pieces?|large|medium|small))\b",
    re.I,
)
_IMPERATIVE_STEP_RE = re.compile(
    r"^(?:step\s*\d+\b|preheat|heat|warm|melt|bring|boil|simmer|cook|bake|roast|broil|grill|saute|sauté|sear|brown|fry|stir(?:\s+in)?|whisk|beat|mix|combine|toss|fold|pour|drain|rinse|pat|season|sprinkle|rub|coat|dip|arrange|place|put|transfer|remove|set\s+aside|let\s+(?:cool|rest|stand|sit)|chill|refrigerate|freeze|cover|uncover|reduce|deglaze|add\s+the|meanwhile|in\s+a\s+(?:large|medium|small|bowl|skillet|pan|pot|dutch\s+oven|baking|slow\s+cooker|instant\s+pot)|while\s+|once\s+|when\s+|using\s+|before\s+|after\s+|until\s+|prepare\s+|garnish\s+|serve\b)",
    re.I,
)
_COOKING_PHRASE_RE = re.compile(
    r"(?:\b\d+\s*(?:-|to\s+)?\d*\s*(?:min(?:utes?)?|sec(?:onds?)?|hours?|hrs?)\b|\d+\s*°\s*[fc]?\b|\bdegrees?\s*[fc]?\b|\bover\s+(?:medium|high|low)(?:-|\s+to\s+|\s+)?(?:high|low)?\s+heat\b|\buntil\s+(?:golden|tender|bubbly|thickened|melted|cooked|softened|translucent|done)\b)",
    re.I,
)
_NOISE_LINE_RE = re.compile(
    r"^(?:jump to recipe|print recipe|pin recipe|save recipe|share|tweet|facebook|pinterest|leave a comment|comments?|advertisement|sponsored|select all|metric|us customary|1x\s*2x\s*3x|course:|cuisine:|author:|keywords?:|equipment|video|cook mode|prevent your screen)",
    re.I,
)


def _strip_bullet(line: str) -> str:
    txt = re.sub(r"^(?:\[\s*[xX ]?\s*\]|[▢☐☑✓✔•*-])\s*", "", line.strip())
    txt = re.sub(r"^(?:step\s*\d+\s*[:.)\-]?\s*)", "", txt, flags=re.I)
    return re.sub(r"^\d+[\.)]\s*", "", txt).strip()


def _extract_lines_from_html(raw_content: str) -> list[str]:
    soup = BeautifulSoup(raw_content, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "button"]):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")

    # Prefer block elements in reading order so HTML structure isn't scrambled
    raw_blocks = []
    block_tags = soup.find_all(["h1", "h2", "h3", "h4", "h5", "li", "p", "tr"])
    if block_tags:
        for el in block_tags:
            # Skip wrapper paragraphs that contain nested lists
            if el.name == "p" and el.find(["li", "p", "h1", "h2", "h3"]):
                continue
            txt = _clean_text(el.get_text(" "))
            if txt and (not raw_blocks or raw_blocks[-1] != txt):
                raw_blocks.append(txt)
    if not raw_blocks:
        for line in soup.get_text("\n").splitlines():
            c = _clean_text(line)
            if c:
                raw_blocks.append(c)
    return raw_blocks


def _smart_parse_recipe_lines(
    lines: list[str],
    source_url: str = "",
    fallback_img: str = "",
    html_nut: Optional[dict[str, Optional[float]]] = None,
) -> dict[str, Any]:
    cleaned_lines = []
    for raw in lines:
        c = _clean_text(raw)
        if c:
            cleaned_lines.append(c)

    if not cleaned_lines:
        raise ValueError("No readable recipe text detected.")

    title = ""
    servings = 4.0
    prep_mins: Optional[int] = None
    cook_mins: Optional[int] = None
    nut = dict(html_nut or {
        "calories_per_serving": None,
        "protein_g": None,
        "carbs_g": None,
        "fat_g": None,
        "fiber_g": None,
    })

    ing_lines: list[str] = []
    step_lines: list[str] = []
    note_lines: list[str] = []

    section: Optional[str] = None  # None | 'ingredients' | 'steps' | 'notes' | 'nutrition'

    for raw in cleaned_lines:
        if _NOISE_LINE_RE.match(raw):
            continue
        if re.match(r"^\d+(?:\.\d+)?\s*(?:stars?|out of\s*\d+|from\s*\d+\s*votes?|ratings?)\b", raw, re.I):
            continue

        # Metadata detection (Prep/Cook/Servings/Nutrition)
        m_prep = re.match(r"^prep(?:\s*time)?\s*[:\-]\s*(.+)$", raw, re.I)
        if m_prep and len(raw) < 55:
            m_num = re.search(r"(\d+)", m_prep.group(1))
            if m_num:
                prep_mins = int(m_num.group(1))
            continue

        m_cook = re.match(r"^cook(?:\s*time)?\s*[:\-]\s*(.+)$", raw, re.I)
        if m_cook and len(raw) < 55:
            m_num = re.search(r"(\d+)", m_cook.group(1))
            if m_num:
                cook_mins = int(m_num.group(1))
            continue

        m_srv = re.match(r"^(?:servings?|yields?|makes?)\s*[:\-]?\s*(\d+(?:\.\d+)?)\b", raw, re.I)
        if m_srv and len(raw) < 45:
            servings = max(1.0, float(m_srv.group(1)))
            continue

        # Nutrition line inside pasted text
        if len(raw) < 90 and re.match(r"^(?:calories|protein|carbohydrates?|carbs|total fat|fat|dietary fiber|fiber)\s*[:\-]", raw, re.I):
            val = _parse_nutrient_number(raw)
            low_n = raw.lower()
            if val is not None:
                if "calor" in low_n and nut["calories_per_serving"] is None:
                    nut["calories_per_serving"] = val
                elif "protein" in low_n and nut["protein_g"] is None:
                    nut["protein_g"] = val
                elif "carb" in low_n and nut["carbs_g"] is None:
                    nut["carbs_g"] = val
                elif "fat" in low_n and nut["fat_g"] is None:
                    nut["fat_g"] = val
                elif "fiber" in low_n and nut["fiber_g"] is None:
                    nut["fiber_g"] = val
            continue

        low_hdr = raw.lower().rstrip(":").strip()
        if re.match(
            r"^(?:ingredients?|ingredient list|what you(?:'ll)? need|for the\s+.+)$",
            low_hdr,
        ) and len(raw) <= 60:
            section = "ingredients"
            continue

        if re.match(
            r"^(?:instructions?|directions?|steps?|method|preparation|how to (?:make|prepare|cook).*|cooking (?:instructions?|directions?|steps?)|step[- ]by[- ]step.*)$",
            low_hdr,
        ) and len(raw) <= 70:
            section = "steps"
            continue

        if re.match(r"^(?:notes?|recipe notes?|tips?|chef'?s notes?|variations?)$", low_hdr) and len(raw) <= 50:
            section = "notes"
            continue

        if re.match(r"^(?:nutrition(?:al)?(?:\s+facts|\s+info|\s+information)?)$", low_hdr) and len(raw) <= 50:
            section = "nutrition"
            continue

        # First non-noise, non-ingredient, non-step line before any header is likely the title
        had_step_prefix = bool(re.match(r"^(?:step\s*\d+\b|\d+[\.)]\s+\S)", raw, re.I))
        cleaned_body = _strip_bullet(raw)
        if not cleaned_body:
            continue

        looks_qty = bool(_QTY_START_RE.match(cleaned_body))
        looks_step_verb = bool(_IMPERATIVE_STEP_RE.match(cleaned_body))
        has_cooking_phrase = bool(_COOKING_PHRASE_RE.search(cleaned_body))
        is_long_sentence = len(cleaned_body) > 95 or len(cleaned_body.split()) >= 16

        if not title and section is None and not looks_qty and not looks_step_verb and not had_step_prefix and len(cleaned_body) <= 120:
            title = cleaned_body
            continue

        if section == "nutrition":
            continue
        if section == "notes":
            note_lines.append(cleaned_body)
            continue

        # Decide between step and ingredient cleanly so steps never spill into ingredients
        is_step = False
        if re.match(r"^step\s*\d+\b", raw, re.I):
            is_step = True
        elif section == "steps":
            # Only flip back to ingredients if an explicit qty-line with short ingredient shape appears? Normally keep in steps.
            is_step = not (looks_qty and len(cleaned_body) <= 45 and not looks_step_verb and not has_cooking_phrase and not cleaned_body.endswith("."))
        elif section == "ingredients":
            # Protect against missing "Instructions:" heading when steps appear right after ingredients
            if (looks_step_verb and not looks_qty) or (has_cooking_phrase and not looks_qty) or (is_long_sentence and not looks_qty):
                is_step = True
                section = "steps"
            else:
                is_step = False
        else:
            # Before any explicit header (section is None)
            if looks_step_verb and not looks_qty:
                is_step = True
                section = "steps"
            elif has_cooking_phrase and not looks_qty:
                is_step = True
                section = "steps"
            elif is_long_sentence and not looks_qty:
                is_step = True
                section = "steps"
            elif had_step_prefix and not looks_qty:
                is_step = True
                section = "steps"
            elif looks_qty:
                is_step = False
            elif len(cleaned_body) <= 55 and not cleaned_body.endswith("."):
                is_step = False
            else:
                is_step = True

        if is_step:
            step_lines.append(cleaned_body)
        else:
            ing_lines.append(cleaned_body)

    if not ing_lines and not step_lines:
        raise ValueError(
            "Could not detect recipe ingredients or steps. "
            "Try the Separate Ingredients & Steps option or copy the recipe text directly."
        )

    return {
        "title": (title or "Imported Recipe")[:160],
        "description": "",
        "servings": servings,
        "prep_minutes": prep_mins,
        "cook_minutes": cook_mins,
        "source_url": source_url,
        "image_url": fallback_img,
        "tags": [],
        "notes": "\n".join(note_lines[:5]),
        "ingredients": [parse_ingredient_line(x) for x in ing_lines],
        "steps": step_lines,
        **nut,
    }


def parse_recipe_html_or_text(raw_content: str, source_url: str = "") -> dict[str, Any]:
    looks_like_html = bool(re.search(r"<(?:div|p|li|ul|ol|h[1-6]|span|article|section|meta|script)\b", raw_content, re.I))
    soup = BeautifulSoup(raw_content, "lxml") if looks_like_html else None
    fallback_img = _extract_fallback_image(soup, source_url) if soup else ""
    html_nut = _extract_html_nutrition(soup) if soup else None

    if soup:
        # 1. Try JSON-LD scripts
        for script in soup.find_all("script", type=re.compile(r"application/ld\+json", re.I)):
            raw_json = script.string or script.get_text()
            if not raw_json or not raw_json.strip():
                continue
            try:
                data = json.loads(raw_json)
                recipe_ld = _find_recipe_json_ld(data)
                if recipe_ld:
                    built = _build_recipe_from_ld(recipe_ld, source_url, fallback_img)
                    if built:
                        # Fill any missing nutrition from HTML selectors if JSON-LD omitted it
                        if html_nut:
                            for k, v in html_nut.items():
                                if built.get(k) is None and v is not None:
                                    built[k] = v
                        return built
            except json.JSONDecodeError:
                continue

        # 2. Try Microdata / WordPress recipe plugin HTML selectors (WPRM, Tasty, Mediavine Create, etc.)
        title_el = soup.select_one(
            ".wprm-recipe-name, .tasty-recipes-title, .mv-create-title, h1.entry-title, h1[itemprop='name'], h1"
        )
        title = _clean_text(title_el.get_text()) if title_el else ""

        ing_els = soup.select(
            "[itemprop='recipeIngredient'], .wprm-recipe-ingredient, .tasty-recipes-ingredients li, .mv-create-ingredients li, .recipe-ingredients li"
        )
        ingredients = []
        for el in ing_els:
            txt = _clean_text(el.get_text(" "))
            txt = re.sub(r"^[▢☐☑✓✔•*-]\s*", "", txt).strip()
            if txt:
                ingredients.append(parse_ingredient_line(txt))

        step_els = soup.select(
            "[itemprop='recipeInstructions'] li, .wprm-recipe-instruction-text, .tasty-recipes-instructions li, .mv-create-instructions li, .recipe-directions li"
        )
        steps = []
        for el in step_els:
            txt = _clean_text(el.get_text(" "))
            if txt:
                steps.append(txt)

        if ingredients and steps:
            return {
                "title": title or "Imported Recipe",
                "description": "",
                "servings": 4.0,
                "prep_minutes": None,
                "cook_minutes": None,
                "source_url": source_url,
                "image_url": fallback_img,
                "tags": [],
                "ingredients": ingredients,
                "steps": steps,
                **(html_nut or {}),
            }

        # 3. Extract clean reading-order lines from HTML DOM rather than raw HTML tags
        dom_lines = _extract_lines_from_html(raw_content)
        if dom_lines:
            parsed_dom = _smart_parse_recipe_lines(dom_lines, source_url, fallback_img, html_nut)
            if title and parsed_dom.get("title") in ("", "Imported Recipe"):
                parsed_dom["title"] = title
            if ingredients and not parsed_dom["ingredients"]:
                parsed_dom["ingredients"] = ingredients
            if steps and not parsed_dom["steps"]:
                parsed_dom["steps"] = steps
            return parsed_dom

    # 4. Smart plain-text parser
    text_lines = [l for l in raw_content.splitlines() if l.strip()]
    return _smart_parse_recipe_lines(text_lines, source_url, fallback_img, html_nut)


async def _try_wordpress_rest_api(client: httpx.AsyncClient, parsed_url, original_url: str) -> Optional[dict[str, Any]]:
    """
    Many food blogs (including Budget Bytes) run WordPress with WP Recipe Maker / Yoast.
    When direct HTML requests get 403, query the public WordPress REST API by post slug.
    """
    path_parts = [p for p in parsed_url.path.split("/") if p]
    if not path_parts:
        return None
    slug = path_parts[-1]
    base_origin = f"{parsed_url.scheme}://{parsed_url.netloc}"
    api_url = f"{base_origin}/wp-json/wp/v2/posts?slug={slug}"

    try:
        resp = await client.get(
            api_url,
            headers={
                **HEADERS,
                "Accept": "application/json,text/plain,*/*",
                "Referer": base_origin + "/",
            },
        )
        if resp.status_code != 200:
            return None
        posts = resp.json()
        if not isinstance(posts, list) or not posts:
            return None
        post = posts[0]

        # 1. Check Yoast SEO schema in yoast_head_json
        yoast_json = post.get("yoast_head_json") or {}
        og_images = yoast_json.get("og_image") or []
        og_img_url = og_images[0].get("url", "") if (isinstance(og_images, list) and og_images and isinstance(og_images[0], dict)) else ""
        schema_data = yoast_json.get("schema")
        if schema_data:
            recipe_ld = _find_recipe_json_ld(schema_data)
            if recipe_ld:
                built = _build_recipe_from_ld(recipe_ld, original_url, og_img_url)
                if built:
                    return built

        # 2. Parse rendered HTML content + yoast_head
        rendered_html = (post.get("yoast_head") or "") + "\n" + (post.get("content", {}).get("rendered") or "")
        title_rendered = _clean_text(post.get("title", {}).get("rendered") or "")
        if rendered_html.strip():
            parsed = parse_recipe_html_or_text(rendered_html, original_url)
            if title_rendered and parsed.get("title") in ("", "Imported Recipe"):
                parsed["title"] = title_rendered
            if og_img_url and not parsed.get("image_url"):
                parsed["image_url"] = og_img_url
            return parsed
    except Exception:
        return None
    return None


async def scrape_recipe_url(url: str) -> dict[str, Any]:
    clean_url = url.strip()
    parsed = urlparse(clean_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Please enter a valid http:// or https:// recipe URL.")

    async with httpx.AsyncClient(follow_redirects=True, timeout=16.0, headers=HEADERS) as client:
        html_text = ""
        final_url = clean_url
        direct_status = None

        try:
            resp = await client.get(clean_url)
            direct_status = resp.status_code
            final_url = str(resp.url)
            if resp.status_code == 200:
                html_text = resp.text
        except Exception:
            direct_status = None

        if html_text:
            try:
                return parse_recipe_html_or_text(html_text, final_url)
            except ValueError:
                pass

        # Fallback: Try official WordPress REST API (/wp-json/wp/v2/posts?slug=...)
        wp_result = await _try_wordpress_rest_api(client, parsed, clean_url)
        if wp_result:
            return wp_result

        if direct_status in (403, 429):
            raise PermissionError(
                f"This website ({parsed.netloc}) blocked automated server connections (HTTP {direct_status}). "
                "Use the Quick Paste box below to paste the copied recipe text or page source!"
            )

        raise ValueError(
            "Could not automatically fetch recipe data from this URL. "
            "Use the Quick Paste box to paste the recipe text or page HTML."
        )
