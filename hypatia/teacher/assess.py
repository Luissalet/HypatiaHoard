"""Batch correction ("Entregas"): one batch per exam + class, one submission per
student. Objective answers are scored deterministically (core.score_objective);
open answers get a model PROPOSAL graded against the rubric, with literal quotes
that are checked against the student's text. Nothing is final until the teacher
confirms: decisions and the grade live on the submission, proposals apart."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Optional

from .. import bank
from ..hashing import normalize_text, slugify
from . import core, jobs, rubrics
from .generate import questions_by_id
from .store import new_id, teacher_store

GRADE_SYSTEM = (
    "Eres un profesor que corrige con una rúbrica. Lee la respuesta del alumno y, para CADA criterio, elige el nivel "
    "cuyo descriptor mejor la describe. Sé honesto: algo cierto pero sobre otra cosa no puntúa. Justifica cada "
    "elección en 1-2 frases en español y copia entre comillas fragmentos LITERALES de la respuesta del alumno que "
    "la apoyen (copiados exactamente, sin corregir faltas). Si el alumno no menciona algo, no inventes citas. "
    "Indica tu confianza entre 0 y 1. Responde SOLO con JSON: "
    '{"criteria":[{"criterionId":"c1","levelId":"c1l2","justification":"...","quotes":["..."]}],'
    '"confidence":0.8,"comment":"1-2 frases para el alumno"}'
)

TRANSCRIBE_PROMPT = ("Transcribe literalmente el texto manuscrito o impreso de esta imagen (respuesta de examen de un "
                     "alumno). No corrijas faltas ni completes nada; marca lo ilegible como [ilegible]. Devuelve solo el texto.")


def answer_text(answer: Optional[dict]) -> str:
    if not answer:
        return ""
    if answer.get("text"):
        return str(answer["text"])
    if answer.get("letters"):
        return str(answer["letters"])
    if answer.get("blankAnswers"):
        return "; ".join(str(v) for v in answer["blankAnswers"].values())
    return ""


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- lookups

def find_class(services: Any, ref: str) -> dict:
    store = teacher_store(services)
    classes = store.list("class")
    if not classes:
        raise LookupError("There are no classes yet (teacher_class_create).")
    ref = (ref or "").strip()
    for c in classes:
        if c["id"] == ref:
            return c
    key = slugify(ref).replace("-", "")
    for match in (lambda c: slugify(c.get("name") or "").replace("-", "") == key,
                  lambda c: slugify(c.get("course") or "").replace("-", "") == key,
                  lambda c: key and (key in slugify(c.get("name") or "").replace("-", "")
                                     or key in slugify(f"{c.get('course') or ''} {c.get('name') or ''}").replace("-", ""))):
        found = [c for c in classes if match(c)]
        if len(found) == 1:
            return found[0]
    names = "; ".join(f"{c.get('name')} ({c.get('course') or ''})" for c in classes)
    raise LookupError(f"No single class matches «{ref}». Classes: {names}.")


def students_of(services: Any, class_id: str) -> list[dict]:
    return sorted(teacher_store(services).list("student", classId=class_id),
                  key=lambda s: (s.get("order") if s.get("order") is not None else 10**6, s.get("displayName") or ""))


def find_batch(services: Any, ref: str) -> dict:
    """A batch by id, or by its exam (id/title) — the newest batch of that exam."""
    from .generate import find_exam

    store = teacher_store(services)
    batch = store.get("gradingBatch", (ref or "").strip())
    if batch:
        return batch
    batches = store.list("gradingBatch")
    key = slugify(ref)
    named = [b for b in batches if key and slugify(b.get("title") or "") == key]
    if len(named) == 1:
        return named[0]
    exam = find_exam(services, ref)
    of_exam = sorted([b for b in batches if b.get("examId") == exam["id"]], key=lambda b: b.get("createdAt") or "",
                     reverse=True)
    if not of_exam:
        raise LookupError(f"The exam «{exam.get('title')}» has no grading batch yet (grading_batch_create).")
    return of_exam[0]


def batch_context(services: Any, batch: dict) -> dict:
    store = teacher_store(services)
    exam = store.get("teacherExam", batch["examId"])
    if exam is None:
        raise LookupError("The batch's exam no longer exists.")
    questions = questions_by_id(services, [i["questionId"] for i in exam.get("items") or []])
    subs = store.list("submission", batchId=batch["id"])
    students = {s["id"]: s for s in store.list("student", classId=batch["classId"])}
    return {"exam": exam, "questions": questions, "submissions": subs, "students": students,
            "scale": settings(services).get("scale")}


def settings(services: Any) -> dict:
    found = teacher_store(services).get("teacherSettings", "default") or {}
    return {"id": "default", "scale": core.normalize_scale(found.get("scale")), **{k: v for k, v in found.items()
                                                                                   if k not in ("id", "scale")}}


# ---------------------------------------------------------------- batches & answers

def create_batch(services: Any, exam: dict, klass: dict, title: Optional[str] = None) -> dict:
    store = teacher_store(services)
    batch = store.put("gradingBatch", {"id": new_id(), "examId": exam["id"], "classId": klass["id"],
                                       "title": title or f"{exam.get('title')} · {klass.get('name')}",
                                       "status": "open"})
    labels = [v["label"] for v in exam.get("versions") or []] or ["A"]
    subs = []
    for i, student in enumerate(students_of(services, klass["id"])):
        subs.append(store.put("submission", {"id": new_id(), "batchId": batch["id"], "studentId": student["id"],
                                             "version": labels[i % len(labels)], "answers": {}, "decisions": {},
                                             "confirmed": False}))
    return {"batch": batch, "submissions": len(subs)}


def submission_of(services: Any, batch: dict, student_ref: str) -> dict:
    store = teacher_store(services)
    subs = store.list("submission", batchId=batch["id"])
    by_id = {s["id"]: s for s in subs}
    if student_ref in by_id:
        return by_id[student_ref]
    students = [store.get("student", s["studentId"]) for s in subs]
    match = core.match_student(student_ref, [s for s in students if s])
    if match is None:
        match = next((s for s in students if s and s["id"] == student_ref), None)
    if match is None:
        raise LookupError(f"No student of this batch matches «{student_ref}».")
    return next(s for s in subs if s["studentId"] == match["id"])


def _resolve_question_key(exam: dict, version: dict, key: str) -> Optional[str]:
    ids = [i["questionId"] for i in exam.get("items") or []]
    if key in ids:
        return key
    m = re.fullmatch(r"(?:p|q|pregunta)?\s*(\d+)", str(key).strip().lower())
    if m:
        pos = int(m.group(1))
        order = version.get("questionOrder") or ids
        if 1 <= pos <= len(order):
            return order[pos - 1]
    return None


def set_answers(services: Any, batch: dict, submission: dict, answers: dict[str, Any],
                version: Optional[str] = None, source: str = "text") -> dict:
    """Merge answers keyed by question id or printed position of the student's version.
    TEST: letters as printed ('b', 'a,c'); COMPLETAR: 'x; y'; open: text."""
    ctx = batch_context(services, batch)
    exam, questions = ctx["exam"], ctx["questions"]
    if version:
        labels = [v["label"] for v in exam.get("versions") or []] or ["A"]
        if version.upper() not in labels:
            raise ValueError(f"Version {version} does not exist (versions: {', '.join(labels)}).")
        submission = {**submission, "version": version.upper()}
    v = core.find_version(exam, submission.get("version"))
    merged = dict(submission.get("answers") or {})
    unknown = []
    for key, value in (answers or {}).items():
        qid = _resolve_question_key(exam, v, str(key))
        if qid is None:
            unknown.append(str(key))
            continue
        q = questions.get(qid) or {}
        if isinstance(value, dict):
            entry = {**value}
        elif q.get("type") == "TEST":
            entry = {"letters": str(value).strip().lower()}
        elif q.get("type") == "COMPLETAR":
            entry = {"blankAnswers": core.split_blanks(value, q.get("blanks") or [])}
        else:
            entry = {"text": str(value)}
        entry.setdefault("source", source)
        merged[qid] = entry
    store = teacher_store(services)
    saved = store.put("submission", {**submission, "answers": merged})
    return {"submission": saved, "unknown": unknown}


def import_grid(services: Any, batch: dict, text: str) -> dict:
    """A CSV/TSV grid (alumno;version;1;2;…) into the batch's submissions."""
    parsed = core.parse_answer_grid(text)
    ctx = batch_context(services, batch)
    students = list(ctx["students"].values())
    subs_by_student = {s["studentId"]: s for s in ctx["submissions"]}
    updated, unmatched = [], []
    for row in parsed["rows"]:
        student = core.match_student(row["student"], students)
        if student is None or student["id"] not in subs_by_student:
            unmatched.append(row["student"])
            continue
        sub = subs_by_student[student["id"]]
        cells = {str(k): v for k, v in row["cells"].items()}
        res = set_answers(services, batch, sub, cells, row.get("version"), source="csv")
        subs_by_student[student["id"]] = res["submission"]
        updated.append(student["displayName"])
    return {"updated": updated, "unmatched": unmatched, "errors": parsed["errors"]}


# ---------------------------------------------------------------- model proposals

def verify_quotes(quotes: Any, answer: str) -> tuple[list[str], int]:
    """Keep quotes that literally appear in the answer (whitespace and case tolerant)."""
    flat = re.sub(r"\s+", " ", answer or "").strip()
    low = flat.lower()
    kept, dropped = [], 0
    for q in quotes if isinstance(quotes, list) else []:
        text = re.sub(r"\s+", " ", str(q or "")).strip().strip('"«»“”').strip()
        if len(text) < 3:
            dropped += 1
            continue
        if text in flat or text.lower() in low:
            start = low.index(text.lower())
            original = flat[start:start + len(text)]
            if original not in kept:
                kept.append(original)
        else:
            dropped += 1
    return kept, dropped


def grade_answer(services: Any, question: dict, rubric: dict, answer: str, points: float) -> dict:
    """One model proposal against the rubric (raises llm.NoModel when there is no model)."""
    from . import llm

    if not answer.strip():
        lows = {c["id"]: c["levels"][0]["id"] for c in rubric.get("criteria") or [] if c.get("levels")}
        result = core.rubric_breakdown(rubric, lows, points)
        return {"status": "empty", "criteria": [{**r, "justification": "Respuesta en blanco.", "quotes": []}
                                                for r in result["criteria"]],
                "points": 0.0, "maxPoints": core.round2(points), "confidence": 1.0, "droppedQuotes": 0,
                "model": None, "note": "Respuesta en blanco."}
    lines = []
    for c in rubric.get("criteria") or []:
        lines.append(f"- {c['id']} «{c['name']}» (peso {c.get('weight')}):")
        for l in c.get("levels") or []:
            lines.append(f"    {l['id']}: {l['descriptor']} ({l['points']} p)")
    user = (f"Pregunta: {question.get('prompt') or ''}\n\nRespuesta modelo: {question.get('modelAnswer') or '(no hay)'}\n"
            + (f"Resultado numérico esperado: {question['numericAnswer']}\n" if question.get("numericAnswer") else "")
            + "\nRúbrica:\n" + "\n".join(lines) + f"\n\nRespuesta del alumno:\n<<<\n{answer}\n>>>")
    reply = llm.chat(services, [{"role": "system", "content": GRADE_SYSTEM}, {"role": "user", "content": user}],
                     max_tokens=2500, temperature=0.1, json_mode=True, effort="medium")
    data = llm.parse_json(reply.text)
    picks = data.get("criteria") if isinstance(data, dict) else None
    if not isinstance(picks, list):
        return {"status": "error", "criteria": [], "points": None, "maxPoints": core.round2(points), "confidence": None,
                "droppedQuotes": 0, "model": reply.model, "note": "El modelo no devolvió la corrección en JSON."}
    by_criterion = {}
    for p in picks:
        if isinstance(p, dict) and p.get("criterionId"):
            by_criterion.setdefault(str(p["criterionId"]), p)
    selections, notes, dropped_total = {}, {}, 0
    for c in rubric.get("criteria") or []:
        pick = by_criterion.get(c["id"]) or {}
        level_ids = {l["id"] for l in c.get("levels") or []}
        if str(pick.get("levelId")) in level_ids:
            selections[c["id"]] = str(pick["levelId"])
        quotes, dropped = verify_quotes(pick.get("quotes"), answer)
        dropped_total += dropped
        notes[c["id"]] = {"justification": str(pick.get("justification") or "").strip()[:800], "quotes": quotes,
                          "droppedQuotes": dropped}
    result = core.rubric_breakdown(rubric, selections, points)
    criteria = [{**r, **notes.get(r["criterionId"], {})} for r in result["criteria"]]
    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence"))))
    except (TypeError, ValueError):
        confidence = None
    status = "ok" if result["complete"] else "partial"
    note = None
    if not result["complete"]:
        note = "El modelo no eligió un nivel válido en algún criterio: complétalo tú."
    if dropped_total:
        note = (note + " " if note else "") + f"{dropped_total} citas descartadas por no aparecer literalmente en la respuesta."
    return {"status": status, "criteria": criteria, "points": result["points"] if result["complete"] else None,
            "maxPoints": core.round2(points), "confidence": confidence, "droppedQuotes": dropped_total,
            "comment": str(data.get("comment") or "").strip()[:600] or None, "model": reply.model, "note": note}


def proposal_id(submission_id: str, question_id: str) -> str:
    return f"{submission_id}::{question_id}"


@jobs.handler("grading_run")
def run_grading(services: Any, params: dict, ctx: jobs.Context) -> tuple[str, Any, Optional[str]]:
    from . import llm

    store = teacher_store(services)
    batch = store.get("gradingBatch", params["batchId"])
    if batch is None:
        raise LookupError("The batch no longer exists.")
    bctx = batch_context(services, batch)
    exam, questions = bctx["exam"], bctx["questions"]
    only_students = set(params.get("studentIds") or [])
    only_questions = set(params.get("questionIds") or [])
    force = bool(params.get("force"))
    tasks, skipped, no_rubric = [], 0, []
    for sub in bctx["submissions"]:
        if only_students and sub["studentId"] not in only_students and sub["id"] not in only_students:
            continue
        if sub.get("confirmed") and not force:
            continue
        for item in exam.get("items") or []:
            q = questions.get(item["questionId"]) or {}
            if q.get("type") not in core.OPEN_TYPES or (only_questions and q.get("id") not in only_questions):
                continue
            rubric = rubrics.rubric_for(services, exam, q["id"])
            if rubric is None:
                if q["id"] not in no_rubric:
                    no_rubric.append(q["id"])
                continue
            text = answer_text((sub.get("answers") or {}).get(q["id"]))
            old = store.get("proposal", proposal_id(sub["id"], q["id"]))
            fingerprint = _hash(text) + ":" + (rubric.get("updatedAt") or "")
            if old and old.get("fingerprint") == fingerprint and old.get("status") in ("ok", "empty") and not force:
                skipped += 1
                continue
            tasks.append((sub, q, item, rubric, text, fingerprint))
    if tasks and any(t[4].strip() for t in tasks):
        ok, _m, reason = llm.resolve(services, "llm")
        if not ok:
            return "no_model", {"batchId": batch["id"], "graded": 0, "pending": len(tasks), "noRubric": no_rubric}, (
                f"No hay modelo local ({reason}): no se ha propuesto ninguna nota. Corrige a mano o vuelve a lanzar "
                "la corrección con un modelo cargado.")
    store.put("gradingBatch", {**batch, "status": "grading"})
    graded, errors = 0, 0
    for n, (sub, q, item, rubric, text, fingerprint) in enumerate(tasks):
        ctx.progress(n, len(tasks), "Corrigiendo respuestas abiertas")
        try:
            proposal = grade_answer(services, q, rubric, text, float(item.get("points") or 0))
        except llm.NoModel as exc:
            store.put("gradingBatch", {**batch, "status": "review"})
            return "no_model", {"batchId": batch["id"], "graded": graded, "pending": len(tasks) - n}, exc.note()
        if proposal["status"] == "error":
            errors += 1
        store.put("proposal", {"id": proposal_id(sub["id"], q["id"]), "batchId": batch["id"], "submissionId": sub["id"],
                               "studentId": sub["studentId"], "questionId": q["id"], "rubricId": rubric["id"],
                               "fingerprint": fingerprint, "answerExcerpt": text[:4000], **proposal})
        graded += 1
    ctx.progress(len(tasks), len(tasks), "Hecho")
    store.put("gradingBatch", {**(store.get("gradingBatch", batch["id"]) or batch), "status": "review"})
    note_parts = []
    if no_rubric:
        note_parts.append(f"{len(no_rubric)} preguntas abiertas sin rúbrica: no se han corregido (rubric_set o rubric_propose).")
    if errors:
        note_parts.append(f"{errors} respuestas sin propuesta válida del modelo.")
    try:
        from ..hoard_link import family

        family.emit("hypatia.grading_batch.graded", {"id": batch["id"], "title": batch.get("title"), "graded": graded})
    except Exception:  # noqa: BLE001
        pass
    return "done", {"batchId": batch["id"], "graded": graded, "skipped": skipped, "errors": errors,
                    "noRubric": no_rubric}, " ".join(note_parts) or None


def transcribe(services: Any, image_b64: str) -> dict:
    """Text of a photographed answer through a vision model ({status: ok|no_model|error})."""
    import base64
    import binascii

    from . import llm

    try:
        image = base64.b64decode(image_b64, validate=False)
    except (binascii.Error, ValueError) as error:
        raise ValueError("The image is not valid base64.") from error
    try:
        reply = llm.chat(services, [{"role": "user", "content": TRANSCRIBE_PROMPT}], images=[image],
                         capability="vision", max_tokens=3000, temperature=0.0, effort="off")
    except llm.NoModel as exc:
        return {"status": "no_model", "text": None, "model": None,
                "note": f"No hay modelo de visión ({exc.detail}). Escribe o pega el texto de la respuesta."}
    if not reply.text:
        return {"status": "error", "text": None, "model": reply.model, "note": "El modelo no devolvió texto."}
    return {"status": "ok", "text": reply.text, "model": reply.model,
            "note": "Transcripción automática: revísala antes de corregir."}


# ---------------------------------------------------------------- review & confirm

def _decision_from_proposal(proposal: dict) -> Optional[dict]:
    if proposal.get("points") is None:
        return None
    return {"points": proposal["points"], "rubricId": proposal.get("rubricId"),
            "criteria": [{k: c.get(k) for k in ("criterionId", "levelId", "points", "maxPoints")}
                         for c in proposal.get("criteria") or []],
            "comment": proposal.get("comment"), "source": "proposal"}


def review(services: Any, batch: dict, student_ref: Optional[str] = None) -> dict:
    store = teacher_store(services)
    ctx = batch_context(services, batch)
    exam, questions = ctx["exam"], ctx["questions"]
    subs = [submission_of(services, batch, student_ref)] if student_ref else ctx["submissions"]
    rub_cache: dict[str, dict] = {}
    out = []
    for sub in subs:
        student = ctx["students"].get(sub["studentId"]) or {}
        version = core.find_version(exam, sub.get("version"))
        positions = {qid: i for i, qid in enumerate(version.get("questionOrder") or [], start=1)}
        rows = []
        for r in core.item_points(exam, questions, sub):
            q = questions.get(r["questionId"]) or {}
            row = {"position": positions.get(r["questionId"]), "questionId": r["questionId"], "type": r["type"],
                   "prompt": core._short(q.get("prompt"), 140), "maxPoints": r["maxPoints"],
                   "answer": answer_text((sub.get("answers") or {}).get(r["questionId"])),
                   "auto": r["auto"], "decision": r["decision"], "points": r["points"]}
            if r["type"] in core.OPEN_TYPES:
                proposal = store.get("proposal", proposal_id(sub["id"], r["questionId"]))
                if proposal:
                    rid = proposal.get("rubricId")
                    if rid and rid not in rub_cache:
                        rub_cache[rid] = store.get("rubric", rid) or {}
                    names = {c["id"]: c["name"] for c in rub_cache.get(rid, {}).get("criteria") or []}
                    row["proposal"] = {k: proposal.get(k) for k in ("status", "points", "maxPoints", "confidence",
                                                                     "droppedQuotes", "comment", "model", "note")}
                    row["proposal"]["criteria"] = [{**c, "name": names.get(c.get("criterionId"))}
                                                   for c in proposal.get("criteria") or []]
            rows.append(row)
        rows.sort(key=lambda x: x["position"] or 0)
        result = core.submission_result(exam, questions, sub, ctx["scale"])
        out.append({"submissionId": sub["id"], "student": student.get("displayName"), "studentId": sub["studentId"],
                    "version": sub.get("version"), "confirmed": bool(sub.get("confirmed")), "result": result,
                    "items": rows})
    return {"batchId": batch["id"], "title": batch.get("title"), "exam": exam.get("title"), "students": out,
            "pending": sum(1 for s in out if not s["confirmed"])}


def _parse_override(value: Any, rubric: Optional[dict], points: float) -> dict:
    """An override: a number of points, or {levels: {criterionId: levelId}, comment}."""
    if isinstance(value, (int, float)):
        return {"points": core.round2(max(-points, min(points, float(value)))), "source": "override"}
    if isinstance(value, str):
        try:
            return _parse_override(float(value.replace(",", ".")), rubric, points)
        except ValueError as error:
            raise ValueError(f"«{value}» is not a number of points.") from error
    if isinstance(value, dict):
        if value.get("levels") and rubric:
            result = core.rubric_breakdown(rubric, {str(k): str(v) for k, v in value["levels"].items()}, points)
            if not result["complete"]:
                raise ValueError("Pick a level for every criterion of the rubric.")
            return {"points": result["points"], "rubricId": rubric["id"], "criteria": result["criteria"],
                    "comment": value.get("comment"), "source": "override"}
        if value.get("points") is not None:
            out = _parse_override(value["points"], rubric, points)
            if value.get("comment"):
                out["comment"] = str(value["comment"])[:1000]
            return out
    raise ValueError("An override is a number of points or {levels:{criterionId: levelId}}.")


def confirm(services: Any, batch: dict, student_ref: str, *, accept_proposals: bool | list[str] = True,
            overrides: Optional[dict[str, Any]] = None, comment: Optional[str] = None,
            finalize: bool = True) -> dict:
    """Turn proposals and overrides into decisions; with finalize=True and nothing
    pending, the submission is confirmed with its grade and feedback."""
    store = teacher_store(services)
    ctx = batch_context(services, batch)
    exam, questions = ctx["exam"], ctx["questions"]
    sub = submission_of(services, batch, student_ref)
    version = core.find_version(exam, sub.get("version"))
    decisions = dict(sub.get("decisions") or {})
    now = services.now_iso()
    accept_ids = None if accept_proposals is True else set(accept_proposals or [])
    for item in exam.get("items") or []:
        qid = item["questionId"]
        if (questions.get(qid) or {}).get("type") not in core.OPEN_TYPES or qid in decisions:
            continue
        if accept_proposals is False or (accept_ids is not None and qid not in accept_ids):
            continue
        proposal = store.get("proposal", proposal_id(sub["id"], qid))
        decision = _decision_from_proposal(proposal) if proposal else None
        if decision:
            decisions[qid] = {**decision, "at": now}
    for key, value in (overrides or {}).items():
        qid = _resolve_question_key(exam, version, str(key))
        if qid is None:
            raise LookupError(f"«{key}» is not a question of the exam.")
        rubric = rubrics.rubric_for(services, exam, qid)
        points = float(next(i for i in exam["items"] if i["questionId"] == qid).get("points") or 0)
        decisions[qid] = {**_parse_override(value, rubric, points), "at": now}
    sub = {**sub, "decisions": decisions}
    if comment is not None:
        sub["comment"] = comment[:2000]
    result = core.submission_result(exam, questions, sub, ctx["scale"])
    if finalize and result["complete"]:
        topics = bank.topic_titles(services, exam["subjectId"])
        concepts = services.store.list("keyConcept", exam["subjectId"])
        rubs = {r["id"]: r for r in store.list("rubric", examId=exam["id"])}
        sub.update(confirmed=True, confirmedAt=now, result=result,
                   feedback=core.feedback(exam, questions, topics, concepts, sub, rubs))
    sub = store.put("submission", sub)
    subs = store.list("submission", batchId=batch["id"])
    if subs and all(s.get("confirmed") for s in subs):
        store.put("gradingBatch", {**(store.get("gradingBatch", batch["id"]) or batch), "status": "closed"})
    return {"submission": sub, "result": result, "confirmed": bool(sub.get("confirmed")),
            "pending": [p for p in result["pending"]]}


def report(services: Any, batch: dict) -> dict:
    ctx = batch_context(services, batch)
    exam, questions = ctx["exam"], ctx["questions"]
    rows = []
    for sub in ctx["submissions"]:
        student = ctx["students"].get(sub["studentId"]) or {}
        result = sub.get("result") if sub.get("confirmed") else core.submission_result(exam, questions, sub, ctx["scale"])
        rows.append({"student": student.get("displayName"), "studentId": sub["studentId"],
                     "version": sub.get("version"), "confirmed": bool(sub.get("confirmed")),
                     "points": result.get("points"), "maxPoints": result.get("maxPoints"),
                     "grade": result.get("grade") if sub.get("confirmed") else None,
                     "band": result.get("band") if sub.get("confirmed") else None,
                     "order": student.get("order")})
    rows.sort(key=lambda r: (r["order"] if r["order"] is not None else 10**6, normalize_text(r["student"] or "")))
    for r in rows:
        r.pop("order")
    return {"batchId": batch["id"], "title": batch.get("title"), "exam": exam.get("title"), "rows": rows,
            "csv": grades_csv(rows), "distribution": core.distribution([r["grade"] for r in rows if r["grade"] is not None],
                                                                       ctx["scale"])}


def grades_csv(rows: list[dict]) -> str:
    """Semicolon CSV (opens in a Spanish spreadsheet), decimal comma."""
    def cell(v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, float):
            return f"{v:g}".replace(".", ",")
        text = str(v)
        return '"' + text.replace('"', '""') + '"' if any(ch in text for ch in ';"\n') else text

    lines = ["Alumno;Versión;Puntos;Máximo;Nota;Calificación;Confirmada"]
    for r in rows:
        lines.append(";".join(cell(x) for x in (r["student"], r["version"], r["points"], r["maxPoints"], r["grade"],
                                                r["band"], "sí" if r["confirmed"] else "no")))
    return "\n".join(lines) + "\n"
