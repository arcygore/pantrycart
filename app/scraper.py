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
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
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
        ("img[itemprop='image']", "src"),
    ]:
        el = soup.select_one(sel)
        if el and el.get(attr):
            raw = str(el.get(attr)).strip()
            if raw:
                return urljoin(base_url, raw)
    return ""


def _extract_tags(recipe_obj: dict) -> list[str]:
    tags: list[str] = []
    for key in ("recipeCategory", "recipeCuisine"):
        v = recipe_obj.get(key)
        if isinstance(v, str):
            tags.extend([_clean_text(x) for x in v.split(",") if _clean_text(x)])
        elif isinstance(v, list):
            tags.extend([_clean_text(x) for x in v if _clean_text(x)])
    # Deduplicate preserving order
    seen = set()
    out = []
    for t in tags:
        tl = t.lower()
        if tl not in seen:
            seen.add(tl)
            out.append(t)
    return out[:6]


async def scrape_recipe_url(url: str) -> dict[str, Any]:
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Please enter a valid http:// or https:// recipe URL.")

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=HEADERS) as client:
        resp = await client.get(url.strip())
        resp.raise_for_status()
        html_text = resp.text

    soup = BeautifulSoup(html_text, "lxml")

    # 1. Try JSON-LD first
    recipe_ld = None
    for script in soup.find_all("script", type=re.compile(r"application/ld\+json", re.I)):
        raw_json = script.string or script.get_text()
        if not raw_json or not raw_json.strip():
            continue
        try:
            data = json.loads(raw_json)
            recipe_ld = _find_recipe_json_ld(data)
            if recipe_ld:
                break
        except json.JSONDecodeError:
            continue

    if recipe_ld:
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
        if image_url:
            image_url = urljoin(str(resp.url), image_url)
        else:
            image_url = _extract_fallback_image(soup, str(resp.url))
        tags = _extract_tags(recipe_ld)

        if title and (ingredients or steps):
            return {
                "title": title,
                "description": desc,
                "servings": servings,
                "prep_minutes": prep_mins,
                "cook_minutes": cook_mins,
                "source_url": str(resp.url),
                "image_url": image_url,
                "tags": tags,
                "ingredients": ingredients,
                "steps": steps,
            }

    # 2. Fallback: Microdata / common WordPress recipe plugin selectors
    title_el = soup.select_one("h1.entry-title, h1.wprm-recipe-name, h1[itemprop='name'], h1")
    title = _clean_text(title_el.get_text()) if title_el else "Imported Recipe"

    ing_els = soup.select(
        "[itemprop='recipeIngredient'], .wprm-recipe-ingredient, .tasty-recipes-ingredients li, .recipe-ingredients li"
    )
    ingredients = []
    for el in ing_els:
        txt = _clean_text(el.get_text(" "))
        if txt:
            ingredients.append(parse_ingredient_line(txt))

    step_els = soup.select(
        "[itemprop='recipeInstructions'] li, .wprm-recipe-instruction-text, .tasty-recipes-instructions li, .recipe-directions li"
    )
    steps = []
    for el in step_els:
        txt = _clean_text(el.get_text(" "))
        if txt:
            steps.append(txt)

    if not ingredients and not steps:
        raise ValueError(
            "Could not automatically detect recipe data on this page. "
            "Some sites block scraping; you can copy & paste the ingredients and steps directly."
        )

    return {
        "title": title,
        "description": "",
        "servings": 4.0,
        "prep_minutes": None,
        "cook_minutes": None,
        "source_url": str(resp.url),
        "image_url": _extract_fallback_image(soup, str(resp.url)),
        "tags": [],
        "ingredients": ingredients,
        "steps": steps,
    }
