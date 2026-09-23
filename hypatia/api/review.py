"""The review session: the due queue (front only, never the back) and grading."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .deps import services

router = APIRouter(prefix="/api/review")


class ReviewIn(BaseModel):
    grade: int | str = Field(..., description="0/1/2/3 or again/hard/good/easy.")
    elapsed_ms: int | None = Field(None, ge=0, le=3_600_000)


def _front_only(card: dict) -> dict:
    return {"id": card["id"], "deck_id": card["deck_id"], "front": card["front"], "tags": card["tags"],
            "source": card["source"], "state": card["state"]}


@router.get("/queue")
def review_queue(request: Request, deck: int | None = Query(None, ge=1), limit: int = Query(20, ge=1, le=200)):
    svc = services(request)
    if deck is not None and svc.decks.get(deck) is None:
        raise HTTPException(404, "Deck not found.")
    queue = svc.review_queue(deck, limit)
    return {"queue": [_front_only(c) for c in queue], "count": len(queue)}


@router.post("/{card_id}")
def review_card(request: Request, card_id: int, body: ReviewIn):
    svc = services(request)
    if svc.cards.get(card_id) is None:
        raise HTTPException(404, "Card not found.")
    try:
        result = svc.review_card(card_id, body.grade, body.elapsed_ms)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return result
