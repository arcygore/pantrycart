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
    for sel, attr in [
        ("meta[property='og:image']", "content"),
        ("meta[name='twitter:image']", "content"),
        (".wprm-recipe-image img", "src"),
        (".tasty-recipes-image img", "src"),
        ("img[itemprop='image']", "src"),
    ]:
        el = soup.select_one(sel)
        if el and el.get(attr):
            raw = str(el.get(attr)).strip()
            if raw:
                return urljoin(base_url, raw) if base_url else raw
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

    return {
        "calories_per_serving": _sel_num(["[itemprop='calories']", ".wprm-nutrition-label-text-nutrition-container-calories .wprm-nutrition-label-text-nutrition-value"]),
        "protein_g": _sel_num(["[itemprop='proteinContent']", ".wprm-nutrition-label-text-nutrition-container-protein .wprm-nutrition-label-text-nutrition-value"]),
        "carbs_g": _sel_num(["[itemprop='carbohydrateContent']", ".wprm-nutrition-label-text-nutrition-container-carbohydrates .wprm-nutrition-label-text-nutrition-value"]),
        "fat_g": _sel_num(["[itemprop='fatContent']", ".wprm-nutrition-label-text-nutrition-container-fat .wprm-nutrition-label-text-nutrition-value"]),
        "fiber_g": _sel_num(["[itemprop='fiberContent']", ".wprm-nutrition-label-text-nutrition-container-fiber .wprm-nutrition-label-text-nutrition-value"]),
    }


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


def parse_recipe_html_or_text(raw_content: str, source_url: str = "") -> dict[str, Any]:
    soup = BeautifulSoup(raw_content, "lxml")
    fallback_img = _extract_fallback_image(soup, source_url)

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
        # Strip leading checkbox symbols like "▢" used by WP Recipe Maker (e.g. Budget Bytes)
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

    if ingredients or steps:
        html_nut = _extract_html_nutrition(soup)
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
            **html_nut,
        }

    # 3. Plain-text fallback (if user pasted copied recipe text from page)
    lines = [re.sub(r"^[▢☐☑✓✔•*-]\s*", "", l.strip()) for l in raw_content.splitlines() if l.strip()]
    if len(lines) >= 3:
        inferred_title = lines[0]
        mode = "ingredients"
        txt_ings = []
        txt_steps = []
        for line in lines[1:]:
            low = line.lower().rstrip(":")
            if low in ("ingredients", "ingredient list"):
                mode = "ingredients"
                continue
            if low in ("instructions", "steps", "directions", "method", "how to make"):
                mode = "steps"
                continue
            cleaned = re.sub(r"^\d+[\.)]\s*", "", line)
            if mode == "ingredients":
                txt_ings.append(parse_ingredient_line(cleaned))
            else:
                txt_steps.append(cleaned)
        if txt_ings or txt_steps:
            return {
                "title": inferred_title[:160],
                "description": "",
                "servings": 4.0,
                "prep_minutes": None,
                "cook_minutes": None,
                "source_url": source_url,
                "image_url": "",
                "tags": [],
                "ingredients": txt_ings,
                "steps": txt_steps,
                "calories_per_serving": None,
                "protein_g": None,
                "carbs_g": None,
                "fat_g": None,
                "fiber_g": None,
            }

    raise ValueError(
        "Could not detect recipe ingredients or steps. "
        "You can copy & paste the recipe text or page HTML directly."
    )


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
