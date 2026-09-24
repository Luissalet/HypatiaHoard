"""Tools exposed to the assistant. One list drives /api/agent/* and mcp_server.py."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Callable, Literal, Union

from pydantic import BaseModel, Field

from . import suggest
from .services import Services
from .store import normalize_text

AGENT_INSTRUCTIONS = """Hypatia's Hoard is the user's own flashcards, scheduled by the app (SM-2); the assistant is the author and, in chat, the examiner.
Add cards only from material the user actually has: a passage from their library, a saved page, something they just said. One fact per card, the back short, and always fill `source` so the card is traceable.
When the user asks for cards from what was said/discussed/a meeting/a transcript ("hazme tarjetas de lo que hablamos/de la reunión/de esta transcripción"): call cards_suggest (source kind "scribe" with a session_id or a since/until range, or kind "text" for pasted text), show the drafts to the user as proposed cards, and save with cards_suggest_accept (or cards_add) only the ones the user accepts — never add a draft the user did not approve. If cards_suggest comes back with `drafts: []` and a `material` field, no model was available to draft automatically: read `material` yourself, draft the cards following the same rules (one fact per card, short back, source filled), show them, and save only what the user accepts.
When quizzing: call cards_due, show only the front, wait for the user's actual answer, then compare it with the back yourself and call card_review once — with the front you showed (and the id) — with the grade that answer earns: again (0) if wrong, blank, "no me acuerdo" or about something else than the question (a true sentence about another topic is still wrong), hard (1) if partly right, good (2) if right, easy (3) only if instant and complete — and then say what the back said.
Never reveal the back before the user has answered. Never call card_review without a real answer from the user in this conversation. Never invent cards or grades. Never read the data folder or the database directly; use these tools only."""


class Empty(BaseModel):
    pass


class DeckArgs(BaseModel):
    deck: str | None = Field(None, max_length=200, description="Deck name or id; omit for every deck.")


class DeckCreateArgs(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=2000)


class CardIn(BaseModel):
    front: str = Field(..., min_length=1, max_length=4000, description="The question/prompt, markdown.")
    back: str = Field(..., min_length=1, max_length=8000, description="The answer, markdown, kept short.")
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field("", max_length=1000, description="Where this fact comes from, e.g. 'apuntes.pdf, p. 14'.")
    source_url: str = Field("", max_length=2000)


class CardsAddArgs(BaseModel):
    deck: str = Field(..., min_length=1, max_length=200, description="Deck name or id; a new name is created.")
    cards: list[CardIn] = Field(..., min_length=1, max_length=100)


class CardsDueArgs(BaseModel):
    deck: str | None = Field(None, max_length=200)
    limit: int = Field(10, ge=1, le=100)


class CardReviewArgs(BaseModel):
    id: int | None = Field(None, ge=1, description="The card's id, as returned by cards_due.")
    grade: int | str = Field(..., description="0 again (wrong, blank, or 'no me acuerdo'), 1 hard (partly right), 2 good (right), 3 easy (instant and complete); or the words again/hard/good/easy.")
    front: str | None = Field(None, max_length=4000, description="The front you showed the user. Give it always: alone it identifies the card; with an id that belongs to another card the call is refused.")
    deck: str | None = Field(None, max_length=200, description="Deck name or id, to disambiguate a front that exists in several decks.")
    elapsed_ms: int | None = Field(None, ge=0, le=3_600_000)


class CardsSearchArgs(BaseModel):
    q: str = Field(..., min_length=1, max_length=500)
    deck: str | None = Field(None, max_length=200)
    tag: str | None = Field(None, max_length=100)
    state: str | None = Field(None, pattern="^(new|learning|review|lapsed)$")
    limit: int = Field(20, ge=1, le=100)


class CardUpdateArgs(BaseModel):
    id: int = Field(..., ge=1)
    front: str | None = Field(None, min_length=1, max_length=4000)
    back: str | None = Field(None, min_length=1, max_length=8000)
    tags: list[str] | None = Field(None, max_length=30)
    source: str | None = Field(None, max_length=1000)
    deck: str | None = Field(None, max_length=200)
    suspended: bool | None = None


class CardDeleteArgs(BaseModel):
    id: int = Field(..., ge=1)


class CardsExportArgs(BaseModel):
    deck: str = Field(..., min_length=1, max_length=200)


class TextSource(BaseModel):
    kind: Literal["text"]
    text: str = Field(..., min_length=1, max_length=200_000, description="Pasted passage/page to draft cards from.")


class ScribeSource(BaseModel):
    kind: Literal["scribe"]
    session_id: str | None = Field(None, max_length=64, description="One Scribe session; takes priority over since/until.")
    since: str | None = Field(None, max_length=100, description="Start of the range (Scribe's own date words, e.g. 'ayer', 'esta semana', or ISO).")
    until: str | None = Field(None, max_length=100, description="End of the range.")


Source = Annotated[Union[TextSource, ScribeSource], Field(discriminator="kind")]


class CardsSuggestArgs(BaseModel):
    source: Source
    deck: str = Field(..., min_length=1, max_length=200, description="Deck the drafts would go into (not created until accepted).")
    max_cards: int = Field(12, ge=1, le=40)
    language: Literal["es", "en", "auto"] = "auto"


class DraftIn(BaseModel):
    front: str = Field(..., min_length=1, max_length=4000)
    back: str = Field(..., min_length=1, max_length=8000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field("", max_length=1000)
    source_url: str = Field("", max_length=2000)


class CardsSuggestAcceptArgs(BaseModel):
    deck: str = Field(..., min_length=1, max_length=200, description="Deck name or id; a new name is created.")
    drafts: list[DraftIn] = Field(..., min_length=1, max_length=100, description="The drafts the user accepted, front/back as shown (edited or not).")


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_model: type[BaseModel]
    annotations: dict[str, bool]
    run: Callable[[Services, Any], Any]


def _resolve_deck_id(services: Services, deck: str | None) -> int | None:
    if deck is None or str(deck).strip() == "":
        return None
    found, _created = services.decks.resolve(deck, services.now())
    return found.id


def run_decks_list(services: Services, _: Empty) -> dict:
    counts = services.decks.counts()
    out = []
    for d in services.decks.list():
        c = counts.get(d.id, {})
        out.append({**d.to_dict(), "cards": c.get("cards") or 0, "new": c.get("new") or 0,
                    "due_now": c.get("due") or 0, "suspended": c.get("suspended") or 0})
    return {"decks": out}


def run_deck_create(services: Services, args: DeckCreateArgs) -> dict:
    deck, created = services.add_deck(args.name, args.description)
    return {"deck": deck.to_dict(), "existing": not created}


def run_cards_add(services: Services, args: CardsAddArgs) -> dict:
    now = services.now()
    deck, _created = services.decks.resolve(args.deck, now)
    results = []
    for item in args.cards:
        card, existing = services.cards.add_or_update(deck.id, item.front, item.back, item.tags, item.source,
                                                        item.source_url, now)
        results.append({"id": card["id"], "existing": existing})
    return {"deck": deck.to_dict(), "cards": results, "count": len(results)}


def run_cards_due(services: Services, args: CardsDueArgs) -> dict:
    deck_id = _resolve_deck_id(services, args.deck) if args.deck else None
    queue = services.review_queue(deck_id, args.limit)
    keys = ("id", "deck_id", "front", "back", "tags", "source", "state", "times_seen")
    return {"queue": [{k: c[k] for k in keys} for c in queue], "count": len(queue)}


def run_card_review(services: Services, args: CardReviewArgs) -> dict:
    if args.id is None and not (args.front or "").strip():
        raise ValueError("card_review needs the card's id or its front.")
    deck_id = _resolve_deck_id(services, args.deck) if args.deck else None
    by_front = services.cards.find_by_front(args.front, deck_id) if (args.front or "").strip() else None
    if args.id is None:
        # The front alone names the card: a local model quizzing the user
        # kept passing the ordinal ("tarjeta 1") as the id.
        if by_front is None:
            raise LookupError(f"No card has the front «{args.front}».")
        return services.review_card(by_front["id"], args.grade, args.elapsed_ms)
    card = services.cards.get(args.id)
    if card is None:
        if by_front is not None:
            return services.review_card(by_front["id"], args.grade, args.elapsed_ms)
        raise LookupError(f"Card {args.id} does not exist.")
    if args.front and normalize_text(args.front) != normalize_text(card["front"]):
        # The id and the front disagree: the front is what the user saw, so
        # it wins when it names exactly one card; otherwise nothing is
        # recorded and the caller learns which card that front belongs to.
        if by_front is not None:
            return services.review_card(by_front["id"], args.grade, args.elapsed_ms)
        raise ValueError(f"Card {args.id} is «{card['front']}», not «{args.front}»; no grade recorded.")
    return services.review_card(args.id, args.grade, args.elapsed_ms)


def run_cards_search(services: Services, args: CardsSearchArgs) -> dict:
    deck_id = _resolve_deck_id(services, args.deck) if args.deck else None
    hits = services.search.search(args.q, deck_id, args.tag, args.state, args.limit)
    return {"query": args.q, "hits": hits, "count": len(hits)}


def run_card_update(services: Services, args: CardUpdateArgs) -> dict:
    if services.cards.get(args.id) is None:
        raise LookupError(f"Card {args.id} does not exist.")
    patch = args.model_dump(exclude={"id"}, exclude_unset=True)
    if "deck" in patch:
        deck, _created = services.decks.resolve(patch.pop("deck"), services.now())
        patch["deck_id"] = deck.id
    return services.cards.update(args.id, patch, services.now())


def run_card_delete(services: Services, args: CardDeleteArgs) -> dict:
    if not services.cards.remove(args.id):
        raise LookupError(f"Card {args.id} does not exist.")
    return {"ok": True, "id": args.id}


def run_cards_stats(services: Services, args: DeckArgs) -> dict:
    deck_id = _resolve_deck_id(services, args.deck) if args.deck else None
    return services.stats.deck_stats(deck_id, services.now())


def run_cards_export(services: Services, args: CardsExportArgs) -> dict:
    from .importer import export_deck

    deck, _created = services.decks.resolve(args.deck, services.now())
    return {"deck": deck.to_dict(), "cards": export_deck(services.cards, deck.id)}


def run_cards_suggest(services: Services, args: CardsSuggestArgs) -> dict:
    try:
        return suggest.suggest_cards(services, args.source.model_dump(), args.deck, args.max_cards, args.language)
    except suggest.SuggestInputError as error:
        raise ValueError(str(error)) from error


def run_cards_suggest_accept(services: Services, args: CardsSuggestAcceptArgs) -> dict:
    return run_cards_add(services, CardsAddArgs(deck=args.deck, cards=[CardIn(**d.model_dump()) for d in args.drafts]))


def _ann(read_only: bool, destructive: bool = False, idempotent: bool | None = None) -> dict[str, bool]:
    return {"readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": read_only if idempotent is None else idempotent, "openWorldHint": False}


TOOLS: list[Tool] = [
    Tool("decks_list", "List the user's decks with card counts and how many are due right now.\nSinónimos: mazos, barajas, listar mazos, cuántas tarjetas, cuántas pendientes.", Empty, _ann(True), run_decks_list),
    Tool("deck_create", "Create a deck (write). Idempotent on name: creating an existing name returns it unchanged.\nSinónimos: crear mazo, nuevo mazo, nueva baraja, añadir mazo.", DeckCreateArgs, _ann(False, False, True), run_deck_create),
    Tool("cards_add", "Add one or more flashcards to a deck (write, deck created if it does not exist yet; up to 100 cards). Idempotent per deck on the normalised front: an existing front updates back/tags/source and comes back as `existing: true`. Write the front so it has ONE unambiguous answer, keep the back short, and always fill `source` (e.g. 'apuntes.pdf, p. 14' or a URL).\nSinónimos: añadir tarjeta, crear tarjeta, nueva tarjeta, apuntar, memorizar esto, ficha, flashcard.", CardsAddArgs, _ann(False, False, True), run_cards_add),
    Tool("cards_due", "The cards due for review right now (front, back, tags, source, state, times seen). This is what the assistant uses to quiz the user in chat: show only the front, never the back, until the user has answered.\nSinónimos: repasar, tarjetas pendientes, quiz, examíname, pregúntame, hoy toca repasar.", CardsDueArgs, _ann(True), run_cards_due),
    Tool("card_review", "Grade one card the user just answered in chat (write): 0 again (wrong, blank or 'no me acuerdo'), 1 hard (partly right), 2 good (right), 3 easy (instant and complete). Pass the front you showed (and the id if you have it): the front is what the user saw, so it decides which card is graded; a front that matches no card is refused. Call it exactly once per real answer the user gave; never grade on the user's behalf or guess. Returns the new schedule and the next due card in the same deck.\nSinónimos: calificar, he acertado, he fallado, lo sabía, no lo sabía, siguiente tarjeta.", CardReviewArgs, _ann(False, False, True), run_card_review),
    Tool("cards_search", "Full-text search over the user's cards (front, back, tags, source), diacritics-insensitive.\nSinónimos: buscar tarjeta, dónde tengo esto, busca en mis tarjetas.", CardsSearchArgs, _ann(True), run_cards_search),
    Tool("card_update", "Edit a card's front/back/tags/source/deck/suspended (write). Only given fields change.\nSinónimos: editar tarjeta, corregir, cambiar mazo, suspender tarjeta.", CardUpdateArgs, _ann(False, False, True), run_card_update),
    Tool("card_delete", "Permanently delete a card (write, destructive).\nSinónimos: borrar tarjeta, eliminar tarjeta, quitar ficha.", CardDeleteArgs, _ann(False, True, True), run_card_delete),
    Tool("cards_stats", "Study statistics: counts by state, due now, reviewed today, 30-day retention, streak, 7-day forecast.\nSinónimos: estadísticas, cuánto llevo, racha, retención, progreso.", DeckArgs, _ann(True), run_cards_stats),
    Tool("cards_export", "Export every card of a deck as JSON, with its scheduling fields, for the user to keep or move to another machine.\nSinónimos: exportar mazo, descargar tarjetas, copia de seguridad.", CardsExportArgs, _ann(True), run_cards_export),
    Tool("cards_suggest", "Draft flashcards (proposal, nothing saved) from pasted text or a Scribe's Hoard transcript, with a local model. Returns `drafts` to show the user, or (no model available) `material` for the assistant to draft from itself.\nSinónimos: sugerir tarjetas, tarjetas de la reunión, tarjetas de lo que hablamos, tarjetas de la transcripción, propón tarjetas.", CardsSuggestArgs, _ann(False, False, False), run_cards_suggest),
    Tool("cards_suggest_accept", "Save the drafts the user accepted from cards_suggest (write, same effect as cards_add).\nSinónimos: acepta las tarjetas, guarda las sugeridas, añade las que acepté.", CardsSuggestAcceptArgs, _ann(False, False, True), run_cards_suggest_accept),
]

TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


def tool_catalog() -> list[dict]:
    return [
        {"name": t.name, "description": t.description, "annotations": t.annotations, "inputSchema": t.input_model.model_json_schema(by_alias=True)}
        for t in TOOLS
    ]


def call_tool(services: Services, name: str, arguments: dict | None) -> Any:
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise KeyError(f"Unknown tool: {name}")
    args = tool.input_model.model_validate(arguments or {})
    return tool.run(services, args)
