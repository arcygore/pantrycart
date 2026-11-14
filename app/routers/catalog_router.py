import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.database import get_db
from app.units import normalize_item_key

router = APIRouter(prefix="/api/catalog", tags=["catalog"])


class CatalogPayload(BaseModel):
    canonical_name: str = Field(min_length=1, max_length=120)
    display_name: str = Field(min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list)
    default_department: str = "Dry Goods"
    package_size: float = Field(default=1.0, gt=0)
    package_unit: str = "count"
    package_label: str = "1 item"
    is_pantry_staple: bool = False


def _serialize_cat(row) -> dict:
    return {
        "id": row["id"],
        "canonical_name": row["canonical_name"],
        "display_name": row["display_name"],
        "aliases": json.loads(row["aliases_json"] or "[]"),
        "default_department": row["default_department"],
        "package_size": row["package_size"],
        "package_unit": row["package_unit"],
        "package_label": row["package_label"],
        "is_pantry_staple": bool(row["is_pantry_staple"]),
    }


@router.get("")
def list_catalog(q: str = "", user: dict = Depends(get_current_user)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM product_catalog ORDER BY default_department ASC, display_name ASC").fetchall()
    items = [_serialize_cat(r) for r in rows]
    if q.strip():
        ql = q.strip().lower()
        items = [
            i
            for i in items
            if ql in i["display_name"].lower()
            or ql in i["canonical_name"].lower()
            or any(ql in a.lower() for a in i["aliases"])
        ]
    return items


@router.post("")
def create_catalog_item(payload: CatalogPayload, user: dict = Depends(get_current_user)):
    cname = normalize_item_key(payload.canonical_name)
    if not cname:
        raise HTTPException(status_code=400, detail="Canonical name is required")
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM product_catalog WHERE canonical_name = ?", (cname,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Product already exists in catalog")
        cur = conn.execute(
            """
            INSERT INTO product_catalog (
                canonical_name, display_name, aliases_json, default_department,
                package_size, package_unit, package_label, is_pantry_staple, store_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'grocery')
            """,
            (
                cname,
                payload.display_name.strip(),
                json.dumps([a.strip().lower() for a in payload.aliases if a.strip()]),
                payload.default_department.strip(),
                payload.package_size,
                payload.package_unit.strip(),
                payload.package_label.strip(),
                1 if payload.is_pantry_staple else 0,
            ),
        )
        row = conn.execute("SELECT * FROM product_catalog WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _serialize_cat(row)


@router.put("/{cat_id}")
def update_catalog_item(cat_id: int, payload: CatalogPayload, user: dict = Depends(get_current_user)):
    cname = normalize_item_key(payload.canonical_name)
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM product_catalog WHERE id = ?", (cat_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Catalog item not found")
        conn.execute(
            """
            UPDATE product_catalog
            SET canonical_name = ?, display_name = ?, aliases_json = ?, default_department = ?,
                package_size = ?, package_unit = ?, package_label = ?, is_pantry_staple = ?
            WHERE id = ?
            """,
            (
                cname,
                payload.display_name.strip(),
                json.dumps([a.strip().lower() for a in payload.aliases if a.strip()]),
                payload.default_department.strip(),
                payload.package_size,
                payload.package_unit.strip(),
                payload.package_label.strip(),
                1 if payload.is_pantry_staple else 0,
                cat_id,
            ),
        )
        row = conn.execute("SELECT * FROM product_catalog WHERE id = ?", (cat_id,)).fetchone()
    return _serialize_cat(row)


@router.delete("/{cat_id}")
def delete_catalog_item(cat_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("DELETE FROM product_catalog WHERE id = ?", (cat_id,))
    return {"ok": True}
