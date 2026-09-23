"""Full-text search over cards."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from .deps import services

router = APIRouter(prefix="/api")


@router.get("/search")
def search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=500),
    deck: int | None = Query(None, ge=1),
    tag: str | None = Query(None),
    state: str | None = Query(None, pattern="^(new|learning|review|lapsed)$"),
    limit: int = Query(20, ge=1, le=100),
):
    hits = services(request).search.search(q, deck, tag, state, limit)
    return {"query": q, "hits": hits, "count": len(hits)}
