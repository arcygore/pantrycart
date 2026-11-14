from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import verify_api_key_or_user
from app.database import get_db
from app.routers.lists_router import AddListItemPayload, add_item_to_list_internal, build_list_response

router = APIRouter(prefix="/api/ha", tags=["home-assistant"])


class HALowStockPayload(BaseModel):
    item: str = Field(min_length=1, max_length=200)
    quantity: Optional[float] = 1.0
    unit: str = ""
    list_id: Optional[int] = None
    list_type: str = "weekly"
    store_name: str = ""
    notes: str = "Added by Home Assistant"


@router.get("/lists")
def ha_get_lists(actor: dict = Depends(verify_api_key_or_user)):
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT sl.id, sl.name, sl.list_type, sl.updated_at,
                   SUM(CASE WHEN sli.checked = 0 THEN 1 ELSE 0 END) AS unchecked_count
            FROM shopping_lists sl
            LEFT JOIN shopping_list_items sli ON sli.list_id = sl.id
            WHERE sl.is_archived = 0
            GROUP BY sl.id
            ORDER BY sl.id ASC
            """
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "list_type": r["list_type"],
            "unchecked_count": r["unchecked_count"] or 0,
            "updated_at": r["updated_at"],
        }
        for r in rows
    ]


@router.get("/lists/{list_id}")
def ha_get_list_detail(list_id: int, actor: dict = Depends(verify_api_key_or_user)):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (list_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="List not found")
        return build_list_response(conn, row)


@router.post("/low-stock")
def ha_low_stock_webhook(payload: HALowStockPayload, actor: dict = Depends(verify_api_key_or_user)):
    """
    Endpoint for Home Assistant automations (e.g., ESPHome weight sensor or RFID tag scan).
    Finds the target shopping list (by list_id, store_name, or list_type='weekly') and adds the item.
    """
    with get_db() as conn:
        target_list = None
        if payload.list_id:
            target_list = conn.execute("SELECT * FROM shopping_lists WHERE id = ?", (payload.list_id,)).fetchone()
        elif payload.store_name.strip():
            target_list = conn.execute(
                """
                SELECT sl.* FROM shopping_lists sl
                JOIN stores s ON s.id = sl.store_id
                WHERE sl.is_archived = 0 AND LOWER(s.name) = LOWER(?)
                LIMIT 1
                """,
                (payload.store_name.strip(),),
            ).fetchone()
        if not target_list:
            target_list = conn.execute(
                "SELECT * FROM shopping_lists WHERE is_archived = 0 AND list_type = ? ORDER BY id ASC LIMIT 1",
                (payload.list_type,),
            ).fetchone()
        if not target_list:
            target_list = conn.execute(
                "SELECT * FROM shopping_lists WHERE is_archived = 0 ORDER BY id ASC LIMIT 1"
            ).fetchone()
        if not target_list:
            raise HTTPException(status_code=404, detail="No active shopping list found")

        item_payload = AddListItemPayload(
            name=payload.item,
            buy_qty=payload.quantity,
            buy_unit=payload.unit,
            notes=payload.notes,
        )
        updated = add_item_to_list_internal(conn, target_list["id"], item_payload, actor.get("id"))
    return {
        "ok": True,
        "list_id": updated["id"],
        "list_name": updated["name"],
        "unchecked_count": updated["unchecked_count"],
    }
