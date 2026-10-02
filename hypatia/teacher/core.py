"""Pure logic of the teacher role (no database, no model): grade scale, seeded
versions A/B, objective scoring of an exam sheet, rubric points, per-student
feedback, class analysis and the roster / answer-grid parsers.

`src/domain/teacherCore.ts` is the TypeScript twin used by the app; the parity
test (tests/teacher/test_parity_ts.py) runs both on the same inputs, so a grade
computed by Faustus through a tool and one computed in the app always agree.
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable

from ..hashing import normalize_text

LETTERS = "abcdefghijklmnopqrstuvwxyz"
VERSION_LABELS = "ABCD"
OBJECTIVE_TYPES = ("TEST", "COMPLETAR")
OPEN_TYPES = ("DESARROLLO", "PRACTICO")

DEFAULT_SCALE: dict[str, Any] = {
    "max": 10,
    "decimals": 1,
    "bands": [
        {"min": 0, "label": "Suspenso"},
        {"min": 5, "label": "Aprobado"},
        {"min": 7, "label": "Notable"},
        {"min": 9, "label": "Sobresaliente"},
    ],
}


# ---------------------------------------------------------------- rounding

def round_to(value: float, decimals: int) -> float:
    """Half-up rounding that the TypeScript twin reproduces bit for bit."""
    factor = 10 ** decimals
    if value < 0:
        return -round_to(-value, decimals)
    return math.floor(value * factor + 0.5 + 1e-9) / factor


def round2(value: float) -> float:
    return round_to(value, 2)


# ---------------------------------------------------------------- scale

def normalize_scale(scale: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(scale, dict):
        return {**DEFAULT_SCALE, "bands": [dict(b) for b in DEFAULT_SCALE["bands"]]}
    try:
        top = float(scale.get("max") or DEFAULT_SCALE["max"])
    except (TypeError, ValueError):
        top = 10.0
    try:
        decimals = int(scale.get("decimals") if scale.get("decimals") is not None else 1)
    except (TypeError, ValueError):
        decimals = 1
    bands = []
    for b in scale.get("bands") or []:
        if not isinstance(b, dict) or not str(b.get("label") or "").strip():
            continue
        try:
            bands.append({"min": float(b.get("min") or 0), "label": str(b["label"]).strip()})
        except (TypeError, ValueError):
            continue
    if not bands:
        bands = [dict(b) for b in DEFAULT_SCALE["bands"]]
    bands.sort(key=lambda b: b["min"])
    return {"max": top if top > 0 else 10.0, "decimals": max(0, min(3, decimals)), "bands": bands}


def grade_from_points(points: float, max_points: float, scale: dict[str, Any] | None = None) -> float | None:
    s = normalize_scale(scale)
    if not max_points or max_points <= 0:
        return None
    raw = s["max"] * max(0.0, points) / max_points
    return round_to(min(s["max"], raw), s["decimals"])


def band_of(grade: float | None, scale: dict[str, Any] | None = None) -> str | None:
    if grade is None:
        return None
    label = None
    for band in normalize_scale(scale)["bands"]:
        if grade + 1e-9 >= band["min"]:
            label = band["label"]
    return label


# ---------------------------------------------------------------- seeded shuffle

def hash32(text: str) -> int:
    """FNV-1a over the UTF-8 bytes (same as the TS `hash32`)."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _imul(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def mulberry32(seed: int):
    state = [seed & 0xFFFFFFFF]

    def rand() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        a = state[0]
        t = _imul(a ^ (a >> 15), 1 | a)
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & 0xFFFFFFFF) ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rand


def seeded_shuffle(items: list[Any], seed: str) -> list[Any]:
    out = list(items)
    rand = mulberry32(hash32(seed))
    for i in range(len(out) - 1, 0, -1):
        j = math.floor(rand() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out


# ---------------------------------------------------------------- versions

def build_versions(exam_id: str, question_ids: list[str], questions: dict[str, dict], count: int) -> list[dict]:
    """Version A keeps the teacher's order; B, C, D shuffle question order and the
    options of every TEST question (same content), seeded by exam id + label."""
    count = max(1, min(len(VERSION_LABELS), int(count or 1)))
    versions = []
    for k in range(count):
        label = VERSION_LABELS[k]
        order = list(question_ids) if k == 0 else seeded_shuffle(question_ids, f"{exam_id}:{label}:order")
        option_order: dict[str, list[str]] = {}
        for qid in question_ids:
            q = questions.get(qid) or {}
            if q.get("type") != "TEST":
                continue
            ids = [str(o.get("id")) for o in q.get("options") or []]
            option_order[qid] = ids if k == 0 else seeded_shuffle(ids, f"{exam_id}:{label}:{qid}")
        versions.append({"label": label, "questionOrder": order, "optionOrder": option_order})
    return versions


def find_version(exam: dict, label: str | None) -> dict:
    versions = exam.get("versions") or []
    for v in versions:
        if v.get("label") == (label or "A"):
            return v
    if versions:
        return versions[0]
    items = [i["questionId"] for i in exam.get("items") or []]
    return {"label": "A", "questionOrder": items, "optionOrder": {}}


def option_order_for(version: dict, question: dict) -> list[str]:
    order = (version.get("optionOrder") or {}).get(question.get("id"))
    if order:
        return list(order)
    return [str(o.get("id")) for o in question.get("options") or []]


def answer_key(exam: dict, questions: dict[str, dict], label: str) -> list[dict]:
    """One row per printed position: the correct letters (TEST), accepted blanks
    (COMPLETAR) or the model answer (open)."""
    version = find_version(exam, label)
    points = {i["questionId"]: i.get("points") for i in exam.get("items") or []}
    rows = []
    for pos, qid in enumerate(version.get("questionOrder") or [], start=1):
        q = questions.get(qid) or {}
        row: dict[str, Any] = {"position": pos, "questionId": qid, "type": q.get("type"), "points": points.get(qid)}
        if q.get("type") == "TEST":
            order = option_order_for(version, q)
            correct = set(q.get("correctOptionIds") or [])
            row["letters"] = [LETTERS[i] for i, oid in enumerate(order) if oid in correct]
        elif q.get("type") == "COMPLETAR":
            row["blanks"] = {b.get("id"): list(b.get("accepted") or []) for b in q.get("blanks") or []}
        else:
            row["modelAnswer"] = q.get("modelAnswer")
        rows.append(row)
    return rows


# ---------------------------------------------------------------- objective scoring

def letters_to_option_ids(raw: Any, order: list[str]) -> list[str] | None:
    """'b', 'A, c', 'ac', ['a','c'] -> original option ids. None if a letter is out of range."""
    if isinstance(raw, list):
        tokens = [str(t) for t in raw]
    else:
        text = str(raw or "").strip().lower()
        if not text:
            return []
        if re.fullmatch(r"[a-z]+", text):
            tokens = list(text)
        else:
            tokens = [t for t in re.split(r"[\s,;/+|]+", text) if t]
    ids: list[str] = []
    for token in tokens:
        token = token.strip().lower().strip(".)")
        if not token:
            continue
        if token.isdigit():
            index = int(token) - 1
        elif len(token) == 1 and token in LETTERS:
            index = LETTERS.index(token)
        else:
            return None
        if not 0 <= index < len(order):
            return None
        if order[index] not in ids:
            ids.append(order[index])
    return ids


def split_blanks(raw: Any, blanks: list[dict]) -> dict[str, str]:
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    values = raw if isinstance(raw, list) else re.split(r"\s*[;|]\s*", str(raw or ""))
    return {str(b.get("id")): (str(values[i]).strip() if i < len(values) else "") for i, b in enumerate(blanks)}


def score_objective(question: dict, answer: dict | None, points: float, version: dict,
                    penalty: float = 0.0) -> dict | None:
    """{result, points, selected?} for TEST/COMPLETAR (None for open questions).
    TEST: all-or-nothing set equality (scoring.ts#scoreTest); a wrong non-blank answer
    subtracts `penalty` × points. COMPLETAR: every blank must match (scoreCompletar)."""
    qtype = question.get("type")
    if qtype not in OBJECTIVE_TYPES:
        return None
    answer = answer or {}
    if qtype == "TEST":
        selected = answer.get("selectedOptionIds")
        if selected is None:
            selected = letters_to_option_ids(answer.get("letters"), option_order_for(version, question))
        if selected is None:
            return {"result": "INVALID", "points": 0.0, "selected": []}
        if not selected:
            return {"result": "BLANK", "points": 0.0, "selected": []}
        correct = set(question.get("correctOptionIds") or [])
        ok = set(selected) == correct
        value = points if ok else -abs(penalty) * points
        return {"result": "CORRECT" if ok else "WRONG", "points": round2(value), "selected": list(selected)}
    blanks = question.get("blanks") or []
    given = answer.get("blankAnswers")
    if given is None:
        given = split_blanks(answer.get("text"), blanks) if answer.get("text") not in (None, "") else {}
    if not any(str(v).strip() for v in given.values()):
        return {"result": "BLANK", "points": 0.0, "blankAnswers": given}
    for blank in blanks:
        user = normalize_text(given.get(str(blank.get("id")), "") or "")
        if user not in [normalize_text(a) for a in blank.get("accepted") or []]:
            return {"result": "WRONG", "points": 0.0, "blankAnswers": given}
    return {"result": "CORRECT", "points": round2(points), "blankAnswers": given}


# ---------------------------------------------------------------- rubrics

def criterion_max(criterion: dict) -> float:
    return max([float(l.get("points") or 0) for l in criterion.get("levels") or []] or [0.0])


def rubric_breakdown(rubric: dict, selections: dict[str, str], question_points: float) -> dict:
    """Points per criterion and total for chosen levels: each criterion is worth
    weight/Σweights of the question, scaled by level points / best level points."""
    criteria = rubric.get("criteria") or []
    weights = [max(0.0, float(c.get("weight") or 0)) for c in criteria]
    total_w = sum(weights) or float(len(criteria) or 1)
    if not sum(weights):
        weights = [1.0] * len(criteria)
    rows, total, complete = [], 0.0, True
    for c, w in zip(criteria, weights):
        share = question_points * w / total_w
        level = next((l for l in c.get("levels") or [] if l.get("id") == selections.get(c.get("id"))), None)
        best = criterion_max(c)
        if level is None:
            complete = False
            rows.append({"criterionId": c.get("id"), "levelId": None, "points": None, "maxPoints": round2(share)})
            continue
        got = share * (float(level.get("points") or 0) / best) if best > 0 else 0.0
        total += got
        rows.append({"criterionId": c.get("id"), "levelId": level.get("id"), "points": round2(got),
                     "maxPoints": round2(share)})
    return {"criteria": rows, "points": round2(total), "complete": complete}


def validate_rubric(rubric: dict) -> list[str]:
    """Problems that make a rubric unusable (empty list = fine)."""
    problems = []
    criteria = rubric.get("criteria") or []
    if not criteria:
        problems.append("La rúbrica no tiene criterios.")
    ids = set()
    for c in criteria:
        if not str(c.get("name") or "").strip():
            problems.append("Hay un criterio sin nombre.")
        if c.get("id") in ids:
            problems.append(f"Criterio repetido: {c.get('id')}.")
        ids.add(c.get("id"))
        levels = c.get("levels") or []
        if len(levels) < 2:
            problems.append(f"El criterio «{c.get('name')}» necesita al menos dos niveles.")
        if levels and criterion_max(c) <= 0:
            problems.append(f"El criterio «{c.get('name')}» no tiene ningún nivel con puntos.")
        try:
            if float(c.get("weight") or 0) < 0:
                problems.append(f"El criterio «{c.get('name')}» tiene peso negativo.")
        except (TypeError, ValueError):
            problems.append(f"El criterio «{c.get('name')}» tiene un peso no numérico.")
    return problems


# ---------------------------------------------------------------- a submission

def item_points(exam: dict, questions: dict[str, dict], submission: dict) -> list[dict]:
    """Per exam item: max points, the auto score (objective), the teacher's decision,
    and the points that count (decision > auto; None = still ungraded)."""
    version = find_version(exam, submission.get("version"))
    penalty = float((exam.get("spec") or {}).get("testPenalty") or 0)
    answers = submission.get("answers") or {}
    decisions = submission.get("decisions") or {}
    out = []
    for item in exam.get("items") or []:
        qid = item["questionId"]
        q = questions.get(qid) or {"id": qid, "type": None}
        max_pts = float(item.get("points") or 0)
        auto = score_objective(q, answers.get(qid), max_pts, version, penalty)
        decision = decisions.get(qid)
        final = None
        if decision and decision.get("points") is not None:
            final = round2(float(decision["points"]))
        elif auto is not None:
            final = auto["points"]
        out.append({"questionId": qid, "type": q.get("type"), "topicId": q.get("topicId"), "maxPoints": max_pts,
                    "auto": auto, "decision": decision, "points": final})
    return out


def submission_result(exam: dict, questions: dict[str, dict], submission: dict,
                      scale: dict[str, Any] | None = None) -> dict:
    rows = item_points(exam, questions, submission)
    max_points = round2(sum(r["maxPoints"] for r in rows))
    pending = [r["questionId"] for r in rows if r["points"] is None]
    points = round2(max(0.0, sum(r["points"] or 0 for r in rows)))
    grade = grade_from_points(points, max_points, scale)
    return {"points": points, "maxPoints": max_points, "grade": grade, "band": band_of(grade, scale),
            "pending": pending, "complete": not pending}


# ---------------------------------------------------------------- feedback

def _short(text: str | None, n: int = 90) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def feedback(exam: dict, questions: dict[str, dict], topics: dict[str, str], concepts: list[dict],
             submission: dict, rubrics: dict[str, dict] | None = None) -> dict:
    """Strengths, mistakes and what to review (topics + their key concepts), built
    only from the scores; nothing here is generated."""
    version = find_version(exam, submission.get("version"))
    positions = {qid: i for i, qid in enumerate(version.get("questionOrder") or [], start=1)}
    rubrics = rubrics or {}
    rows = item_points(exam, questions, submission)
    by_topic: dict[str, list[float]] = {}
    strengths, mistakes = [], []
    for r in rows:
        if r["points"] is None or not r["maxPoints"]:
            continue
        ratio = max(0.0, r["points"]) / r["maxPoints"]
        q = questions.get(r["questionId"]) or {}
        topic_id = q.get("topicId") or ""
        by_topic.setdefault(topic_id, []).append(ratio)
        entry = {"questionId": r["questionId"], "position": positions.get(r["questionId"]), "topicId": topic_id or None,
                 "topic": topics.get(topic_id), "prompt": _short(q.get("prompt")), "ratio": round2(ratio)}
        if ratio >= 0.7:
            strengths.append(entry)
        elif ratio < 0.5:
            entry["detail"] = _mistake_detail(q, r, version, rubrics)
            mistakes.append(entry)
    review = []
    for topic_id, ratios in by_topic.items():
        avg = sum(ratios) / len(ratios)
        if avg < 0.6:
            linked = [c for c in concepts if c.get("topicId") == topic_id and topic_id]
            linked.sort(key=lambda c: (c.get("category") or "", c.get("order") or 0, c.get("title") or ""))
            review.append({"topicId": topic_id or None, "topic": topics.get(topic_id), "ratio": round2(avg),
                           "keyConcepts": [{"id": c.get("id"), "title": c.get("title")} for c in linked[:5]]})
    review.sort(key=lambda t: (t["ratio"], t["topic"] or ""))
    strong_topics = sorted({topics.get(t) for t, rs in by_topic.items() if t and sum(rs) / len(rs) >= 0.7} - {None})
    return {"strengths": strengths, "strongTopics": strong_topics, "mistakes": mistakes, "review": review}


def _mistake_detail(question: dict, row: dict, version: dict, rubrics: dict[str, dict]) -> str:
    auto = row.get("auto") or {}
    if question.get("type") == "TEST":
        order = option_order_for(version, question)
        chosen = [LETTERS[order.index(i)] for i in auto.get("selected") or [] if i in order]
        correct = [LETTERS[i] for i, oid in enumerate(order) if oid in set(question.get("correctOptionIds") or [])]
        if not chosen:
            return f"En blanco; la correcta era {', '.join(correct)}."
        return f"Marcó {', '.join(chosen)}; la correcta era {', '.join(correct)}."
    if question.get("type") == "COMPLETAR":
        expected = "; ".join((b.get("accepted") or [""])[0] for b in question.get("blanks") or [])
        return f"Se esperaba: {expected}."
    decision = row.get("decision") or {}
    if decision.get("comment"):
        return _short(decision["comment"], 200)
    weak = []
    rubric = rubrics.get(decision.get("rubricId") or "") or {}
    names = {c.get("id"): c.get("name") for c in rubric.get("criteria") or []}
    for c in decision.get("criteria") or []:
        if c.get("points") is not None and c.get("maxPoints") and c["points"] < c["maxPoints"] / 2:
            weak.append(names.get(c.get("criterionId")) or str(c.get("criterionId")))
    if weak:
        return "Flojo en: " + ", ".join(weak) + "."
    return "Respuesta insuficiente frente a la respuesta modelo."


# ---------------------------------------------------------------- class analysis

def analyze(exam: dict, questions: dict[str, dict], topics: dict[str, str], submissions: list[dict],
            rubrics: dict[str, dict] | None = None, scale: dict[str, Any] | None = None,
            include_unconfirmed: bool = False) -> dict:
    """Success per question and per topic, common wrong options / blanks / weak
    criteria, and the grade distribution of the (confirmed) submissions."""
    rubrics = rubrics or {}
    s = normalize_scale(scale)
    used = [sub for sub in submissions if sub.get("confirmed") or include_unconfirmed]
    base_order = [i["questionId"] for i in exam.get("items") or []]
    per_item: dict[str, dict] = {}
    for pos, item in enumerate(exam.get("items") or [], start=1):
        q = questions.get(item["questionId"]) or {}
        per_item[item["questionId"]] = {
            "questionId": item["questionId"], "position": pos, "type": q.get("type"), "topicId": q.get("topicId"),
            "topic": topics.get(q.get("topicId") or ""), "prompt": _short(q.get("prompt")),
            "maxPoints": float(item.get("points") or 0), "answered": 0, "_sum": 0.0, "_wrong": {}, "_blank": {},
            "_criteria": {}}
    grades: list[float] = []
    for sub in used:
        version = find_version(exam, sub.get("version"))
        rows = item_points(exam, questions, sub)
        if any(r["points"] is None for r in rows):
            continue
        result = submission_result(exam, questions, sub, s)
        if result["grade"] is not None:
            grades.append(result["grade"])
        for r in rows:
            acc = per_item[r["questionId"]]
            acc["answered"] += 1
            acc["_sum"] += max(0.0, r["points"]) / r["maxPoints"] if r["maxPoints"] else 0.0
            q = questions.get(r["questionId"]) or {}
            auto = r.get("auto") or {}
            if q.get("type") == "TEST" and auto.get("result") == "WRONG":
                for oid in auto.get("selected") or []:
                    if oid not in set(q.get("correctOptionIds") or []):
                        acc["_wrong"][oid] = acc["_wrong"].get(oid, 0) + 1
            elif q.get("type") == "COMPLETAR" and auto.get("result") == "WRONG":
                for blank in q.get("blanks") or []:
                    given = normalize_text((auto.get("blankAnswers") or {}).get(str(blank.get("id")), "") or "")
                    if given and given not in [normalize_text(a) for a in blank.get("accepted") or []]:
                        acc["_blank"][given] = acc["_blank"].get(given, 0) + 1
            else:
                decision = r.get("decision") or {}
                for c in decision.get("criteria") or []:
                    if c.get("points") is not None and c.get("maxPoints") and c["points"] < c["maxPoints"] / 2:
                        key = str(c.get("criterionId"))
                        acc["_criteria"][key] = acc["_criteria"].get(key, 0) + 1
    rubric_names: dict[str, str] = {}
    for rub in rubrics.values():
        for c in rub.get("criteria") or []:
            rubric_names.setdefault(str(c.get("id")), c.get("name"))
    items_out = []
    for qid in base_order:
        acc = per_item[qid]
        q = questions.get(qid) or {}
        texts = {str(o.get("id")): o.get("text") for o in q.get("options") or []}
        out = {k: v for k, v in acc.items() if not k.startswith("_")}
        out["success"] = round2(acc["_sum"] / acc["answered"]) if acc["answered"] else None
        out["wrongOptions"] = [{"optionId": oid, "text": texts.get(oid), "count": n}
                               for oid, n in sorted(acc["_wrong"].items(), key=lambda kv: (-kv[1], kv[0]))]
        out["commonWrong"] = [{"answer": a, "count": n}
                              for a, n in sorted(acc["_blank"].items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
        out["weakCriteria"] = [{"criterionId": c, "name": rubric_names.get(c), "count": n}
                               for c, n in sorted(acc["_criteria"].items(), key=lambda kv: (-kv[1], kv[0]))]
        items_out.append(out)
    topic_acc: dict[str, list[float]] = {}
    for it in items_out:
        if it["success"] is None:
            continue
        key = it["topicId"] or ""
        acc = topic_acc.setdefault(key, [0.0, 0.0, 0])
        acc[0] += it["success"] * it["maxPoints"]
        acc[1] += it["maxPoints"]
        acc[2] += 1
    topics_out = [{"topicId": k or None, "topic": topics.get(k), "items": v[2],
                   "weight": round2(v[1]), "success": round2(v[0] / v[1]) if v[1] else None}
                  for k, v in topic_acc.items()]
    topics_out.sort(key=lambda t: (t["success"] if t["success"] is not None else 2, t["topic"] or ""))
    return {"examId": exam.get("id"), "submissions": len(used), "graded": len(grades), "items": items_out,
            "topics": topics_out, "worstTopic": topics_out[0] if topics_out else None,
            "distribution": distribution(grades, s)}


def distribution(grades: list[float], scale: dict[str, Any] | None = None) -> dict:
    s = normalize_scale(scale)
    bands = [{"label": b["label"], "min": b["min"], "count": 0} for b in s["bands"]]
    for g in grades:
        label = band_of(g, s)
        for b in bands:
            if b["label"] == label:
                b["count"] += 1
    bins = [0] * 10
    for g in grades:
        index = min(9, max(0, math.floor(g * 10 / s["max"]))) if s["max"] else 0
        bins[index] += 1
    ordered = sorted(grades)
    n = len(ordered)
    median = None
    if n:
        median = ordered[n // 2] if n % 2 else round2((ordered[n // 2 - 1] + ordered[n // 2]) / 2)
    pass_min = s["bands"][1]["min"] if len(s["bands"]) > 1 else s["max"] / 2
    return {"count": n, "mean": round2(sum(grades) / n) if n else None, "median": median,
            "passRate": round2(sum(1 for g in grades if g + 1e-9 >= pass_min) / n) if n else None,
            "bands": bands, "histogram": bins}


def combine_topics(analyses: Iterable[dict]) -> list[dict]:
    """Topic success across several exams of a class, weighted by points × answers."""
    acc: dict[str, list[Any]] = {}
    for a in analyses:
        answered = {it["topicId"]: it["answered"] for it in a.get("items") or []}
        for t in a.get("topics") or []:
            if t.get("success") is None:
                continue
            weight = (t.get("weight") or 0) * max(1, answered.get(t["topicId"], 1))
            row = acc.setdefault(t["topicId"] or "", [0.0, 0.0, t.get("topic"), 0])
            row[0] += t["success"] * weight
            row[1] += weight
            row[3] += 1
    out = [{"topicId": k or None, "topic": v[2], "exams": v[3], "success": round2(v[0] / v[1]) if v[1] else None}
           for k, v in acc.items()]
    out.sort(key=lambda t: (t["success"] if t["success"] is not None else 2, t["topic"] or ""))
    return out


# ---------------------------------------------------------------- parsers

_HEADER_WORDS = ("nombre", "name", "alumno", "alumna", "estudiante", "student", "apellidos", "apellido", "email",
                 "correo", "mail", "alias")


def _separator(line: str) -> str | None:
    counts = {sep: line.count(sep) for sep in ("\t", ";", ",")}
    sep, n = max(counts.items(), key=lambda kv: kv[1])
    return sep if n else None


def _cells(line: str, sep: str | None) -> list[str]:
    if sep is None:
        return [line.strip()]
    return [c.strip().strip('"').strip() for c in line.split(sep)]


def parse_roster(text: str) -> dict:
    """Pasted list / CSV -> {students: [{displayName, email?}], skipped: [...]}. One name
    per line, or columns with a header (nombre, apellidos, email/correo, alias)."""
    lines = [l for l in (text or "").replace("\r\n", "\n").split("\n") if l.strip()]
    if not lines:
        return {"students": [], "skipped": []}
    sep = _separator(lines[0])
    first = [normalize_text(c) for c in _cells(lines[0], sep)]
    header = None
    if any(c in _HEADER_WORDS for c in first):
        header = first
        lines = lines[1:]
    students, skipped, seen = [], [], set()
    for line in lines:
        cells = _cells(line, sep)
        email = next((c for c in cells if "@" in c), None)
        name = ""
        if header:
            def col(*names: str) -> str:
                for n in names:
                    if n in header and header.index(n) < len(cells):
                        return cells[header.index(n)]
                return ""
            name = col("alias") or " ".join(p for p in (col("nombre", "name", "alumno", "alumna", "estudiante", "student"),
                                                         col("apellidos", "apellido")) if p)
        else:
            plain = [c for c in cells if c and "@" not in c]
            if sep == "," and len(plain) == 2 and len(cells) == 2:
                name = f"{plain[1]} {plain[0]}"  # "Apellidos, Nombre"
            else:
                name = plain[0] if plain else ""
        name = re.sub(r"\s+", " ", name).strip()
        if not name:
            skipped.append(line.strip())
            continue
        key = normalize_text(name)
        if key in seen:
            skipped.append(line.strip())
            continue
        seen.add(key)
        student: dict[str, Any] = {"displayName": name}
        if email:
            student["email"] = email
        students.append(student)
    return {"students": students, "skipped": skipped}


_NAME_HEADERS = ("alumno", "alumna", "nombre", "name", "student", "estudiante")
_VERSION_HEADERS = ("version", "modelo", "model", "v")


def parse_answer_grid(text: str) -> dict:
    """CSV/TSV of answers: `alumno;version;1;2;3…` (header optional; positions are the
    printed numbers of the student's version) -> {rows: [{student, version, cells}], errors}."""
    lines = [l for l in (text or "").replace("\r\n", "\n").split("\n") if l.strip()]
    if not lines:
        return {"rows": [], "errors": []}
    sep = _separator(lines[0])
    head = [normalize_text(c) for c in _cells(lines[0], sep)]
    name_col, version_col, positions = 0, None, {}
    if head and head[0] in _NAME_HEADERS:
        for i, h in enumerate(head):
            if i == 0:
                continue
            if h in _VERSION_HEADERS:
                version_col = i
                continue
            m = re.fullmatch(r"(?:p|q|pregunta)?\s*(\d+)", h)
            if m:
                positions[i] = int(m.group(1))
        lines = lines[1:]
    rows, errors = [], []
    for n, line in enumerate(lines, start=1):
        cells = _cells(line, sep)
        if not cells or not cells[name_col]:
            errors.append(f"Línea {n}: sin nombre de alumno.")
            continue
        version = "A"
        if version_col is not None and version_col < len(cells) and cells[version_col]:
            version = cells[version_col].strip().upper()[:1]
        cell_map: dict[int, str] = {}
        if positions:
            for i, pos in positions.items():
                if i < len(cells) and cells[i].strip():
                    cell_map[pos] = cells[i].strip()
        else:
            for i, value in enumerate(cells[1:], start=1):
                if value.strip():
                    cell_map[i] = value.strip()
        rows.append({"student": cells[name_col], "version": version, "cells": cell_map})
    return {"rows": rows, "errors": errors}


def match_student(name: str, students: list[dict]) -> dict | None:
    key = normalize_text(name)
    exact = [s for s in students if normalize_text(s.get("displayName") or "") == key]
    if len(exact) == 1:
        return exact[0]
    loose = [s for s in students if key and (key in normalize_text(s.get("displayName") or "")
                                             or normalize_text(s.get("displayName") or "") in key)]
    return loose[0] if len(loose) == 1 else None


def grid_answers(exam: dict, questions: dict[str, dict], version_label: str, cells: dict[int, str]) -> dict[str, dict]:
    """Printed position -> stored answer by question id (letters for TEST, blanks for
    COMPLETAR, text for open questions)."""
    version = find_version(exam, version_label)
    order = version.get("questionOrder") or []
    out: dict[str, dict] = {}
    for pos, raw in cells.items():
        pos = int(pos)
        if not 1 <= pos <= len(order):
            continue
        qid = order[pos - 1]
        q = questions.get(qid) or {}
        if q.get("type") == "TEST":
            out[qid] = {"letters": str(raw).strip().lower(), "source": "grid"}
        elif q.get("type") == "COMPLETAR":
            out[qid] = {"blankAnswers": split_blanks(raw, q.get("blanks") or []), "source": "grid"}
        else:
            out[qid] = {"text": str(raw), "source": "grid"}
    return out
