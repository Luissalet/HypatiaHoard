"""Statistics: per-deck or total."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from .deps import services

router = APIRouter(prefix="/api")


@router.get("/stats")
def stats(request: Request, deck: int | None = Query(None, ge=1)):
    svc = services(request)
    if deck is not None and svc.decks.get(deck) is None:
        raise HTTPException(404, "Deck not found.")
    return svc.stats.deck_stats(deck, svc.now())
