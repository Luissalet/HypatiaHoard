"""Cards: list/filter, create (single or list), update, delete, suspend."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, RootModel

from .deps import services

router = APIRouter(prefix="/api/cards")


class CardCreate(BaseModel):
    deck: str | int = Field(..., description="Deck name or id; a new name is created.")
    front: str = Field(..., min_length=1, max_length=4000)
    back: str = Field(..., min_length=1, max_length=8000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field("", max_length=1000)
    source_url: str = Field("", max_length=2000)


CardsIn = RootModel[CardCreate | list[CardCreate]]


class CardPatch(BaseModel):
    front: str | None = Field(None, min_length=1, max_length=4000)
    back: str | None = Field(None, min_length=1, max_length=8000)
    tags: list[str] | None = Field(None, max_length=30)
    source: str | None = Field(None, max_length=1000)
    source_url: str | None = Field(None, max_length=2000)
    deck: str | int | None = None
    suspended: bool | None = None


@router.get("")
def list_cards(
    request: Request,
    deck: int | None = Query(None, ge=1),
    tag: str | None = Query(None),
    state: str | None = Query(None, pattern="^(new|learning|review|lapsed)$"),
    q: str = Query("", max_length=200),
    due: int | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    svc = services(request)
    due_before = svc.now() if due else None
    cards = svc.cards.list(deck_id=deck, tag=tag, state=state, q=q.strip() or None, due_before=due_before,
                            limit=limit, offset=offset)
    return {"cards": cards, "count": len(cards)}


@router.post("", status_code=201)
def add_cards(request: Request, body: CardsIn):
    svc = services(request)
    items = body.root if isinstance(body.root, list) else [body.root]
    if not items:
        raise HTTPException(400, "No cards given.")
    if len(items) > 200:
        raise HTTPException(400, "At most 200 cards per request.")
    results = []
    now = svc.now()
    for item in items:
        try:
            deck, _created = svc.decks.resolve(item.deck, now)
        except (LookupError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        card, existing = svc.cards.add_or_update(deck.id, item.front, item.back, item.tags, item.source,
                                                   item.source_url, now)
        results.append({**card, "existing": existing})
    return results[0] if not isinstance(body.root, list) else {"cards": results}


@router.get("/{card_id}")
def get_card(request: Request, card_id: int):
    card = services(request).cards.get(card_id)
    if card is None:
        raise HTTPException(404, "Card not found.")
    return card


@router.patch("/{card_id}")
def patch_card(request: Request, card_id: int, body: CardPatch):
    svc = services(request)
    if svc.cards.get(card_id) is None:
        raise HTTPException(404, "Card not found.")
    patch = body.model_dump(exclude_unset=True)
    if "deck" in patch:
        try:
            deck, _created = svc.decks.resolve(patch.pop("deck"), svc.now())
        except (LookupError, ValueError) as error:
            raise HTTPException(400, str(error)) from error
        patch["deck_id"] = deck.id
    return svc.cards.update(card_id, patch, svc.now())


@router.delete("/{card_id}")
def delete_card(request: Request, card_id: int):
    if not services(request).cards.remove(card_id):
        raise HTTPException(404, "Card not found.")
    return {"ok": True}


@router.post("/{card_id}/suspend")
def suspend_card(request: Request, card_id: int):
    svc = services(request)
    if svc.cards.get(card_id) is None:
        raise HTTPException(404, "Card not found.")
    return svc.cards.set_suspended(card_id, True, svc.now())


@router.post("/{card_id}/unsuspend")
def unsuspend_card(request: Request, card_id: int):
    svc = services(request)
    if svc.cards.get(card_id) is None:
        raise HTTPException(404, "Card not found.")
    return svc.cards.set_suspended(card_id, False, svc.now())
