from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import STATIC_DIR
from app.database import init_db
from app.routers import (
    auth_router,
    catalog_router,
    ha_router,
    import_router,
    lists_router,
    pantry_router,
    planner_router,
    recipes_router,
    stores_router,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="PantryCart — Household Recipes & Smart Grocery Lists",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(auth_router.router)
app.include_router(recipes_router.router)
app.include_router(planner_router.router)
app.include_router(lists_router.router)
app.include_router(stores_router.router)
app.include_router(catalog_router.router)
app.include_router(pantry_router.router)
app.include_router(import_router.router)
app.include_router(ha_router.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/manifest.json")
def manifest():
    return FileResponse(str(STATIC_DIR / "manifest.json"), media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(str(STATIC_DIR / "sw.js"), media_type="application/javascript")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="API endpoint not found")
    return FileResponse(str(STATIC_DIR / "index.html"))
