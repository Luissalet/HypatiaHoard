"""`cards_suggest`: draft flashcards from material the user actually has
(pasted text, or a Scribe's Hoard transcript) with a local model, for the
assistant to show the user before anything is saved.

Never calls `cards.add_or_update` itself -- drafting is a proposal step;
only `cards_suggest_accept` (or a plain `cards_add`) persists anything.
"""

from __future__ import annotations

import json
import re
from typing import Any

from . import backend
from .hoard_link import BackendError, Unavailable
from .scribe_client import ScribeClient, ScribeUnavailable

# Cap on the material handed to the model: local models have a limited
# context window, and this keeps the prompt (and, on the fallback path,
# the chunk handed back to the assistant) a predictable size.
MAX_MATERIAL_CHARS = 20_000
# Cap on how much of a Scribe time range is pulled across several sessions
# before drafting stops adding more (a session is never cut mid-way).
MAX_SCRIBE_SESSIONS = 8

_FRONT_MAX = 4000
_BACK_MAX = 8000
_SOURCE_MAX = 1000

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


class SuggestInputError(ValueError):
    """The `source` given to `cards_suggest` cannot be resolved to material."""


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    text = text.strip()
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip(), True


def _material_from_text(text: str) -> tuple[str, str, bool]:
    material, truncated = _truncate(text, MAX_MATERIAL_CHARS)
    return material, "pasted text", truncated


def _material_from_scribe(client: ScribeClient, session_id: str | None, since: str | None,
                           until: str | None) -> tuple[str, str, bool]:
    if session_id:
        try:
            transcript, meta = client.full_transcript(session_id, max_total_chars=MAX_MATERIAL_CHARS)
        except ScribeUnavailable as error:
            raise SuggestInputError(str(error)) from error
        if not transcript.strip():
            raise SuggestInputError(f"Session {session_id} has no transcribed speech yet.")
        title = meta.get("title") or session_id
        return transcript, f"Scribe session '{title}' ({session_id})", len(transcript) >= MAX_MATERIAL_CHARS

    if not (since or until):
        raise SuggestInputError("A Scribe source needs either session_id, or since/until.")
    try:
        listing = client.sessions(from_=since, to=until, limit=MAX_SCRIBE_SESSIONS)
    except ScribeUnavailable as error:
        raise SuggestInputError(str(error)) from error
    rows = listing.get("sessions") or []
    if not rows:
        raise SuggestInputError("No Scribe sessions were found in that range.")
    pieces: list[str] = []
    titles: list[str] = []
    used = 0
    truncated = False
    for row in rows:
        remaining = MAX_MATERIAL_CHARS - used
        if remaining <= 0:
            truncated = True
            break
        try:
            transcript, meta = client.full_transcript(row["id"], max_total_chars=remaining)
        except ScribeUnavailable as error:
            raise SuggestInputError(str(error)) from error
        if not transcript.strip():
            continue
        title = meta.get("title") or row["id"]
        titles.append(title)
        header = f"## {title} ({row.get('started_at', '')})\n"
        pieces.append(header + transcript)
        used += len(header) + len(transcript)
    material = "\n\n".join(pieces)
    if not material.strip():
        raise SuggestInputError("No Scribe session in that range has transcribed speech yet.")
    source_label = "Scribe sessions: " + ", ".join(titles)
    return material, source_label, truncated


def gather_material(source: dict[str, Any], scribe_client: ScribeClient | None = None) -> tuple[str, str, bool]:
    """Returns (material, default_source_label, was_truncated)."""
    kind = source.get("kind")
    if kind == "text":
        return _material_from_text(source.get("text", ""))
    if kind == "scribe":
        client = scribe_client or ScribeClient()
        return _material_from_scribe(client, source.get("session_id"), source.get("since"), source.get("until"))
    raise SuggestInputError(f"Unknown source kind: {kind!r}")


def _strip_fences(text: str) -> str:
    return _FENCE_RE.sub("", text.strip())


def parse_drafts(raw_text: str) -> list[dict[str, str]] | None:
    """Best-effort parse of the model's reply into a list of draft dicts.
    Returns None (never []) when the reply cannot be understood at all, so
    the caller can tell "the model said there is nothing" from "the model
    did not answer in the shape we asked for"."""
    text = _strip_fences(raw_text)
    if not text:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except ValueError:
            return None
    if isinstance(data, dict):
        data = data.get("cards") or data.get("drafts") or []
    if not isinstance(data, list):
        return None
    drafts: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        front = str(item.get("front") or "").strip()
        back = str(item.get("back") or "").strip()
        if not front or not back:
            continue
        source = str(item.get("source") or "").strip()
        drafts.append({
            "front": front[:_FRONT_MAX],
            "back": back[:_BACK_MAX],
            "source": source[:_SOURCE_MAX],
        })
    return drafts


def suggest_cards(services, source: dict[str, Any], deck: str, max_cards: int, language: str,
                   scribe_client: ScribeClient | None = None) -> dict[str, Any]:
    if source.get("kind") == "scribe" and scribe_client is None:
        scribe_client = services.make_scribe_client()
    material, default_source, truncated = gather_material(source, scribe_client)

    fallback_note = (
        "No source-appropriate cards could be drafted automatically; draft them yourself from `material` "
        "(one fact per card, short back, front a question, and fill `source`), then save the ones the user "
        "accepts with cards_add or cards_suggest_accept."
    )

    try:
        result = services.link_chat(
            backend.build_suggest_messages(material, language, max_cards),
            capability="llm", max_tokens=backend.SUGGEST_MAX_TOKENS, temperature=0.2,
        )
    except Unavailable as error:
        return {"deck": deck, "drafts": [], "material": material,
                "note": f"No language model is available to draft cards ({'; '.join(error.reasons)}). {fallback_note}",
                "model": None, "truncated": truncated}
    except BackendError as error:
        return {"deck": deck, "drafts": [], "material": material,
                "note": f"The drafting model call failed ({error}). {fallback_note}",
                "model": None, "truncated": truncated}

    drafts = parse_drafts(result.text)
    if drafts is None:
        return {"deck": deck, "drafts": [], "material": material,
                "note": f"The model ({result.model or 'unknown model'}) did not reply with the expected JSON. {fallback_note}",
                "model": result.model, "truncated": truncated}

    for draft in drafts:
        if not draft["source"]:
            draft["source"] = default_source
        draft["tags"] = []
    drafts = drafts[:max_cards]

    note = None
    if not drafts:
        note = "The model found no fact worth a card in this material."
    elif truncated:
        note = "The material was longer than the drafting budget; only its first part was used."

    return {"deck": deck, "drafts": drafts, "material": None, "note": note, "model": result.model,
            "truncated": truncated}
