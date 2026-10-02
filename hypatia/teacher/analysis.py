"""Class analysis over confirmed submissions, and "reforzar": a practice set (the
app's Exam entity, so it works with practice sessions, flashcards and SM-2) built
from the bank questions of the topics that went worst, for the whole class or one
student. The practice set never carries a student's name: it travels with the study
data (sync, Gist), which must stay free of student data."""

from __future__ import annotations

from typing import Any, Optional

from .. import bank
from . import core
from .assess import batch_context, find_class, submission_of
from .store import teacher_store

WEAK_THRESHOLD = 0.6


def batch_analysis(services: Any, batch: dict, include_unconfirmed: bool = False) -> dict:
    ctx = batch_context(services, batch)
    exam = ctx["exam"]
    topics = bank.topic_titles(services, exam["subjectId"])
    rubs = {r["id"]: r for r in teacher_store(services).list("rubric", examId=exam["id"])}
    result = core.analyze(exam, ctx["questions"], topics, ctx["submissions"], rubs, ctx["scale"], include_unconfirmed)
    return {"batchId": batch["id"], "title": batch.get("title"), "exam": exam.get("title"), **result}


def class_analysis(services: Any, class_ref: str, exam_ref: Optional[str] = None,
                   include_unconfirmed: bool = False) -> dict:
    from .generate import find_exam

    klass = find_class(services, class_ref)
    store = teacher_store(services)
    batches = store.list("gradingBatch", classId=klass["id"])
    if exam_ref:
        exam = find_exam(services, exam_ref)
        batches = [b for b in batches if b["examId"] == exam["id"]]
    batches.sort(key=lambda b: b.get("createdAt") or "")
    analyses = [batch_analysis(services, b, include_unconfirmed) for b in batches]
    combined = core.combine_topics(analyses)
    out = {"class": klass.get("name"), "course": klass.get("course"), "classId": klass["id"], "exams": analyses,
           "topics": combined, "worstTopic": combined[0] if combined else None}
    if not analyses:
        out["note"] = "Esta clase no tiene entregas todavía."
    elif not any(a["graded"] for a in analyses):
        out["note"] = "Ninguna entrega está confirmada todavía: confirma las notas (o usa include_unconfirmed)."
    return out


def weak_topics_for(services: Any, batch: dict, student_ref: Optional[str] = None,
                    threshold: float = WEAK_THRESHOLD) -> list[dict]:
    """Topics under the threshold for the class (analysis) or for one student (their scores)."""
    if not student_ref:
        a = batch_analysis(services, batch, include_unconfirmed=True)
        return [t for t in a["topics"] if t["success"] is not None and t["success"] < threshold and t["topicId"]]
    ctx = batch_context(services, batch)
    sub = submission_of(services, batch, student_ref)
    topics = bank.topic_titles(services, ctx["exam"]["subjectId"])
    acc: dict[str, list[float]] = {}
    for r in core.item_points(ctx["exam"], ctx["questions"], sub):
        if r["points"] is None or not r["maxPoints"] or not r["topicId"]:
            continue
        row = acc.setdefault(r["topicId"], [0.0, 0.0])
        row[0] += max(0.0, r["points"])
        row[1] += r["maxPoints"]
    out = [{"topicId": t, "topic": topics.get(t), "success": core.round2(v[0] / v[1])} for t, v in acc.items() if v[1]]
    out = [t for t in out if t["success"] < threshold]
    out.sort(key=lambda t: (t["success"], t["topic"] or ""))
    return out


def reinforce(services: Any, batch: dict, student_ref: Optional[str] = None, n: int = 15,
              threshold: float = WEAK_THRESHOLD) -> dict:
    ctx = batch_context(services, batch)
    exam = ctx["exam"]
    weak = weak_topics_for(services, batch, student_ref, threshold)
    if not weak:
        return {"exam": None, "weakTopics": [], "note": "Ningún tema está por debajo del umbral: no hace falta refuerzo."}
    weak_ids = [t["topicId"] for t in weak]
    in_exam = [i["questionId"] for i in exam.get("items") or []]
    pool = []
    for q in services.store.list("question", exam["subjectId"]):
        topic_hit = q.get("topicId") in weak_ids or set(weak_ids) & set(q.get("topicIds") or [])
        if topic_hit:
            pool.append(q)
    rank = {t: i for i, t in enumerate(weak_ids)}
    # The exam's own questions of those topics first, then the rest of the bank, weakest topic first.
    pool.sort(key=lambda q: (q["id"] not in in_exam, rank.get(q.get("topicId"), 99),
                             (q.get("stats") or {}).get("seen") or 0, q["id"]))
    chosen = [q["id"] for q in pool[: max(1, n)]]
    if not chosen:
        return {"exam": None, "weakTopics": weak, "note": "El banco no tiene preguntas de esos temas."}
    names = ", ".join(t["topic"] or "?" for t in weak[:3])
    who = "individual" if student_ref else (teacher_store(services).get("class", batch["classId"]) or {}).get("name") or "clase"
    now = services.now_iso()
    record = {"id": bank.new_id(), "subjectId": exam["subjectId"], "name": f"Refuerzo · {who} · {names}"[:160],
              "description": f"Práctica de refuerzo de {len(weak)} temas flojos tras «{exam.get('title')}».",
              "questionIds": chosen, "createdAt": now, "updatedAt": now}
    services.store.put("exam", record)
    if student_ref:
        sub = submission_of(services, batch, student_ref)
        teacher_store(services).put("submission", {**sub, "reinforceExamId": record["id"]})
    return {"exam": {"id": record["id"], "name": record["name"], "questions": len(chosen)}, "weakTopics": weak,
            "note": "Guardado como examen de práctica: aparece en la pestaña Exámenes de la asignatura "
                    "(practicar o tarjetas)."}
