"""Guided lessons from a document: sections, key concepts, interleaved questions, mastery per concept.

`lesson_from_document` splits a document (pasted text, or a file Hypatia can read: PDF, DOCX, EPUB...)
into sections, extracts key concepts per section with the same model hook as `questions_suggest`
(deterministic heuristics when no model answers), drafts one question per concept and, unless it is a
preview, stores the lesson and puts the questions in the bank so FSRS/SM-2 schedule them like any card.

Mastery per concept is NOT stored: it is computed on demand from the review history of the questions
linked to the concept (the `reviews` table, falling back to the question's own stats for reviews made in
the PWA), with recent answers weighing more.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import ai, backend, bank, pages, suggest
from .hashing import normalize_text, slugify

MAX_DOCUMENT_CHARS = 60_000
MAX_FILE_BYTES = 60 * 1024 * 1024
SECTION_TARGET = 2200
SECTION_MAX = 6000
MIN_SECTION = 60
MAX_CONCEPTS_PER_SECTION = 4
HALF_LIFE_DAYS = 14.0
CONFIDENCE_ATTEMPTS = 3
LEVEL_WEAK_ACCURACY, LEVEL_MASTERED = 0.5, 0.75
LESSON_TAG = "leccion"

_MD_HEAD = re.compile(r"^#{1,4}\s+(\S.*)$")
_NUM_HEAD = re.compile(r"^(\d+(?:\.\d+){0,3})[.)]?\s+([A-ZÁÉÍÓÚÑ¿].{2,80})$")
_WORD_HEAD = re.compile(r"^(?:tema|cap[ií]tulo|unidad|lecci[oó]n|secci[oó]n|chapter|section|unit|lesson)\s+\w+.{0,70}$", re.I)
_DEF = re.compile(
    r"^(?P<term>[A-ZÁÉÍÓÚÑa-záéíóúñ][^.:;!?\n]{1,60}?)\s+(?:es|son|se define como|se denomina|consiste en|se llama|"
    r"is|are|is defined as|refers to|is called)\s+(?P<rest>.{12,})$")
_COLON_DEF = re.compile(r"^(?P<term>[^.:;!?\n]{2,50}):\s+(?P<rest>.{15,})$")
_BOLD = re.compile(r"\*\*([^*\n]{2,50})\*\*")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9\"«(])")
_ES_WORDS = {"el", "la", "los", "las", "de", "que", "es", "y", "en", "un", "una", "por", "con", "para", "se"}
_EN_WORDS = {"the", "of", "and", "is", "are", "to", "in", "that", "for", "with", "this", "as", "it", "by"}
_LEAD = re.compile(r"^(?:el|la|los|las|un|una|the|a|an)\s+", re.I)

LEVELS = ("sin ver", "débil", "en progreso", "dominado")


class LessonInputError(ValueError):
    """The document cannot be turned into a lesson."""


# ---------- reading the document ----------

def read_document(text: str | None, path: str | None) -> tuple[str, str, str]:
    """(text, title, source label). Exactly one of text / path."""
    if bool(text and text.strip()) == bool(path and path.strip()):
        raise LessonInputError("Give exactly one of text or path.")
    if text and text.strip():
        return text, "", "texto pegado"
    file = Path(path.strip().strip('"')).expanduser()
    if not file.is_file():
        raise LessonInputError(f"No file at {file}.")
    if file.stat().st_size > MAX_FILE_BYTES:
        raise LessonInputError("The file is larger than 60 MB.")
    from .hoard_link.docs import readers_lite

    doc = readers_lite.read_any(file.name, file.read_bytes())
    if doc.get("error") and not doc.get("units"):
        raise LessonInputError(f"{file.name}: {doc['error']}")
    parts = []
    for unit in doc.get("units") or []:
        body = (unit.get("text") or "").strip()
        if not body:
            continue
        title = (unit.get("title") or "").strip()
        parts.append(f"# {title}\n{body}" if unit.get("kind") == "section" and title else body)
    joined = "\n\n".join(parts).strip()
    if not joined:
        why = "it has no text layer (scanned: it needs OCR)" if doc.get("needs_ocr") else "it has no readable text"
        raise LessonInputError(f"{file.name}: {why}.")
    meta = str(doc.get("title") or "").strip()  # a PDF producer often leaves a URL or a temp name here
    if re.search(r"[:/\\]|\.\w{2,4}$", meta) or len(re.findall(r"[^\W\d_]", meta)) < 6:
        meta = ""
    return joined, meta, file.name


def detect_language(text: str) -> str:
    words = re.findall(r"[a-záéíóúñü]+", text.lower()[:6000])
    es = sum(1 for w in words if w in _ES_WORDS)
    en = sum(1 for w in words if w in _EN_WORDS)
    return "en" if en > es else "es"


# ---------- sections ----------

def _heading(line: str) -> str | None:
    line = line.strip()
    if not line or len(line) > 90:
        return None
    m = _MD_HEAD.match(line)
    if m:
        return m.group(1).strip(" #")
    if line.endswith((".", ",", ";")):
        return None
    if _NUM_HEAD.match(line) or _WORD_HEAD.match(line):
        return line
    letters = [c for c in line if c.isalpha()]
    if 4 <= len(line) <= 80 and len(letters) >= 4 and all(c.isupper() for c in letters) and not line.endswith(":"):
        return line.title()
    return None


def _loose_heading(line: str, prev: str, nxt: str) -> str | None:
    """A heading with no marker (what a PDF gives): a short capitalised line without final punctuation, after the
    end of a sentence (or at the start) and before a real body line."""
    line = line.strip()
    if not (3 <= len(line) <= 60) or len(line.split()) > 7 or not line[0].isupper() or line[-1] in ".,;:!?)":
        return None
    if prev.strip() and prev.strip()[-1] not in ".!?:":
        return None
    if len(nxt.strip()) < 50 or sum(c.isalpha() for c in line) < len(line) * 0.6:
        return None
    return line


def _chunk_paragraphs(text: str, title: str, target: int) -> list[dict]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, current = [], ""
    for p in paragraphs:
        if current and len(current) + len(p) > target:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{p}".strip()
    if current:
        chunks.append(current)
    return [{"title": title if len(chunks) == 1 else f"{title} ({i})", "text": c} for i, c in enumerate(chunks, 1)]


def split_sections(text: str, max_sections: int = 10, fallback_title: str = "Documento") -> list[dict]:
    """Deterministic sections: headings (markdown, numbered, 'Tema 3', ALL CAPS) else paragraph blocks."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    raw: list[dict] = []
    title, buf = "", []

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body or title:
            raw.append({"title": title, "text": body})

    lines = text.split("\n")
    for i, line in enumerate(lines):
        head = _heading(line) or _loose_heading(line, lines[i - 1] if i else "", lines[i + 1] if i + 1 < len(lines) else "")
        if head:
            flush()
            title, buf = head, []
        else:
            buf.append(line)
    flush()
    # Text before the first heading is an introduction; empty headings fold into the next section.
    merged: list[dict] = []
    carry = ""
    for s in raw:
        if not s["text"]:
            carry = f"{carry} / {s['title']}".strip(" /") if carry else s["title"]
            continue
        merged.append({"title": s["title"] or carry or "Introducción", "text": s["text"]})
        carry = ""
    if carry and merged:
        merged[-1]["text"] += f"\n\n{carry}"
    if len(merged) <= 1:
        body = merged[0]["text"] if merged else text.strip()
        base = merged[0]["title"] if merged and merged[0]["title"] != "Introducción" else fallback_title
        merged = _chunk_paragraphs(body, base, SECTION_TARGET) if len(body) > SECTION_MAX // 2 else [{"title": base, "text": body}]
    # Split giants, then fold tiny sections into the previous one, then cap the count.
    sized: list[dict] = []
    for s in merged:
        if len(s["text"]) > SECTION_MAX:
            sized.extend(_chunk_paragraphs(s["text"], s["title"], SECTION_TARGET))
        else:
            sized.append(s)
    folded: list[dict] = []
    for s in sized:
        if folded and len(s["text"]) < MIN_SECTION and len(folded[-1]["text"]) + len(s["text"]) < SECTION_MAX:
            folded[-1]["text"] += f"\n\n{s['title']}\n{s['text']}" if s["title"] else f"\n\n{s['text']}"
        else:
            folded.append(dict(s))
    while len(folded) > max_sections:
        i = min(range(len(folded) - 1), key=lambda k: len(folded[k]["text"]) + len(folded[k + 1]["text"]))
        folded[i]["text"] += f"\n\n{folded[i + 1]['title']}\n{folded[i + 1]['text']}"
        del folded[i + 1]
    return [{"n": i, "title": s["title"][:120], "text": s["text"]} for i, s in enumerate(folded, 1)]


# ---------- concepts ----------

def _clean_term(term: str) -> str:
    term = _LEAD.sub("", term.strip().strip("*_\"'«»()").strip())
    return term[:1].upper() + term[1:] if term else term


def _sentences(text: str) -> list[str]:
    flat = re.sub(r"\s+", " ", text)
    return [s.strip() for s in _SENTENCE_SPLIT.split(flat) if len(s.strip()) > 20]


def heuristic_concepts(section: dict, language: str) -> list[dict]:
    """Definitions ('X es Y', 'X: Y'), bold terms and, failing those, the heading: no model needed."""
    found: list[dict] = []
    seen: set[str] = set()

    def add(term: str, summary: str) -> None:
        term = _clean_term(term)
        key = normalize_text(term)
        if len(term) < 3 or len(term.split()) > 7 or key in seen:
            return
        seen.add(key)
        found.append({"name": term, "summary": summary.strip()[:600]})

    for line in section["text"].split("\n"):
        m = _COLON_DEF.match(line.strip().lstrip("-*• "))
        if m and not _heading(line):
            add(m.group("term"), m.group("rest"))
    sentences = _sentences(section["text"])
    for sentence in sentences:
        m = _DEF.match(sentence)
        if m:
            add(m.group("term"), sentence)
    for m in _BOLD.finditer(section["text"]):
        term = m.group(1)
        if normalize_text(_clean_term(term)) in seen:
            continue
        host = next((s for s in sentences if term in s), "")
        if host:
            add(term, host)
    if not found and section["title"]:
        lead = sentences[0] if sentences else section["text"][:300]
        add(section["title"], lead)
    return found[:MAX_CONCEPTS_PER_SECTION]


def heuristic_question(concept: dict, language: str) -> dict:
    prompt = f"What is {concept['name']}?" if language == "en" else f"¿Qué es {concept['name']}?"
    if not _DEF.match(concept["summary"] or ""):
        prompt = f"Explain «{concept['name']}»." if language == "en" else f"Explica «{concept['name']}»."
    return {"type": "DESARROLLO", "prompt": prompt, "modelAnswer": concept["summary"] or concept["name"],
            "keywords": [concept["name"]], "difficulty": 2}


def _model_concepts(services, section: dict, language: str) -> list[dict] | None:
    """The model's concepts for one section, or None if it replied nothing usable. Raises Unavailable/BackendError."""
    result = ai.chat(services, backend.build_lesson_messages(section["title"], section["text"], language,
                                                             MAX_CONCEPTS_PER_SECTION),
                     max_tokens=backend.SUGGEST_MAX_TOKENS, temperature=0.2, effort="low")
    data = ai.parse_json(result.text)
    if isinstance(data, dict):
        data = data.get("concepts")
    if not isinstance(data, list):
        return None
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = _clean_term(str(item.get("name") or ""))
        summary = " ".join(str(item.get("summary") or "").split())
        if len(name) < 2 or len(name) > 100 or not summary:
            continue
        question = suggest.normalize_draft(item.get("question"), ["TEST", "DESARROLLO"])
        out.append({"name": name, "summary": summary[:600], **({"question": question} if question else {})})
    return out[:MAX_CONCEPTS_PER_SECTION]


# ---------- building ----------

def build_outline(services, text: str, title: str, language: str, max_sections: int, use_model: bool,
                  fallback_title: str) -> tuple[list[dict], list[dict], dict]:
    """(sections, concepts, info). Concepts carry `section` (n) and a draft `question`."""
    sections = split_sections(text, max_sections, title or fallback_title)
    model_name, notes, model_ok = None, [], use_model
    concepts: list[dict] = []
    seen: set[str] = set()
    for section in sections:
        proposed = None
        if model_ok:
            try:
                proposed = _model_concepts(services, section, language)
            except (ai.Unavailable, ai.BackendError) as error:
                model_ok = False
                notes.append(f"No language model answered ({error}); concepts and questions were extracted "
                             "with deterministic rules.")
            else:
                model_name = model_name or "model"
        if proposed is None:
            if model_ok:
                notes.append(f"Section {section['n']}: the model replied nothing usable; rules were used.")
            proposed = heuristic_concepts(section, language)
        for c in proposed:
            key = normalize_text(c["name"])
            if key in seen:
                continue
            seen.add(key)
            question = c.get("question") or heuristic_question(c, language)
            concepts.append({"id": f"c{len(concepts) + 1}", "name": c["name"], "summary": c["summary"],
                             "section": section["n"], "question": question})
    if not use_model:
        notes.append("Model disabled by the caller; deterministic rules were used.")
    return sections, concepts, {"model": model_name if model_ok and use_model else None, "notes": notes}


def _content_hash(subject_id: str, text: str) -> str:
    return hashlib.sha256(f"{subject_id}\0{normalize_text(text)}".encode("utf-8")).hexdigest()[:32]


def _lesson_markdown(lesson: dict) -> str:
    parts = [f"# {lesson['title']}"]
    for s in lesson["sections"]:
        parts.append(f"## {s['title']}\n\n{s['text']}")
        names = [c["name"] for c in lesson["concepts"] if c["section"] == s["n"]]
        if names:
            parts.append("**Conceptos clave:** " + ", ".join(names))
    return "\n\n".join(parts)


def create(services, subject: dict, text: str, title: str, source_label: str, topic_ref: str | None,
           language: str, max_sections: int, use_model: bool, save: bool, as_page_card: bool) -> dict:
    text = text.strip()
    if len(text) > MAX_DOCUMENT_CHARS:
        truncated, text = True, text[:MAX_DOCUMENT_CHARS]
    else:
        truncated = False
    if len(text) < 40:
        raise LessonInputError("The document is too short to make a lesson.")
    language = detect_language(text) if language == "auto" else language
    content_hash = _content_hash(subject["id"], text)
    existing = _by_hash(services, subject["id"], content_hash)
    if existing and save:
        return {**outline(services, existing), "saved": True, "existing": True, "note": "This document already has a lesson."}
    fallback = Path(source_label).stem if source_label != "texto pegado" else "Documento"
    sections, concepts, info = build_outline(services, text, title, language, max_sections, use_model, fallback)
    if not concepts:
        raise LessonInputError("No key concepts could be found in that document.")
    rows = [ln for ln in text.split("\n") if ln.strip()]
    lead = ""
    if len(sections) > 1 and rows:
        lead = _heading(rows[0]) or _loose_heading(rows[0], "", rows[1] if len(rows) > 1 else "") or ""
    lesson_title = (title or (sections[0]["title"] if len(sections) == 1 else lead or fallback)).strip()[:120] or "Lección"
    lesson = {"id": bank.new_id(), "title": lesson_title, "subjectId": subject["id"], "topicId": None,
              "source": source_label, "language": language, "contentHash": content_hash,
              "createdAt": services.now_iso(), "model": info["model"], "sections": sections, "concepts": concepts,
              "truncated": truncated}
    notes = list(info["notes"])
    if truncated:
        notes.append(f"The document was longer than {MAX_DOCUMENT_CHARS} characters; only its first part was used.")
    if not save:
        return {"saved": False, "existing": False, "preview": True, "lesson": _public(lesson, services, with_text=True),
                "note": " ".join(notes) or None}
    topic = bank.ensure_topic(services, subject["id"], topic_ref or lesson_title[:80])
    lesson["topicId"] = topic["id"]
    for concept in lesson["concepts"]:
        question, was_existing = bank.add_question(services, subject, topic, concept.pop("question"), origin="alumno")
        _tag_lesson(services, question)
        concept["questionIds"] = [question["id"]]
        concept["questionExisting"] = was_existing
    page = None
    if as_page_card:
        try:
            page, _ = pages.add_page(services, subject, bank.ensure_topic(services, subject["id"], "Páginas"), lesson_title,
                                     pages.markdown_to_html(_lesson_markdown(lesson)), [LESSON_TAG], f"lesson:{lesson['id']}")
            lesson["pageCardId"] = page["id"]
        except ValueError as error:
            notes.append(f"The lesson was not added as a page card: {error}")
    _put(services, lesson)
    return {**outline(services, lesson), "saved": True, "existing": False, "note": " ".join(notes) or None}


def _tag_lesson(services, question: dict) -> None:
    tags = list(question.get("tags") or [])
    if LESSON_TAG not in tags:
        services.store.put("question", {**question, "tags": [*tags, LESSON_TAG], "updatedAt": services.now_iso()})


# ---------- storage ----------

def _put(services, lesson: dict) -> None:
    with services.db.tx() as conn:
        conn.execute("INSERT INTO lessons(id, subject_id, content_hash, created_at, data) VALUES (?,?,?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                     (lesson["id"], lesson["subjectId"], lesson["contentHash"], lesson["createdAt"],
                      json.dumps(lesson, ensure_ascii=False)))


def _rows(services, sql: str, params: tuple = ()) -> list[dict]:
    with services.db.lock:
        return [json.loads(r["data"]) for r in services.db.conn.execute(sql, params).fetchall()]


def list_lessons(services, subject_id: str | None = None) -> list[dict]:
    if subject_id:
        return _rows(services, "SELECT data FROM lessons WHERE subject_id=? ORDER BY created_at, id", (subject_id,))
    return _rows(services, "SELECT data FROM lessons ORDER BY created_at, id")


def _by_hash(services, subject_id: str, content_hash: str) -> dict | None:
    found = _rows(services, "SELECT data FROM lessons WHERE subject_id=? AND content_hash=?", (subject_id, content_hash))
    return found[0] if found else None


def resolve_lesson(services, ref: str, subject_id: str | None = None) -> dict:
    ref = (ref or "").strip()
    lessons = list_lessons(services, subject_id)
    for match in (lambda x: x["id"] == ref, lambda x: normalize_text(x["title"]) == normalize_text(ref),
                  lambda x: slugify(x["title"]).startswith(slugify(ref)) if slugify(ref) else False):
        found = [x for x in lessons if match(x)]
        if len(found) == 1:
            return found[0]
    titles = "; ".join(f"{x['title']} ({x['id'][:8]})" for x in lessons) or "(none)"
    raise LookupError(f"No single lesson matches «{ref}». Lessons: {titles}.")


def delete_lesson(services, lesson: dict, delete_questions: bool) -> dict:
    removed = 0
    if delete_questions:
        for concept in lesson["concepts"]:
            for qid in concept.get("questionIds") or []:
                if services.store.get("question", qid) is not None:
                    services.store.delete("question", qid)
                    removed += 1
    with services.db.tx() as conn:
        conn.execute("DELETE FROM lessons WHERE id=?", (lesson["id"],))
    return {"ok": True, "id": lesson["id"], "questionsDeleted": removed}


# ---------- presentation ----------

def _public(lesson: dict, services, with_text: bool = False) -> dict:
    sections = []
    for s in lesson["sections"]:
        row = {"n": s["n"], "title": s["title"], "chars": len(s["text"]),
               "concepts": [c["name"] for c in lesson["concepts"] if c["section"] == s["n"]]}
        if with_text:
            row["text"] = s["text"]
        sections.append(row)
    concepts = [{k: v for k, v in c.items() if k != "questionExisting"} for c in lesson["concepts"]]
    return {"id": lesson["id"], "title": lesson["title"], "subjectId": lesson["subjectId"], "topicId": lesson.get("topicId"),
            "source": lesson["source"], "language": lesson["language"], "model": lesson.get("model"),
            "createdAt": lesson["createdAt"], "pageCardId": lesson.get("pageCardId"), "sections": sections,
            "concepts": concepts}


def outline(services, lesson: dict) -> dict:
    return {"lesson": _public(lesson, services)}


def summary_row(services, lesson: dict) -> dict:
    m = mastery(services, lesson)
    return {"id": lesson["id"], "title": lesson["title"], "subjectId": lesson["subjectId"], "source": lesson["source"],
            "sections": len(lesson["sections"]), "concepts": len(lesson["concepts"]), "mastery": m["mastery"],
            "levels": m["levels"], "createdAt": lesson["createdAt"]}


def teach(services, lesson: dict, section: int | None, with_answers: bool = False) -> dict:
    """The guided flow: read a section, then answer its questions (answers withheld unless asked)."""
    titles = bank.topic_titles(services, lesson["subjectId"])
    m = {c["conceptId"]: c for c in mastery(services, lesson)["concepts"]}

    def steps_for(s: dict) -> list[dict]:
        out = [{"step": "read", "section": s["n"], "title": s["title"]}]
        for c in lesson["concepts"]:
            if c["section"] != s["n"]:
                continue
            for qid in c.get("questionIds") or []:
                q = services.store.get("question", qid)
                if q is not None:
                    out.append({"step": "question", "section": s["n"], "conceptId": c["id"], "concept": c["name"],
                                "level": m[c["id"]]["level"], "question": bank.brief(q, with_answers, titles)})
        return out

    if section is None:
        return {**outline(services, lesson), "mastery": mastery(services, lesson)["mastery"],
                "flow": [step for s in lesson["sections"] for step in steps_for(s)]}
    found = [s for s in lesson["sections"] if s["n"] == section]
    if not found:
        raise LookupError(f"The lesson has sections 1..{len(lesson['sections'])}, not {section}.")
    s = found[0]
    return {"lesson": lesson["title"], "section": {"n": s["n"], "title": s["title"], "text": s["text"]},
            "concepts": [{"id": c["id"], "name": c["name"], "summary": c["summary"], "level": m[c["id"]]["level"]}
                         for c in lesson["concepts"] if c["section"] == s["n"]],
            "flow": steps_for(s),
            "note": "Teach the section, then ask the questions one at a time; grade with answer_grade/card_review."}


# ---------- mastery ----------

def _age_days(now: datetime, at: str | None) -> float:
    try:
        moment = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0.0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return max(0.0, (now - moment).total_seconds() / 86400.0)


def _events(services, question_ids: list[str]) -> tuple[list[tuple[float, bool]], str | None, str | None, str]:
    """(age_days, correct) events, last result, earliest nextReviewAt, evidence source."""
    now = services.now()
    events: list[tuple[float, bool]] = []
    last: tuple[str, str] | None = None
    next_review: list[str] = []
    used_stats = used_reviews = False
    for qid in question_ids:
        with services.db.lock:
            rows = services.db.conn.execute("SELECT result, at FROM reviews WHERE question_id=? ORDER BY at, id", (qid,)).fetchall()
        q = services.store.get("question", qid) or {}
        stats = q.get("stats") or {}
        if stats.get("nextReviewAt"):
            next_review.append(stats["nextReviewAt"])
        if rows:
            used_reviews = True
            for r in rows:
                events.append((_age_days(now, r["at"]), r["result"] == "CORRECT"))
                if last is None or r["at"] >= last[0]:
                    last = (r["at"], r["result"])
        elif stats.get("seen"):
            used_stats = True  # reviewed in the PWA: only the counters travel, so no decay
            events += [(0.0, True)] * int(stats.get("correct") or 0) + [(0.0, False)] * int(stats.get("wrong") or 0)
            if stats.get("lastResult"):
                stamp = stats.get("lastSeenAt") or ""
                if last is None or stamp >= last[0]:
                    last = (stamp, stats["lastResult"])
    source = "reviews" if used_reviews and not used_stats else "stats" if used_stats and not used_reviews else \
        "reviews+stats" if used_reviews else "none"
    return events, (last[1] if last else None), (min(next_review) if next_review else None), source


def concept_level(attempts: int, accuracy: float, score: float, last_result: str | None) -> str:
    """sin ver / débil (mostly wrong) / en progreso / dominado (high, confident and last answer right)."""
    if attempts == 0:
        return LEVELS[0]
    if score >= LEVEL_MASTERED and last_result == "CORRECT":
        return LEVELS[3]
    if accuracy < LEVEL_WEAK_ACCURACY or (last_result == "WRONG" and accuracy < LEVEL_MASTERED):
        return LEVELS[1]
    return LEVELS[2]


def mastery(services, lesson: dict) -> dict:
    """Per-concept mastery in [0,1]: recency-weighted accuracy (half-life 14 days) x confidence (min(1, attempts/3))."""
    today = services.today()
    rows = []
    for c in lesson["concepts"]:
        events, last_result, next_review, source = _events(services, c.get("questionIds") or [])
        attempts = len(events)
        if attempts:
            weights = [0.5 ** (age / HALF_LIFE_DAYS) for age, _ in events]
            accuracy = sum(w for w, (_, ok) in zip(weights, events) if ok) / sum(weights)
            score = accuracy * min(1.0, attempts / CONFIDENCE_ATTEMPTS)
        else:
            accuracy = score = 0.0
        rows.append({"conceptId": c["id"], "concept": c["name"], "section": c["section"],
                     "questions": len(c.get("questionIds") or []), "attempts": attempts,
                     "accuracy": round(accuracy, 3) if attempts else None, "mastery": round(score, 3),
                     "level": concept_level(attempts, accuracy, score, last_result), "lastResult": last_result,
                     "nextReviewAt": next_review, "dueNow": bool(next_review and next_review <= today),
                     "evidence": source})
    overall = round(sum(r["mastery"] for r in rows) / len(rows), 3) if rows else 0.0
    levels = {name: sum(1 for r in rows if r["level"] == name) for name in LEVELS}
    order = sorted(rows, key=lambda r: (r["mastery"], r["attempts"], r["section"]))
    return {"lessonId": lesson["id"], "lesson": lesson["title"], "mastery": overall, "levels": levels,
            "concepts": rows, "weakest": [r["concept"] for r in order if r["level"] != LEVELS[3]][:5]}
