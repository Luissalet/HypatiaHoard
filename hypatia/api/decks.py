"""Decks CRUD plus per-deck import/export."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from ..importer import export_deck, import_cards, parse_rows
from .deps import services

router = APIRouter(prefix="/api/decks")


class DeckIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    new_per_day: int = Field(20, ge=0, le=1000)


class DeckPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)
    new_per_day: int | None = Field(None, ge=0, le=1000)


def _with_counts(svc, deck) -> dict:
    counts = svc.decks.counts().get(deck.id, {})
    data = deck.to_dict()
    data["cards"] = counts.get("cards") or 0
    data["new"] = counts.get("new") or 0
    data["learning"] = counts.get("learning") or 0
    data["review"] = counts.get("review") or 0
    data["lapsed"] = counts.get("lapsed") or 0
    data["suspended"] = counts.get("suspended") or 0
    data["due"] = counts.get("due") or 0
    return data


@router.get("")
def list_decks(request: Request):
    svc = services(request)
    return {"decks": [_with_counts(svc, d) for d in svc.decks.list()]}


@router.post("", status_code=201)
def add_deck(request: Request, body: DeckIn):
    svc = services(request)
    try:
        deck, _created = svc.add_deck(body.name, body.description, body.new_per_day)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return _with_counts(svc, deck)


@router.get("/{deck_id}")
def get_deck(request: Request, deck_id: int):
    svc = services(request)
    deck = svc.decks.get(deck_id)
    if deck is None:
        raise HTTPException(404, "Deck not found.")
    return _with_counts(svc, deck)


@router.patch("/{deck_id}")
def patch_deck(request: Request, deck_id: int, body: DeckPatch):
    svc = services(request)
    if svc.decks.get(deck_id) is None:
        raise HTTPException(404, "Deck not found.")
    try:
        deck = svc.decks.update(deck_id, body.model_dump())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return _with_counts(svc, deck)


@router.delete("/{deck_id}")
def delete_deck(request: Request, deck_id: int, with_cards: int = Query(0, alias="with_cards")):
    svc = services(request)
    if svc.decks.get(deck_id) is None:
        raise HTTPException(404, "Deck not found.")
    try:
        svc.remove_deck(deck_id, bool(with_cards))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    return {"ok": True}


@router.post("/{deck_id}/import")
async def import_deck(request: Request, deck_id: int):
    svc = services(request)
    if svc.decks.get(deck_id) is None:
        raise HTTPException(404, "Deck not found.")
    body = (await request.body()).decode("utf-8")
    try:
        rows = parse_rows(body)
        result = import_cards(svc.cards, deck_id, rows, svc.now())
    except (ValueError, KeyError) as error:
        raise HTTPException(400, str(error)) from error
    return result


@router.get("/{deck_id}/export")
def export_deck_route(request: Request, deck_id: int):
    svc = services(request)
    if svc.decks.get(deck_id) is None:
        raise HTTPException(404, "Deck not found.")
    return Response(content=_json_dumps(export_deck(svc.cards, deck_id)), media_type="application/json")


def _json_dumps(data) -> str:
    import json

    return json.dumps(data, ensure_ascii=False, indent=2)
