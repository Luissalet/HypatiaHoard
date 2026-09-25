"""`questions_suggest`: draft exam questions (ExtractedQuestion shape, see
src/services/aiEngine.ts) from pasted text, a Scribe's Hoard transcript or the
subject's indexed notebook sources, with a local model. Nothing is saved here:
`questions_suggest_accept` persists the drafts the user accepted.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from . import ai, backend, bank
from .hashing import normalize_text, slugify
from .scribe_client import ScribeClient, ScribeUnavailable

MAX_MATERIAL_CHARS = 20_000
MAX_SCRIBE_SESSIONS = 8


class SuggestInputError(ValueError):
    """The source cannot be turned into material."""


def _truncate(text: str) -> tuple[str, bool]:
    text = text.strip()
    return (text, False) if len(text) <= MAX_MATERIAL_CHARS else (text[:MAX_MATERIAL_CHARS].rstrip(), True)


def _from_scribe(client: ScribeClient, session_id: str | None, since: str | None, until: str | None) -> tuple[str, str, bool]:
    try:
        if session_id:
            transcript, meta = client.full_transcript(session_id, max_total_chars=MAX_MATERIAL_CHARS)
            if not transcript.strip():
                raise SuggestInputError(f"Session {session_id} has no transcribed speech yet.")
            return transcript, f"Scribe: {meta.get('title') or session_id}", len(transcript) >= MAX_MATERIAL_CHARS
        if not (since or until):
            raise SuggestInputError("A Scribe source needs session_id, or since/until.")
        rows = client.sessions(from_=since, to=until, limit=MAX_SCRIBE_SESSIONS).get("sessions") or []
        pieces, titles, used, truncated = [], [], 0, False
        for row in rows:
            remaining = MAX_MATERIAL_CHARS - used
            if remaining <= 0:
                truncated = True
                break
            transcript, meta = client.full_transcript(row["id"], max_total_chars=remaining)
            if transcript.strip():
                title = meta.get("title") or row["id"]
                titles.append(title)
                pieces.append(f"## {title}\n{transcript}")
                used += len(pieces[-1])
    except ScribeUnavailable as error:
        raise SuggestInputError(str(error)) from error
    if not pieces:
        raise SuggestInputError("No Scribe session in that range has transcribed speech.")
    return "\n\n".join(pieces), "Scribe: " + ", ".join(titles), truncated


def _from_sources(services, subject: dict, topic: dict | None, query: str | None) -> tuple[str, str, bool]:
    """Passages of the subject's indexed notebook sources (read straight from the
    `sources`/`chunks` tables, so this works whatever the notebook's retrieval API)."""
    try:
        with services.db.lock:
            rows = services.db.conn.execute(
                "SELECT s.filename, s.title, c.page, c.heading, c.text, c.ord FROM chunks c JOIN sources s ON s.id=c.source_id "
                "WHERE s.subject_id=? AND s.status='indexed' ORDER BY s.filename, c.ord", (subject["id"],)).fetchall()
    except sqlite3.OperationalError:
        rows = []
    if not rows:
        raise SuggestInputError("This subject has no indexed notebook sources yet (see notebook_sources / source_add).")
    if topic:
        keys = {slugify(topic.get("title") or ""), slugify(re.sub(r"\.[^.]+$", "", topic.get("pdfFilename") or ""))} - {""}
        narrowed = [r for r in rows if any(k and (k in slugify(r["filename"] or "") or k in slugify(r["title"] or ""))
                                           for k in keys)]
        rows = narrowed or rows
    if query:
        terms = [t for t in re.split(r"\W+", normalize_text(query)) if len(t) > 2]
        scored = [(sum(normalize_text(r["text"]).count(t) for t in terms), i, r) for i, r in enumerate(rows)]
        hits = [x for x in scored if x[0] > 0]
        if hits:
            hits.sort(key=lambda x: (-x[0], x[1]))
            rows = [r for _, _, r in sorted(hits[:40], key=lambda x: x[1])]
    pieces, used, truncated = [], 0, False
    for r in rows:
        piece = f"[{r['title'] or r['filename']}, p. {r['page']}]\n{r['text']}"
        if used + len(piece) > MAX_MATERIAL_CHARS:
            truncated = True
            break
        pieces.append(piece)
        used += len(piece) + 2
    label = ", ".join(sorted({r["filename"] for r in rows}))[:300]
    return "\n\n".join(pieces), f"Fuentes: {label}", truncated


def gather_material(services, source: dict[str, Any], subject: dict, topic: dict | None,
                    scribe_client: ScribeClient | None = None) -> tuple[str, str, bool]:
    kind = source.get("kind")
    if kind == "text":
        text, truncated = _truncate(source.get("text") or "")
        if not text:
            raise SuggestInputError("The text source is empty.")
        return text, "texto pegado", truncated
    if kind == "scribe":
        return _from_scribe(scribe_client or ScribeClient(), source.get("session_id"), source.get("since"), source.get("until"))
    if kind == "sources":
        return _from_sources(services, subject, topic, source.get("query"))
    raise SuggestInputError(f"Unknown source kind: {kind!r}")


def normalize_draft(item: Any, allowed: list[str]) -> dict | None:
    """One model item -> a valid ExtractedQuestion dict, or None."""
    if not isinstance(item, dict):
        return None
    qtype = str(item.get("type") or "").upper()
    if qtype not in allowed:
        return None
    q = bank.clean_question_input({**item, "type": qtype})
    if qtype == "TEST" and q.get("correctOptionIds"):
        q["correctOptionIds"] = [str(c) for c in q["correctOptionIds"]]
    difficulty = q.get("difficulty")
    if difficulty is not None:
        try:
            q["difficulty"] = min(5, max(1, int(difficulty)))
        except (TypeError, ValueError):
            q.pop("difficulty")
    try:
        bank.validate_question(q)
    except ValueError:
        return None
    return q


def suggest(services, source: dict[str, Any], subject: dict, topic: dict | None, n: int, types: list[str],
            language: str = "es", scribe_client: ScribeClient | None = None) -> dict:
    material, label, truncated = gather_material(services, source, subject, topic, scribe_client)
    base = {"subject": subject.get("name"), "topic": topic.get("title") if topic else None, "source": label,
            "truncated": truncated}
    fallback = ("Draft the questions yourself from `material` (ExtractedQuestion shape: type, prompt, options "
                "[{id,text}], correctOptionIds, modelAnswer, keywords, clozeText, blanks, explanation, difficulty), "
                "show them, and save only the accepted ones with questions_suggest_accept.")
    try:
        result = ai.chat(services, backend.build_suggest_messages(material, n, types, language),
                         max_tokens=backend.SUGGEST_MAX_TOKENS, temperature=0.3)
    except (ai.Unavailable, ai.BackendError) as error:
        return {**base, "drafts": [], "material": material, "model": None,
                "note": f"No language model could draft questions ({error}). {fallback}"}
    data = ai.parse_json(result.text)
    if isinstance(data, dict):
        data = data.get("questions") or data.get("drafts") or []
    if not isinstance(data, list):
        return {**base, "drafts": [], "material": material, "model": result.model,
                "note": f"The model did not reply with the expected JSON. {fallback}"}
    drafts = [d for d in (normalize_draft(x, types) for x in data) if d][:n]
    for d in drafts:
        d.setdefault("origin", "alumno")
    note = "The model found nothing worth a question in this material." if not drafts else None
    if drafts and truncated:
        note = "The material was longer than the drafting budget; only its first part was used."
    return {**base, "drafts": drafts, "material": None, "model": result.model, "note": note}


def accept(services, subject: dict, topic: dict, drafts: list[dict]) -> dict:
    results = []
    for draft in drafts:
        question, existing = bank.add_question(services, subject, topic, draft, origin="alumno")
        results.append({"id": question["id"], "existing": existing, "prompt": question.get("prompt")})
    return {"subject": subject.get("name"), "topic": topic.get("title"), "questions": results,
            "added": sum(1 for r in results if not r["existing"]), "existing": sum(1 for r in results if r["existing"])}
