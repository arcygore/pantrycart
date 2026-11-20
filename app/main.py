import hashlib
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import STATIC_DIR
from app.database import init_db
from app.routers import (
    auth_router,
    catalog_router,
    ha_router,
    import_router,
    kroger_router,
    lists_router,
    nutrition_router,
    pantry_router,
    planner_router,
    recipes_router,
    stores_router,
)

APP_VERSION = "1.5.0"


def _compute_build_id() -> str:
    h = hashlib.sha256()
    if STATIC_DIR.exists():
        for path in sorted(STATIC_DIR.rglob("*")):
            if path.is_file():
                h.update(str(path.relative_to(STATIC_DIR)).encode())
                h.update(path.read_bytes())
    return h.hexdigest()[:8]


APP_BUILD_ID = _compute_build_id()
_JS_IMPORT_RE = re.compile(r'((?:from|import)\s+["\'](?:\./|\.\./)[^"\']+\.js)(["\'])')


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="PantryCart — Household Recipes & Smart Grocery Lists",
    version=APP_VERSION,
    lifespan=lifespan,
)


@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    content_type = response.headers.get("content-type", "")
    if (
        path.startswith("/static/")
        or path in ("/", "/sw.js", "/manifest.json")
        or "text/html" in content_type
        or not path.startswith("/api/")
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        response.headers["CDN-Cache-Control"] = "no-store"
        response.headers["Cloudflare-CDN-Cache-Control"] = "no-store"
    return response


app.include_router(auth_router.router)
app.include_router(recipes_router.router)
app.include_router(planner_router.router)
app.include_router(lists_router.router)
app.include_router(stores_router.router)
app.include_router(catalog_router.router)
app.include_router(pantry_router.router)
app.include_router(import_router.router)
app.include_router(ha_router.router)
app.include_router(nutrition_router.router)
app.include_router(kroger_router.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "version": APP_VERSION, "build_id": APP_BUILD_ID}


@app.get("/static/js/{js_path:path}")
def serve_versioned_js(js_path: str):
    js_root = (STATIC_DIR / "js").resolve()
    target = (js_root / js_path).resolve()
    if not target.is_relative_to(js_root) or not target.is_file() or target.suffix != ".js":
        raise HTTPException(status_code=404, detail="JavaScript file not found")
    source = target.read_text(encoding="utf-8")
    versioned = _JS_IMPORT_RE.sub(rf"\1?v={APP_BUILD_ID}\2", source)
    return Response(content=versioned, media_type="application/javascript")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/manifest.json")
def manifest():
    return FileResponse(str(STATIC_DIR / "manifest.json"), media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    sw_content = (STATIC_DIR / "sw.js").read_text(encoding="utf-8").replace("__BUILD_ID__", APP_BUILD_ID)
    return Response(content=sw_content, media_type="application/javascript")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="API endpoint not found")
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("/static/css/styles.css", f"/static/css/styles.css?v={APP_BUILD_ID}")
    html = html.replace("/static/css/planner.css", f"/static/css/planner.css?v={APP_BUILD_ID}")
    html = html.replace("/static/css/recipes.css", f"/static/css/recipes.css?v={APP_BUILD_ID}")
    html = html.replace("/static/js/app.js", f"/static/js/app.js?v={APP_BUILD_ID}")
    html = html.replace("</head>", f'  <script>window.__PANTRYCART_BUILD__ = "{APP_BUILD_ID}";</script>\n</head>')
    return HTMLResponse(content=html)
