import csv
import io
import json
import re
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.auth import get_current_user, utc_now_iso
from app.database import get_db
from app.scraper import scrape_recipe_url
from app.units import match_catalog_item, normalize_item_key, parse_ingredient_line

router = APIRouter(prefix="/api/import", tags=["import"])


class BulkUrlsPayload(BaseModel):
    urls: list[str]


def _read_tabular_rows(filename: str, content: bytes) -> list[dict[str, str]]:
    fname = (filename or "").lower()
    if fname.endswith(".xlsx"):
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        ws = wb.active
        all_rows = list(ws.iter_rows(values_only=True))
        if not all_rows:
            return []
        headers = [str(c or "").strip().lower() for c in all_rows[0]]
        result = []
        for r in all_rows[1:]:
            row_dict = {}
            for idx, h in enumerate(headers):
                if h and idx < len(r) and r[idx] is not None:
                    row_dict[h] = str(r[idx]).strip()
            if any(row_dict.values()):
                result.append(row_dict)
        return result

    # Default CSV / TSV
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    result = []
    for row in reader:
        clean = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items() if k}
        if any(clean.values()):
            result.append(clean)
    return result


def _extract_docx_or_text(filename: str, content: bytes) -> str:
    fname = (filename or "").lower()
    if fname.endswith(".docx"):
        import docx

        doc = docx.Document(io.BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    return content.decode("utf-8-sig", errors="replace")


def _parse_text_recipes(text: str) -> list[dict[str, Any]]:
    """
    Parses recipes from plain text / Markdown / Word (.docx) documents.
    Supports separating multiple recipes by '---' or '# Title' headings,
    and splitting each recipe by 'Ingredients:' and 'Instructions:' / 'Steps:' / 'Directions:'.
    """
    blocks = re.split(r"(?:\r?\n\s*---\s*\r?\n|\r?\n(?=#\s+\S))", text.strip())
    recipes = []
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        title = re.sub(r"^#+\s*", "", lines[0]).strip()
        mode = "ingredients"
        ingredients = []
        steps = []
        for line in lines[1:]:
            low = line.lower().rstrip(":")
            if low in ("ingredients", "ingredient list"):
                mode = "ingredients"
                continue
            if low in ("instructions", "steps", "directions", "method", "preparation"):
                mode = "steps"
                continue
            cleaned = re.sub(r"^[-*•]\s*", "", line)
            cleaned = re.sub(r"^\d+[\.)]\s*", "", cleaned)
            if mode == "ingredients":
                ingredients.append(cleaned)
            else:
                steps.append(cleaned)
        if title and (ingredients or steps):
            recipes.append(
                {
                    "title": title,
                    "description": "",
                    "servings": 4.0,
                    "tags": ["Imported"],
                    "source_url": "",
                    "image_url": "",
                    "ingredients": ingredients,
                    "steps": steps,
                }
            )
    return recipes


def _insert_recipe_dict(conn, r: dict[str, Any], catalog_rows: list[dict], user_id: int, now: str):
    title = (r.get("title") or r.get("name") or "").strip()
    if not title:
        return False
    desc = (r.get("description") or "").strip()
    try:
        servings = float(r.get("servings") or 4.0)
    except ValueError:
        servings = 4.0
    tags_raw = r.get("tags") or []
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in re.split(r"[,;]", tags_raw) if t.strip()]
    else:
        tags = [str(t).strip() for t in tags_raw if str(t).strip()]

    steps_raw = r.get("steps") or r.get("instructions") or r.get("directions") or []
    if isinstance(steps_raw, str):
        steps = [s.strip() for s in re.split(r"\r?\n|;\s*", steps_raw) if s.strip()]
    else:
        steps = [str(s).strip() for s in steps_raw if str(s).strip()]

    ings_raw = r.get("ingredients") or []
    if isinstance(ings_raw, str):
        ing_lines = [i.strip() for i in re.split(r"\r?\n|;\s*", ings_raw) if i.strip()]
    else:
        ing_lines = [
            (i.get("raw_text") or i.get("name") or "") if isinstance(i, dict) else str(i).strip()
            for i in ings_raw
        ]
        ing_lines = [x for x in ing_lines if x]

    cur = conn.execute(
        """
        INSERT INTO recipes (
            title, description, servings, prep_minutes, cook_minutes,
            source_url, image_url, tags_json, steps_json, notes, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            title,
            desc,
            servings,
            r.get("prep_minutes"),
            r.get("cook_minutes"),
            (r.get("source_url") or r.get("url") or "").strip(),
            (r.get("image_url") or r.get("image") or "").strip(),
            json.dumps(tags),
            json.dumps(steps),
            (r.get("notes") or "").strip(),
            user_id,
            now,
            now,
        ),
    )
    rid = cur.lastrowid
    for idx, line in enumerate(ing_lines):
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
    return True


@router.post("/recipes")
async def bulk_import_recipes(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    content = await file.read()
    fname = (file.filename or "").lower()
    now = utc_now_iso()

    parsed_recipes: list[dict[str, Any]] = []
    try:
        if fname.endswith(".json"):
            data = json.loads(content.decode("utf-8-sig"))
            parsed_recipes = data if isinstance(data, list) else data.get("recipes", [data])
        elif fname.endswith((".csv", ".xlsx")):
            rows = _read_tabular_rows(fname, content)
            for r in rows:
                parsed_recipes.append(
                    {
                        "title": r.get("title") or r.get("name") or r.get("recipe") or "",
                        "description": r.get("description") or r.get("summary") or "",
                        "servings": r.get("servings") or r.get("yield") or "4",
                        "tags": r.get("tags") or r.get("category") or "",
                        "ingredients": r.get("ingredients") or r.get("ingredient") or "",
                        "steps": r.get("steps") or r.get("instructions") or r.get("directions") or "",
                        "source_url": r.get("source_url") or r.get("url") or "",
                        "image_url": r.get("image_url") or r.get("image") or "",
                        "notes": r.get("notes") or "",
                    }
                )
        elif fname.endswith((".docx", ".txt", ".md")):
            txt = _extract_docx_or_text(fname, content)
            parsed_recipes = _parse_text_recipes(txt)
        else:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file format. Please upload .csv, .xlsx, .json, .docx, .txt, or .md",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse file: {exc}")

    imported = 0
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        for rec in parsed_recipes:
            if _insert_recipe_dict(conn, rec, catalog_rows, user["id"], now):
                imported += 1

    return {"imported": imported}


@router.post("/recipes-urls")
async def bulk_import_recipe_urls(payload: BulkUrlsPayload, user: dict = Depends(get_current_user)):
    now = utc_now_iso()
    imported = 0
    errors = []
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]

    for raw_url in payload.urls[:25]:
        u = raw_url.strip()
        if not u:
            continue
        try:
            scraped = await scrape_recipe_url(u)
            with get_db() as conn:
                if _insert_recipe_dict(conn, scraped, catalog_rows, user["id"], now):
                    imported += 1
        except Exception as exc:
            errors.append(f"{u}: {exc}")

    return {"imported": imported, "errors": errors}


@router.post("/store-locations/{store_id}")
async def bulk_import_store_locations(
    store_id: int,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    content = await file.read()
    fname = (file.filename or "").lower()
    if not fname.endswith((".csv", ".xlsx")):
        raise HTTPException(status_code=400, detail="Please upload a .csv or .xlsx file")

    rows = _read_tabular_rows(fname, content)
    now = utc_now_iso()
    imported = 0
    with get_db() as conn:
        store = conn.execute("SELECT id FROM stores WHERE id = ?", (store_id,)).fetchone()
        if not store:
            raise HTTPException(status_code=404, detail="Store not found")
        for r in rows:
            item_name = r.get("item") or r.get("item_display") or r.get("name") or r.get("product") or ""
            dept = r.get("department") or r.get("section") or r.get("category") or "Dry Goods"
            aisle = r.get("aisle") or r.get("bay") or r.get("location") or ""
            ikey = normalize_item_key(item_name)
            if not ikey:
                continue
            conn.execute(
                """
                INSERT INTO item_store_locations (item_key, item_display, store_id, department, aisle, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(item_key, store_id) DO UPDATE SET
                    item_display = excluded.item_display,
                    department = excluded.department,
                    aisle = excluded.aisle,
                    updated_at = excluded.updated_at
                """,
                (ikey, item_name, store_id, dept, aisle, now),
            )
            imported += 1

    return {"imported": imported}


@router.post("/pantry")
async def bulk_import_pantry(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    content = await file.read()
    fname = (file.filename or "").lower()
    if not fname.endswith((".csv", ".xlsx")):
        raise HTTPException(status_code=400, detail="Please upload a .csv or .xlsx file")

    rows = _read_tabular_rows(fname, content)
    now = utc_now_iso()
    imported = 0
    with get_db() as conn:
        catalog_rows = [dict(r) for r in conn.execute("SELECT * FROM product_catalog").fetchall()]
        for r in rows:
            name = r.get("name") or r.get("item") or r.get("product") or ""
            category = r.get("category") or r.get("section") or "Canned & Jarred Goods"
            note = r.get("quantity_note") or r.get("quantity") or r.get("notes") or "In Stock"
            stock_str = (r.get("in_stock") or r.get("stock") or "true").lower()
            in_stock = 0 if stock_str in ("0", "false", "no", "out", "low") else 1
            cat = match_catalog_item(name, catalog_rows)
            ikey = cat["canonical_name"] if cat else normalize_item_key(name)
            if not ikey:
                continue
            conn.execute(
                """
                INSERT INTO pantry_items (name, item_key, category, quantity_note, in_stock, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(item_key) DO UPDATE SET
                    name = excluded.name,
                    category = excluded.category,
                    quantity_note = excluded.quantity_note,
                    in_stock = excluded.in_stock,
                    updated_at = excluded.updated_at
                """,
                (name, ikey, category, note, in_stock, now),
            )
            imported += 1

    return {"imported": imported}
