"""The question bank as the PWA stores it: subjects, topics, questions and key
concepts, created with the same shapes as src/data/repos.ts."""

from __future__ import annotations

import re
import sqlite3
import uuid
from typing import Any

from .hashing import compute_concept_hash, compute_content_hash, normalize_text, slugify

QUESTION_TYPES = ("TEST", "DESARROLLO", "COMPLETAR", "PRACTICO")
ORIGINS = ("test", "examen_anterior", "clase", "alumno")
DEFAULT_TOPIC = "General"

# Fields a question may carry from ExtractedQuestion / the assistant.
CONTENT_FIELDS = ("type", "prompt", "options", "correctOptionIds", "modelAnswer", "keywords", "numericAnswer",
                  "clozeText", "blanks", "explanation", "difficulty", "origin", "tags")
ANSWER_FIELDS = ("correctOptionIds", "modelAnswer", "keywords", "numericAnswer", "blanks", "explanation")


def new_id() -> str:
    return str(uuid.uuid4())


def alias(services) -> str | None:
    settings = services.store.kv_get("syncedSettings") or {}
    return settings.get("alias") or None


# ---------- subjects & topics ----------

def subject_summary(services, subject: dict) -> dict:
    questions = services.store.list("question", subject["id"])
    today = services.today()
    due = sum(1 for q in questions if (q.get("stats") or {}).get("nextReviewAt") and q["stats"]["nextReviewAt"] <= today)
    return {"id": subject["id"], "name": subject.get("name"), "examDate": subject.get("examDate"),
            "questions": len(questions), "topics": len(services.store.list("topic", subject["id"])),
            "due": due, "neverSeen": sum(1 for q in questions if not (q.get("stats") or {}).get("seen"))}


def list_subjects(services) -> list[dict]:
    subjects = sorted(services.store.list("subject"), key=lambda s: (s.get("createdAt") or "", s["id"]))
    return [subject_summary(services, s) for s in subjects]


def ensure_subject(services, name: str) -> tuple[dict, bool]:
    """The subject with this id or exactly this name (by slug), created if none (Hypatia's deck semantics)."""
    ref = name.strip()
    for s in services.store.list("subject"):
        if s["id"] == ref or slugify(s.get("name") or "") == slugify(ref):
            return s, False
    now = services.now_iso()
    subject = {"id": new_id(), "name": ref, "createdAt": now, "updatedAt": now}
    services.store.put("subject", subject)
    return subject, True


def list_topics(services, subject_id: str) -> list[dict]:
    questions = services.store.list("question", subject_id)
    counts: dict[str, int] = {}
    for q in questions:
        counts[q.get("topicId")] = counts.get(q.get("topicId"), 0) + 1
    return [{"n": i, "id": t["id"], "title": t.get("title"), "order": t.get("order"), "pdfFilename": t.get("pdfFilename"),
             "questions": counts.get(t["id"], 0)} for i, t in enumerate(services.topics_of(subject_id), 1)]


def ensure_topic(services, subject_id: str, ref: str | None) -> dict:
    """A topic by id, exact title (slug) or number ("3", "tema 3"); an unknown title
    creates it (order = next); no ref means 'General'."""
    title = (ref or "").strip() or DEFAULT_TOPIC
    topics = services.topics_of(subject_id)
    for t in topics:
        if t["id"] == title or slugify(t.get("title") or "") == slugify(title):
            return t
    if re.fullmatch(r"(?i)(tema|topic|t)?\s*#?\s*\d+", title):
        return services.resolve_topic(subject_id, title)
    now = services.now_iso()
    topic = {"id": new_id(), "subjectId": subject_id, "title": title,
             "order": (max((t.get("order") or 0) for t in topics) + 1) if topics else 0,
             "createdAt": now, "updatedAt": now}
    services.store.put("topic", topic)
    return topic


# ---------- questions ----------

def validate_question(q: dict[str, Any]) -> None:
    qtype = q.get("type")
    if qtype not in QUESTION_TYPES:
        raise ValueError(f"type must be one of {', '.join(QUESTION_TYPES)}.")
    if not (q.get("prompt") or "").strip():
        raise ValueError("A question needs a prompt.")
    if qtype == "TEST":
        options = q.get("options") or []
        ids = [o.get("id") for o in options]
        if len(options) < 2 or len(set(ids)) != len(ids):
            raise ValueError("A TEST question needs at least two options with distinct ids.")
        if not q.get("correctOptionIds") or not set(q["correctOptionIds"]) <= set(ids):
            raise ValueError("correctOptionIds must name at least one of the options' ids.")
    if qtype == "COMPLETAR" and (not q.get("clozeText") or not q.get("blanks")):
        raise ValueError("A COMPLETAR question needs clozeText and blanks.")


def clean_question_input(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep the content fields, drop empties, normalize option ids."""
    q = {k: raw[k] for k in CONTENT_FIELDS if raw.get(k) not in (None, "", [])}
    if q.get("type") == "TEST":
        options = []
        for i, o in enumerate(q.get("options") or []):
            if isinstance(o, str):
                o = {"id": chr(97 + i), "text": o}
            options.append({"id": str(o.get("id") or chr(97 + i)), "text": str(o.get("text") or "")})
        q["options"] = options
    if q.get("type") == "COMPLETAR":
        q["blanks"] = [{"id": str(b.get("id") or f"blank{i + 1}"), "accepted": [str(a) for a in (b.get("accepted") or [])]}
                       for i, b in enumerate(q.get("blanks") or [])]
    return q


def find_duplicate(services, subject_id: str, content_hash: str) -> dict | None:
    for q in services.store.by_hash("question", content_hash):
        if q.get("subjectId") == subject_id:
            return q
    return None


def add_question(services, subject: dict, topic: dict, data: dict[str, Any], origin: str | None = None) -> tuple[dict, bool]:
    """questionRepo.create with dedupe by contentHash within the subject. Returns (question, existing)."""
    q = clean_question_input(data)
    if origin and "origin" not in q:
        q["origin"] = origin
    validate_question(q)
    content_hash = compute_content_hash(q)
    existing = find_duplicate(services, subject["id"], content_hash)
    if existing:
        return existing, True
    now = services.now_iso()
    question = {**q, "subjectId": subject["id"], "topicId": topic["id"], "id": new_id(), "contentHash": content_hash,
                "stats": {"seen": 0, "correct": 0, "wrong": 0}, "createdAt": now, "updatedAt": now}
    creator = alias(services)
    if creator:
        question["createdBy"] = creator
    services.store.put("question", question)
    return question, False


def update_question(services, question: dict, patch: dict[str, Any]) -> dict:
    updated = {**question}
    for key, value in patch.items():
        if value is None:
            continue
        updated[key] = value
    if updated.get("type") == "TEST" or "options" in patch:
        updated.update({k: v for k, v in clean_question_input(updated).items() if k in ("options", "blanks")})
    validate_question(updated)
    updated["contentHash"] = compute_content_hash(updated)
    updated["updatedAt"] = services.now_iso()
    services.store.put("question", updated)
    return updated


def get_question(services, id: str) -> dict:
    q = services.store.get("question", id)
    if q is None:
        raise LookupError(f"Question {id} does not exist.")
    return q


def find_by_prompt(services, prompt: str, subject_id: str | None = None) -> list[dict]:
    target = normalize_text(prompt)
    if not target:
        return []
    return [q for q in services.store.list("question", subject_id) if normalize_text(q.get("prompt") or "") == target]


def _fts_query(text: str) -> str:
    tokens = [t for t in re.split(r"\W+", normalize_text(text)) if t]
    return " ".join(f'"{t}"*' for t in tokens[:12])


def search_questions(services, q: str | None, subject_id: str | None, topic_id: str | None, qtype: str | None,
                     limit: int) -> list[dict]:
    if q and q.strip():
        query = _fts_query(q)
        ids: list[str] = []
        if query:
            try:
                with services.db.lock:
                    rows = services.db.conn.execute(
                        "SELECT id FROM questions_fts WHERE questions_fts MATCH ? ORDER BY bm25(questions_fts) LIMIT 500",
                        (query,)).fetchall()
                ids = [r["id"] for r in rows]
            except sqlite3.OperationalError:
                ids = []
        candidates = [x for x in (services.store.get("question", i) for i in ids) if x]
    else:
        candidates = services.store.list("question", subject_id)
    out = []
    for item in candidates:
        if subject_id and item.get("subjectId") != subject_id:
            continue
        if topic_id and item.get("topicId") != topic_id and topic_id not in (item.get("topicIds") or []):
            continue
        if qtype and item.get("type") != qtype:
            continue
        out.append(item)
        if len(out) >= limit:
            break
    return out


def brief(question: dict, with_answer: bool = True, topics: dict[str, str] | None = None) -> dict:
    """What the assistant needs of a question (the answer only when allowed)."""
    stats = question.get("stats") or {}
    out = {"id": question["id"], "type": question.get("type"), "prompt": question.get("prompt"),
           "subjectId": question.get("subjectId"), "topicId": question.get("topicId")}
    if topics is not None:
        out["topic"] = topics.get(question.get("topicId"))
    if question.get("options"):
        out["options"] = question["options"]
    if question.get("clozeText"):
        out["clozeText"] = question["clozeText"]
    if with_answer:
        for key in ANSWER_FIELDS:
            if question.get(key) not in (None, "", []):
                out[key] = question[key]
    if question.get("tags"):
        out["tags"] = question["tags"]
    if question.get("starred"):
        out["starred"] = True
    out["stats"] = {k: stats.get(k) for k in ("seen", "correct", "wrong", "lastResult", "nextReviewAt") if stats.get(k) is not None}
    return out


# ---------- key concepts ----------

CONCEPT_CATEGORIES = ("formula", "definition", "remark")


def add_key_concept(services, subject: dict, topic: dict | None, category: str, title: str, content: str,
                    tags: list[str] | None = None) -> tuple[dict, bool]:
    if category not in CONCEPT_CATEGORIES:
        raise ValueError(f"category must be one of {', '.join(CONCEPT_CATEGORIES)}.")
    content_hash = compute_concept_hash(category, title, content)
    same = [c for c in services.store.list("keyConcept", subject["id"])]
    for c in same:
        if c.get("contentHash") == content_hash:
            return c, True
    now = services.now_iso()
    order = max([c.get("order") or 0 for c in same if c.get("category") == category], default=-1) + 1
    concept = {"id": new_id(), "subjectId": subject["id"], "category": category, "title": title, "content": content,
               "order": order, "contentHash": content_hash, "createdAt": now, "updatedAt": now}
    if topic:
        concept["topicId"] = topic["id"]
    if tags:
        concept["tags"] = tags
    creator = alias(services)
    if creator:
        concept["createdBy"] = creator
    services.store.put("keyConcept", concept)
    return concept, False


def topic_titles(services, subject_id: str | None = None) -> dict[str, str]:
    return {t["id"]: t.get("title") for t in services.store.list("topic", subject_id)}
