"""FastAPI application factory: request guard, API routers, the PWA from dist-hoard/."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .api import ROUTERS
from .config import Config
from .guard import install_guard
from .hoard_link import family
from .resources import index_for
from .services import Services

log = logging.getLogger("hypatia")

try:  # Agent B's notebook; everything else works without it.
    from .notebook import init_schema, start_worker, stop_worker
except ImportError:  # pragma: no cover - depends on the checkout
    init_schema = start_worker = stop_worker = None
try:
    from .api.notebook import router as notebook_router
except ImportError:  # pragma: no cover
    notebook_router = None


def start_services(svc: Services) -> None:
    if init_schema is not None:
        with svc.db.lock:
            init_schema(svc.db.conn)
    if start_worker is not None:
        start_worker(svc)


def stop_services(svc: Services) -> None:
    if stop_worker is not None:
        try:
            stop_worker()
        except Exception:  # noqa: BLE001 - shutdown must finish
            log.exception("notebook worker did not stop cleanly")
    svc.stop()


def create_app(config: Config | None = None, services: Services | None = None) -> FastAPI:
    config = config or (services.config if services else Config.from_env())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc = services or Services(config)
        start_services(svc)
        app.state.services = svc
        log.info("Hypatia's Hoard %s — data in %s", __version__, config.data_dir)
        try:
            yield
        finally:
            stop_services(svc)

    app = FastAPI(title="Hypatia's Hoard", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.config = config
    # Hoard Link 0.4: this app on the family bus (agent.call events, the hoard_link block in /api/health).
    family.configure("hypatia", str(config.data_dir), token_file=str(config.token_path))

    install_guard(app, config.allowed_hosts)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        issues = "; ".join(f"{'.'.join(str(p) for p in e['loc'] if p != 'body') or 'input'}: {e['msg']}" for e in exc.errors())
        return JSONResponse({"error": issues}, status_code=400)

    for router in ROUTERS:
        app.include_router(router)
    if notebook_router is not None:
        app.include_router(notebook_router)

    dist = config.dist_dir

    # HEAD too: the PWA probes resources/<slug>/Temas/<pdf> with HEAD before listening to or viewing it.
    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(path: str, request: Request):
        if path == "api" or path.startswith("api/"):
            return JSONResponse({"error": "Not found."}, status_code=404)
        if path.startswith("resources/"):
            # The repo's resources/ (PDFs that exist on this PC even though git ignores them).
            base = config.resources_dir.resolve()
            target = (base / path[len("resources/"):]).resolve()
            if target.is_file() and base in target.parents:
                return FileResponse(target)
            listing = index_for(base, target)
            if listing is not None:
                return JSONResponse(listing, headers={"Cache-Control": "no-cache"})
            return JSONResponse({"error": "Not found."}, status_code=404)
        root = dist.resolve()
        candidate = (root / path).resolve() if path else None
        if candidate and candidate.is_file() and root in candidate.parents:
            headers = {"Cache-Control": "no-cache"} if candidate.name in ("sw.js", "index.html") else None
            return FileResponse(candidate, headers=headers)
        if path.startswith("question-images/") and "/" not in path[len("question-images/"):]:
            # Inline question images: Exam Coach looked in public/question-images/ first; here they
            # live on the server (synced from the app), so no device gets a 404 before its fallback.
            found = request.app.state.services.store.image(path[len("question-images/"):])
            if found is not None:
                return Response(content=found[1], media_type=found[0], headers={"Cache-Control": "no-cache"})
        if path.startswith("assets/") or Path(path).suffix.lower() not in ("", ".html"):
            # A missing bundle file (e.g. a chunk from an older build still referenced by a cached
            # page) must 404, not get index.html: a module script served as text/html fails confusingly.
            return JSONResponse({"error": "Not found."}, status_code=404)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return JSONResponse({"error": "The PWA is not built yet: run `npm install && npm run build:hoard`."}, status_code=503)

    return app
