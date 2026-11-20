"""Objection rehearsal of a presentation: hard questions per slide, checked against what each slide says.

A deck from Cicero's Hoard (read through the Hub, or passed whole) becomes a subject with one topic per slide and one open
question per objection: the prompt is the objection, the model answer is what the slide must support, the keywords are the
points it cannot miss and the explanation keeps the evidence (verbatim quotes from the deck's sources). The oral and written
review tools then work on it like on any other subject.

``check`` judges every slide's text and speaker notes against its objections, with the configured model or, without one, by
its keywords. The slides that do not hold are sent back to Cicero as defects (slide, objection, expected answer, evidence);
sending the verdict again after the slide is fixed closes them there. Each write can be taken back with ``undo``.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, Field

from . import ai, bank
from .grading import keyword_matches
from .hashing import normalize_text
from .hoard_link import family

KV_PREFIX = "rehearsal:"
CICERO = "cicero"
MAX_RUNS = 30
EVIDENCE_MIN = 12
JUDGE_TOKENS = 700
DRAFT_TOKENS = 3000
TEXT_SKIP = {"type", "id", "asset_id", "layout", "style", "align", "color", "icon", "chart", "kind", "target", "href", "url",
             "variant", "size", "frame", "poster_id", "animation", "transition", "shape", "theme"}


class ObjectionIn(BaseModel):
    slide_id: str = Field(..., min_length=1, max_length=40, description="The slide the objection is about.")
    question: str = Field(..., min_length=3, max_length=1000, description="The hard question, as an audience would ask it.")
    expected: str = Field(..., min_length=3, max_length=3000, description="The answer the slide must support.")
    keywords: list[str] = Field(default_factory=list, max_length=12, description="Points the answer cannot miss.")
    evidence: list[str] = Field(default_factory=list, max_length=6, description="Verbatim quotes from the sources that back it.")


class PrepareArgs(BaseModel):
    deck_id: str = Field(..., min_length=1, max_length=40, description="Cicero deck id (deck_list in Cicero).")
    deck: dict[str, Any] | None = Field(None, description="The deck as Cicero's deck_get(detail=full) returns it; omitted: read through the Hub.")
    objections: list[ObjectionIn] | None = Field(None, max_length=120, description="Your objections; omitted: the model drafts them.")
    per_slide: int = Field(1, ge=1, le=3, description="Objections the model drafts per slide.")
    subject: str | None = Field(None, max_length=200, description="Subject name (default «Ensayo · <deck title>»).")


class RehearsalRef(BaseModel):
    rehearsal: str = Field(..., min_length=1, max_length=100, description="Rehearsal id (= its subject id, from rehearsal_prepare).")


class CheckArgs(RehearsalRef):
    deck: dict[str, Any] | None = Field(None, description="The deck as it is now; omitted: read through the Hub.")
    send: bool = Field(True, description="Send the slides that do not hold back to Cicero as defects (deck_defects_receive).")


# ---------------------------------------------------------------- the deck

def slide_text(slide: dict[str, Any]) -> str:
    """Everything a slide says: title, subtitle, every text in its blocks (bullets, tables, chart labels and values) and its notes."""
    parts: list[str] = []

    def walk(value: Any, key: str = "") -> None:
        if key in TEXT_SKIP:
            return
        if isinstance(value, str):
            if value.strip():
                parts.append(value.strip())
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            parts.append(str(value))
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for k, v in value.items():
                walk(v, k)

    for field in ("title", "subtitle"):
        walk(slide.get(field))
    walk(slide.get("blocks") or [])
    if (slide.get("notes") or "").strip():
        parts.append("Notas del orador: " + slide["notes"].strip())
    return "\n".join(parts)


def fingerprint(slide: dict[str, Any]) -> str:
    return hashlib.sha256(slide_text(slide).encode("utf-8")).hexdigest()[:16]


def _hub_result(answer: dict[str, Any], what: str) -> Any:
    if not answer.get("ok"):
        raise LookupError(f"Could not {what} through the Hub: {answer.get('error') or answer.get('status')}. "
                          "Start Cicero's Hoard from the Hub, or pass the deck itself.")
    return answer.get("result")


def read_deck(deck_id: str, deck: dict[str, Any] | None) -> dict[str, Any]:
    if deck is None:
        deck = _hub_result(family.call(CICERO, "deck_get", {"deck_id": deck_id, "detail": "full"}, timeout=60), f"read deck {deck_id}")
    if not isinstance(deck, dict) or not isinstance(deck.get("slides"), list):
        raise ValueError("The deck must be Cicero's deck_get(detail=full) answer, with its slides.")
    if deck.get("id") and deck["id"] != deck_id:
        raise ValueError(f"That deck is {deck['id']}, not {deck_id}.")
    return deck


def _source_texts(deck: dict[str, Any]) -> dict[str, str]:
    """The text of every source a slide cites, read through the Hub (empty when Cicero does not answer)."""
    texts: dict[str, str] = {}
    cited = {str(s) for slide in deck["slides"] for s in slide.get("sources") or []}
    for source in deck.get("sources") or []:
        sid = str(source.get("id"))
        if sid not in cited:
            continue
        answer = family.call(CICERO, "source_get", {"deck_id": deck["id"], "source_id": int(sid) if sid.isdigit() else sid,
                                                    "max_chars": 12000}, timeout=30)
        result = answer.get("result") if answer.get("ok") else None
        if isinstance(result, dict) and isinstance(result.get("text"), str):
            texts[sid] = result["text"]
    return texts


# ---------------------------------------------------------------- drafting objections

DRAFT_SYSTEM = {
    "es": "Eres el miembro más exigente del público de una presentación. Para cada diapositiva redactas objeciones difíciles "
          "(lo que alguien preguntaría para comprobar que lo que dice se sostiene) y la respuesta que la diapositiva debería poder "
          "dar, apoyada solo en las fuentes. Devuelve JSON: {\"objections\": [{\"slide_id\", \"question\", \"expected\", "
          "\"keywords\": [..], \"evidence\": [citas literales de las fuentes]}]}. No inventes datos: si las fuentes no lo dicen, no "
          "va en expected. Las citas de evidence se copian tal cual de las fuentes.",
    "en": "You are the most demanding person in a presentation's audience. For each slide you write hard objections (what someone "
          "would ask to check that what it says holds) and the answer the slide should be able to give, backed only by the sources. "
          "Return JSON: {\"objections\": [{\"slide_id\", \"question\", \"expected\", \"keywords\": [..], \"evidence\": [verbatim "
          "quotes from the sources]}]}. Never invent data: what the sources do not say does not go in expected. Evidence quotes are "
          "copied exactly from the sources.",
}


def draft_objections(services, deck: dict[str, Any], per_slide: int) -> list[ObjectionIn]:
    language = "en" if str(deck.get("language", "es")).startswith("en") else "es"
    sources = _source_texts(deck)
    lines = [f"Presentación: {deck.get('title', '')}", f"Objeciones por diapositiva: {per_slide}", ""]
    for slide in deck["slides"]:
        lines += [f"--- slide_id {slide['id']} (diapositiva {slide.get('position')})", slide_text(slide)[:3000],
                  "Fuentes citadas: " + ", ".join(str(s) for s in slide.get("sources") or []) or "ninguna", ""]
    for sid, text in sources.items():
        lines += [f"=== Fuente {sid}", text[:6000], ""]
    result = ai.chat(services, [{"role": "system", "content": DRAFT_SYSTEM[language]}, {"role": "user", "content": "\n".join(lines)}],
                     max_tokens=DRAFT_TOKENS, temperature=0.3, response_format={"type": "json_object"}, effort="medium")
    data = ai.parse_json(result.text)
    items = data.get("objections") if isinstance(data, dict) else data
    corpus = normalize_text(" ".join(sources.values()))
    known = {s["id"] for s in deck["slides"]}
    out: list[ObjectionIn] = []
    for item in items if isinstance(items, list) else []:
        try:
            objection = ObjectionIn.model_validate({**item, "keywords": [str(k) for k in item.get("keywords") or []][:12],
                                                    "evidence": [str(q) for q in item.get("evidence") or []][:6]})
        except Exception:  # noqa: BLE001 — a malformed draft is skipped, never stored
            continue
        if objection.slide_id not in known:
            continue
        # Only quotes that really are in the sources stay as evidence.
        objection.evidence = [q for q in objection.evidence if len(q.strip()) >= EVIDENCE_MIN and normalize_text(q) in corpus]
        out.append(objection)
    if not out:
        raise ValueError("The model drafted no usable objection for this deck. Pass objections yourself.")
    return out


# ---------------------------------------------------------------- storage

def _load(services, rehearsal_id: str) -> dict[str, Any]:
    state = services.store.kv_get(KV_PREFIX + rehearsal_id)
    if not state:
        raise LookupError(f"No rehearsal {rehearsal_id}. rehearsal_prepare makes one from a Cicero deck.")
    return state


def _save(services, state: dict[str, Any]) -> None:
    services.store.kv_set(KV_PREFIX + state["id"], state)


def _undo_hint(rehearsal_id: str) -> dict[str, Any]:
    return {"tool": "rehearsal_undo", "arguments": {"rehearsal": rehearsal_id}}


def _evidence_text(evidence: list[str]) -> str:
    return "Evidencia:\n" + "\n".join(f"«{q}»" for q in evidence) if evidence else ""


def prepare(services, a: PrepareArgs) -> dict[str, Any]:
    deck = read_deck(a.deck_id, a.deck)
    if not deck["slides"]:
        raise ValueError("The deck has no slides to rehearse.")
    objections = a.objections if a.objections is not None else draft_objections(services, deck, a.per_slide)
    slides = {s["id"]: s for s in deck["slides"]}
    unknown = sorted({o.slide_id for o in objections if o.slide_id not in slides})
    if unknown:
        raise ValueError(f"These slides are not in deck {a.deck_id}: {', '.join(unknown)}.")
    if not objections:
        raise ValueError("No objections to rehearse.")
    name = (a.subject or "").strip() or f"Ensayo · {deck.get('title') or a.deck_id}"
    subject, subject_created = bank.ensure_subject(services, name)
    state_key = KV_PREFIX + subject["id"]
    if services.store.kv_get(state_key):
        raise ValueError(f"Subject «{subject['name']}» already holds rehearsal {subject['id']}: use rehearsal_check, "
                         "or give another subject name.")
    topics_before = {t["id"] for t in services.store.list("topic", subject["id"])}
    created_questions, items = [], []
    for objection in objections:
        slide = slides[objection.slide_id]
        topic = bank.ensure_topic(services, subject["id"], f"{slide.get('position')}. {slide.get('title') or 'Diapositiva'}")
        data = {"type": "DESARROLLO", "prompt": objection.question, "modelAnswer": objection.expected,
                "keywords": objection.keywords, "explanation": _evidence_text(objection.evidence), "tags": ["ensayo", "objeción"]}
        question, existing = bank.add_question(services, subject, topic, data, origin="rehearsal",
                                               source_ref=f"hoard://cicero/deck/{a.deck_id}/slide/{objection.slide_id}")
        if not existing:
            created_questions.append(question["id"])
        items.append({"question_id": question["id"], "slide_id": objection.slide_id, "question": objection.question,
                      "expected": objection.expected, "keywords": objection.keywords, "evidence": objection.evidence})
    state = {"id": subject["id"], "subject": subject["name"], "deck_id": a.deck_id, "deck_title": deck.get("title", ""),
             "origin": f"hypatia:rehearsal/{subject['id']}", "created_at": services.now_iso(), "objections": items, "runs": [],
             "created": {"subject": subject_created, "questions": created_questions,
                         "topics": [t["id"] for t in services.store.list("topic", subject["id"]) if t["id"] not in topics_before]}}
    _save(services, state)
    return {"rehearsal": subject["id"], "subject": subject["name"], "deck_id": a.deck_id, "objections": len(items),
            "slides": len({i["slide_id"] for i in items}), "drafted_by_model": a.objections is None,
            "next": "rehearsal_check judges each slide against its objections and sends the weak ones back to Cicero. "
                    "oral_card_next / oral_card_answer on this subject rehearse them aloud.",
            "undo": _undo_hint(subject["id"])}


# ---------------------------------------------------------------- judging

JUDGE_SYSTEM = (
    "Juzgas si una diapositiva aguanta una objeción del público. Lees lo que dice la diapositiva (texto y notas del orador), la "
    "objeción y la respuesta esperada. La diapositiva aguanta si su contenido da esa respuesta, o una equivalente, sin que el "
    "orador tenga que inventar nada. Devuelve JSON: {\"verdict\": \"holds\"|\"weak\"|\"fails\", \"missing\": [puntos de la "
    "respuesta esperada que faltan], \"feedback\": \"una frase sobre qué le falta a la diapositiva\"}.")


def judge(services, objection: dict[str, Any], text: str) -> dict[str, Any]:
    question = {"keywords": objection.get("keywords") or []}
    matched = keyword_matches(question, text)
    missing_keywords = [k for k in question["keywords"] if k not in matched]
    try:
        user = (f"Diapositiva:\n{text}\n\nObjeción: {objection['question']}\nRespuesta esperada: {objection['expected']}\n"
                f"Puntos clave: {', '.join(question['keywords']) or '(ninguno)'}")
        result = ai.chat(services, [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": user}],
                         max_tokens=JUDGE_TOKENS, temperature=0.1, response_format={"type": "json_object"}, effort="low")
        data = ai.parse_json(result.text)
        verdict = str(data.get("verdict", "")).lower() if isinstance(data, dict) else ""
        if verdict in ("holds", "weak", "fails"):
            return {"verdict": verdict, "missing": [str(m) for m in data.get("missing") or [] if str(m).strip()],
                    "feedback": str(data.get("feedback") or ""), "judge": result.model}
    except (ai.Unavailable, ai.BackendError):
        pass
    if not question["keywords"]:
        return {"verdict": "unjudged", "missing": [], "feedback": "No model answered and the objection has no keywords to check.",
                "judge": None}
    return {"verdict": "holds" if not missing_keywords else "fails", "missing": missing_keywords,
            "feedback": "Judged by keywords (no model answered).", "judge": "keywords"}


def _send(state: dict[str, Any], defects: list[dict[str, Any]], pending: list[str], reopen: list[str] = ()) -> dict[str, Any]:
    """The whole verdict to Cicero: what fails now, and what was not judged (its open defects stay open there).

    ``reopen`` (undo only): the defects the taken-back check closed, so the pending ones among them open again as they were."""
    answer = family.call(CICERO, "deck_defects_receive",
                         {"deck_id": state["deck_id"], "origin": state["origin"], "defects": defects, "pending": pending,
                          "reopen": list(reopen), "reason": "Objection rehearsal verdict from Hypatia's Hoard"}, timeout=60)
    if answer.get("ok"):
        result = answer.get("result") or {}
        return {"ok": True, "opened": len(result.get("opened") or []) + len(result.get("reopened") or []),
                "resolved": len(result.get("resolved") or []), "kept_pending": len(result.get("pending") or []),
                "open_total": result.get("open_total"), "resolved_ids": list(result.get("resolved") or [])}
    return {"ok": False, "error": str(answer.get("error") or answer.get("status"))}


def _defect(item: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
    return {"slide_id": item["slide_id"], "objection": item["question"], "expected": item["expected"],
            "feedback": outcome["feedback"], "missing": outcome["missing"][:20], "evidence": item["evidence"][:10],
            "ref": f"hoard://hypatia/question/{item['question_id']}", "key": item["question_id"]}


def check(services, a: CheckArgs) -> dict[str, Any]:
    state = _load(services, a.rehearsal)
    deck = read_deck(state["deck_id"], a.deck)
    slides = {s["id"]: s for s in deck["slides"]}
    results, defects = [], []
    for item in state["objections"]:
        slide = slides.get(item["slide_id"])
        if slide is None:
            results.append({"question_id": item["question_id"], "slide_id": item["slide_id"], "verdict": "slide_missing",
                            "question": item["question"], "missing": [], "feedback": "The slide is no longer in the deck."})
            continue
        text = slide_text(slide)
        outcome = judge(services, item, text)
        results.append({"question_id": item["question_id"], "slide_id": item["slide_id"], "position": slide.get("position"),
                        "title": slide.get("title", ""), "question": item["question"], "slide_fingerprint": fingerprint(slide),
                        **outcome})
        if outcome["verdict"] in ("weak", "fails"):
            defects.append(_defect(item, outcome))
    unjudged = [r["question_id"] for r in results if r["verdict"] == "unjudged"]
    run = {"at": services.now_iso(), "results": results, "defects": defects, "unjudged": unjudged, "sent": None}
    if a.send:
        run["sent"] = _send(state, defects, unjudged)
    state["runs"] = [*state["runs"], run][-MAX_RUNS:]
    _save(services, state)
    failing = sorted({d["slide_id"] for d in defects}, key=lambda sid: slides[sid].get("position") or 0)
    return {"rehearsal": state["id"], "deck_id": state["deck_id"], "objections": len(results),
            "holds": sum(r["verdict"] == "holds" for r in results), "weak_slides": failing, "unjudged": unjudged,
            "defects": defects, "results": results, "sent_to_cicero": run["sent"],
            "next": " ".join(filter(None, [
                "Fix the slides in Cicero (deck_defects lists them), then rehearsal_check again." if defects else "",
                (f"{len(unjudged)} objection(s) could not be judged (no model answered and no keywords): they stay as they were in "
                 "Cicero. Check again when the model answers, or add keywords to the objection.") if unjudged else "",
                "Every slide holds its objections." if not defects and not unjudged else ""])),
            "undo": _undo_hint(state["id"])}


def get(services, a: RehearsalRef) -> dict[str, Any]:
    state = _load(services, a.rehearsal)
    last = state["runs"][-1] if state["runs"] else None
    by_question = {r["question_id"]: r for r in (last or {}).get("results", [])}
    return {"rehearsal": state["id"], "subject": state["subject"], "deck_id": state["deck_id"], "deck_title": state["deck_title"],
            "origin": state["origin"], "runs": len(state["runs"]), "last_run_at": last["at"] if last else None,
            "objections": [{**o, "last": {k: by_question[o["question_id"]].get(k) for k in ("verdict", "missing", "feedback")}
                            if o["question_id"] in by_question else None} for o in state["objections"]],
            "open_defects": (last or {}).get("defects", [])}


def undo(services, a: RehearsalRef) -> dict[str, Any]:
    """Take back the last write: the last check (and its verdict in Cicero), or the rehearsal itself when it has no check left."""
    state = _load(services, a.rehearsal)
    if state["runs"]:
        run = state["runs"].pop()
        resent = None
        if run.get("sent") and run["sent"].get("ok"):
            previous = next((r for r in reversed(state["runs"]) if r.get("sent") and r["sent"].get("ok")), None)
            resent = _send(state, previous["defects"] if previous else [], previous.get("unjudged", []) if previous else [],
                           run["sent"].get("resolved_ids") or [])
        _save(services, state)
        return {"undone": "check", "at": run["at"], "runs_left": len(state["runs"]), "cicero_restored": resent}
    created = state.get("created") or {}
    for qid in created.get("questions") or []:
        if services.store.get("question", qid):
            services.store.delete("question", qid)
    for tid in created.get("topics") or []:
        if services.store.get("topic", tid) and not any(q.get("topicId") == tid for q in services.store.list("question", state["id"])):
            services.store.delete("topic", tid)
    subject_removed = False
    if created.get("subject") and not services.store.list("question", state["id"]):
        services.store.delete("subject", state["id"])
        subject_removed = True
    with services.db.lock:
        services.db.conn.execute("DELETE FROM kv WHERE key=?", (KV_PREFIX + state["id"],))
    return {"undone": "prepare", "questions_removed": len(created.get("questions") or []), "subject_removed": subject_removed}


def to_json(value: Any) -> str:  # pragma: no cover — handy when debugging a rehearsal by hand
    return json.dumps(value, ensure_ascii=False, indent=2)
