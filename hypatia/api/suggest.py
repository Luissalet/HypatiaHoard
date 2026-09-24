"""`cards_suggest` for the browser UI: draft cards from pasted text or a
Scribe session, list Scribe sessions to pick from, and save accepted drafts.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import suggest
from ..scribe_client import ScribeClient, ScribeUnavailable
from .deps import services

router = APIRouter(prefix="/api/suggest")


class TextSourceIn(BaseModel):
    kind: Literal["text"]
    text: str = Field(..., min_length=1, max_length=200_000)


class ScribeSourceIn(BaseModel):
    kind: Literal["scribe"]
    session_id: str | None = Field(None, max_length=64)
    since: str | None = Field(None, max_length=100)
    until: str | None = Field(None, max_length=100)


SourceIn = Annotated[Union[TextSourceIn, ScribeSourceIn], Field(discriminator="kind")]


class SuggestIn(BaseModel):
    source: SourceIn
    deck: str = Field(..., min_length=1, max_length=200)
    max_cards: int = Field(12, ge=1, le=40)
    language: Literal["es", "en", "auto"] = "auto"


class DraftIn(BaseModel):
    front: str = Field(..., min_length=1, max_length=4000)
    back: str = Field(..., min_length=1, max_length=8000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field("", max_length=1000)
    source_url: str = Field("", max_length=2000)


class SuggestAcceptIn(BaseModel):
    deck: str = Field(..., min_length=1, max_length=200)
    drafts: list[DraftIn] = Field(..., min_length=1, max_length=100)


@router.post("")
def draft(request: Request, body: SuggestIn):
    svc = services(request)
    try:
        return suggest.suggest_cards(svc, body.source.model_dump(), body.deck, body.max_cards, body.language)
    except suggest.SuggestInputError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/scribe/sessions")
def scribe_sessions(q: str | None = Query(None), kind: str | None = Query(None), since: str | None = Query(None),
                     until: str | None = Query(None), limit: int = Query(20, ge=1, le=100)):
    client = ScribeClient()
    try:
        listing = client.sessions(q=q, kind=kind, from_=since, to=until, limit=limit)
    except ScribeUnavailable as error:
        return {"reachable": False, "reason": str(error), "sessions": []}
    return {"reachable": True, "reason": None, "sessions": listing.get("sessions", [])}


@router.post("/accept")
def accept(request: Request, body: SuggestAcceptIn):
    svc = services(request)
    now = svc.now()
    try:
        deck, _created = svc.decks.resolve(body.deck, now)
    except (LookupError, ValueError) as error:
        raise HTTPException(400, str(error)) from error
    results = []
    for item in body.drafts:
        card, existing = svc.cards.add_or_update(deck.id, item.front, item.back, item.tags, item.source,
                                                   item.source_url, now)
        results.append({**card, "existing": existing})
    return {"deck": deck.to_dict(), "cards": results, "count": len(results)}
