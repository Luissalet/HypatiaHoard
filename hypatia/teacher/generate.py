"""Generate an exam from the teacher's material: questions from the bank and/or new
questions drafted by the local model from the subject's indexed sources, each
with the passage it comes from (file + page/section). Generated questions are
drafts: they reach the bank only when the teacher approves them.
"""

from __future__ import annotations

import math
import re
from typing import Any, Optional

from .. import bank
from ..hashing import slugify
from ..suggest import normalize_draft
from . import core, jobs
from .store import new_id, teacher_store

QTYPES = ("TEST", "DESARROLLO", "COMPLETAR", "PRACTICO")
DEFAULT_POINTS = {"TEST": 1.0, "COMPLETAR": 1.0, "DESARROLLO": 2.0, "PRACTICO": 2.0}
TYPE_LABEL = {"TEST": "test", "DESARROLLO": "desarrollo", "COMPLETAR": "completar", "PRACTICO": "práctico"}
MATERIAL_CHARS = 12_000
GEN_MAX_TOKENS = 6000


def difficulty_bucket(question: dict) -> str:
    d = question.get("difficulty")
    if isinstance(d, (int, float)):
        if d <= 2:
            return "easy"
        if d >= 4:
            return "hard"
    return "medium"


def _allocation(n: int, mix: Optional[dict]) -> dict[str, int]:
    if not mix or n <= 0:
        return {"any": n}
    total = sum(max(0.0, float(mix.get(k) or 0)) for k in ("easy", "medium", "hard")) or 1.0
    easy = round(n * max(0.0, float(mix.get("easy") or 0)) / total)
    hard = round(n * max(0.0, float(mix.get("hard") or 0)) / total)
    easy = min(easy, n)
    hard = min(hard, n - easy)
    return {"easy": easy, "medium": n - easy - hard, "hard": hard}


def select_from_bank(services: Any, subject_id: str, topic_ids: list[str], counts: dict[str, int],
                     mix: Optional[dict], seed: str, exclude: set[str] | None = None) -> tuple[list[dict], dict[str, int]]:
    """Pick questions per type and difficulty bucket (seeded); returns (questions, shortfall per type)."""
    exclude = exclude or set()
    questions = services.store.list("question", subject_id)
    if topic_ids:
        wanted = set(topic_ids)
        questions = [q for q in questions if q.get("topicId") in wanted or wanted & set(q.get("topicIds") or [])]
    chosen: list[dict] = []
    shortfall: dict[str, int] = {}
    for qtype in QTYPES:
        n = int(counts.get(qtype) or 0)
        if n <= 0:
            continue
        pool = [q for q in questions if q.get("type") == qtype and q["id"] not in exclude]
        pool = core.seeded_shuffle(sorted(pool, key=lambda q: q["id"]), f"{seed}:pick:{qtype}")
        taken: list[dict] = []
        for bucket, k in _allocation(n, mix).items():
            cands = [q for q in pool if q not in taken and (bucket == "any" or difficulty_bucket(q) == bucket)]
            taken += cands[:k]
        if len(taken) < n:  # not enough at that difficulty: any other of the type
            taken += [q for q in pool if q not in taken][: n - len(taken)]
        if len(taken) < n:
            shortfall[qtype] = n - len(taken)
        chosen += taken
    return chosen, shortfall


def _points_for(spec: dict, qtype: str) -> float:
    given = (spec.get("pointsByType") or {}).get(qtype)
    try:
        value = float(given) if given is not None else DEFAULT_POINTS[qtype]
    except (TypeError, ValueError):
        value = DEFAULT_POINTS[qtype]
    return core.round2(max(0.0, value))


def questions_by_id(services: Any, ids: list[str]) -> dict[str, dict]:
    out = {}
    for qid in ids:
        q = services.store.get("question", qid)
        if q is not None:
            out[qid] = q
    return out


def refresh(services: Any, exam: dict) -> dict:
    """Rebuild versions A/B… from the items and keep the practice exam (the app's Exam
    entity, so the same questions can be practised) in step. Returns the exam (not saved)."""
    ids = [i["questionId"] for i in exam.get("items") or []]
    questions = questions_by_id(services, ids)
    exam["versions"] = core.build_versions(exam["id"], ids, questions, (exam.get("spec") or {}).get("versions") or 1)
    if ids:
        now = services.now_iso()
        practice_id = exam.get("practiceExamId")
        practice = services.store.get("exam", practice_id) if practice_id else None
        record = {**(practice or {}), "id": practice_id or bank.new_id(), "subjectId": exam["subjectId"],
                  "name": exam.get("title") or "Examen", "questionIds": ids,
                  "description": f"Examen del profesor ({len(ids)} preguntas).", "updatedAt": now}
        record.setdefault("createdAt", now)
        if practice is None or practice.get("questionIds") != ids or practice.get("name") != record["name"]:
            services.store.put("exam", record)
        exam["practiceExamId"] = record["id"]
    return exam


def create_exam(services: Any, spec: dict[str, Any], *, title: Optional[str] = None, header: Optional[dict] = None,
                class_id: Optional[str] = None) -> dict:
    """Build the exam record and fill it from the bank; queue a generation job for what
    the model must draft. Returns {exam, job, shortfall, notes}."""
    store = teacher_store(services)
    subject = services.store.get("subject", spec["subjectId"])
    if subject is None:
        raise LookupError("The exam's subject does not exist.")
    counts = {t: max(0, int((spec.get("counts") or {}).get(t) or 0)) for t in QTYPES}
    if not sum(counts.values()):
        raise ValueError("Ask for at least one question (counts by type).")
    source = spec.get("source") or "bank"
    if source not in ("bank", "generate", "mixed"):
        raise ValueError("source must be bank, generate or mixed.")
    exam_id = new_id()
    topic_ids = list(spec.get("topicIds") or [])
    titles = {t["id"]: t.get("title") for t in services.topics_of(subject["id"])}
    label = ", ".join(titles.get(t) or t for t in topic_ids) if topic_ids else subject.get("name")
    exam: dict[str, Any] = {
        "id": exam_id, "subjectId": subject["id"], "title": (title or "").strip() or f"Examen · {label}",
        "status": "draft", "classId": class_id,
        "header": {"centre": "", "course": "", "date": "", "instructions": "", "durationMin": None, **(header or {})},
        "spec": {**spec, "counts": counts, "source": source, "topicIds": topic_ids,
                 "versions": max(1, min(4, int(spec.get("versions") or 1)))},
        "items": [], "drafts": [], "notes": [],
    }
    shortfall: dict[str, int] = {}
    if source in ("bank", "mixed"):
        picked, shortfall = select_from_bank(services, subject["id"], topic_ids, counts, spec.get("difficulty"), exam_id)
        exam["items"] = [{"questionId": q["id"], "points": _points_for(spec, q["type"])} for q in picked]
    to_generate = dict(counts) if source == "generate" else (shortfall if source == "mixed" else {})
    if source == "bank" and shortfall:
        exam["notes"].append("Faltan preguntas en el banco: " + ", ".join(
            f"{n} de {TYPE_LABEL[t]}" for t, n in shortfall.items()) + ".")
    exam = refresh(services, exam)
    exam = store.put("teacherExam", exam)
    job = None
    if sum(to_generate.values()):
        job = jobs.create(services, "exam_generate", {"examId": exam_id, "counts": to_generate})
        exam = store.put("teacherExam", {**exam, "jobId": job["id"]})
    try:
        from ..hoard_link import family

        family.emit("hypatia.teacher_exam.created", {"id": exam_id, "title": exam["title"]})
    except Exception:  # noqa: BLE001
        pass
    return {"exam": exam, "job": job, "shortfall": shortfall, "notes": exam["notes"]}


# ---------------------------------------------------------------- model drafting

GEN_SYSTEM = (
    "Eres un profesor que redacta preguntas de examen SOLO a partir de los pasajes numerados que se te dan "
    "(material del propio profesor). Reglas: cada pregunta evalúa un único concepto que aparece en los pasajes; "
    "nunca inventes nada que no esté en ellos; escribe en español. "
    "TEST: el enunciado va en \"prompt\" SIN las opciones; \"options\" es una lista de 4 objetos "
    "{\"id\": \"a\", \"text\": \"texto completo de la opción\"} (ids 'a','b','c','d'; el texto nunca es solo la letra) "
    "y \"correctOptionIds\" la lista de ids correctos, p. ej. [\"b\"]. "
    "DESARROLLO/PRACTICO: modelAnswer completa y keywords (3-6). COMPLETAR: clozeText con huecos '{{blank1}}'... y "
    "blanks [{\"id\":\"blank1\",\"accepted\":[...]}]. "
    "Cada pregunta lleva \"cita\": los números [n] de los pasajes de los que sale el enunciado, y \"citaRespuesta\": "
    "los números de los pasajes que justifican la respuesta correcta. difficulty 1-5. "
    "Responde SOLO con JSON: {\"questions\": [{\"type\",\"prompt\",\"options\",\"correctOptionIds\",\"modelAnswer\","
    "\"keywords\",\"clozeText\",\"blanks\",\"explanation\",\"difficulty\",\"cita\",\"citaRespuesta\"}]}."
)

_STR_LIST = {"type": "array", "items": {"type": "string"}}
_INT_LIST = {"type": "array", "items": {"type": "integer"}}
GEN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": list(QTYPES)},
            "prompt": {"type": "string"},
            "options": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string"}, "text": {"type": "string"}}, "required": ["id", "text"]}},
            "correctOptionIds": _STR_LIST,
            "modelAnswer": {"type": "string"},
            "keywords": _STR_LIST,
            "clozeText": {"type": "string"},
            "blanks": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string"}, "accepted": _STR_LIST}, "required": ["id", "accepted"]}},
            "explanation": {"type": "string"},
            "difficulty": {"type": "integer"},
            "cita": _INT_LIST,
            "citaRespuesta": _INT_LIST,
        },
        "required": ["type", "prompt", "cita"],
    }}},
    "required": ["questions"],
}

_OPTION_ALIASES = ("options", "opciones", "choices", "alternativas", "answers", "respuestas")
DROP_SAMPLES = 3


def _excerpt(value: Any, n: int = 400) -> str:
    import json as _json

    try:
        text = _json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    return text if len(text) <= n else text[: n - 1] + "…"


def read_generated(text: str, budget: dict[str, int], passages: list[dict]) -> tuple[list[dict], list[dict]]:
    """Model reply -> (accepted items [{question, cites, answerCites}], drops [{reason, excerpt}]).
    TEST options are read in any shape (hypatia/options.py) and every TEST draft must pass
    options.invalid_test_reason: when the options are missing it tries the "a) …" lines of the stem,
    and otherwise the draft is dropped with its reason (a broken draft is never shown)."""
    from . import llm
    from ..options import correct_from_item, normalize_options, options_from_prompt, invalid_test_reason

    data = llm.parse_json(text)
    if isinstance(data, dict):
        data = data.get("questions") or data.get("preguntas") or data.get("items") or (
            [data] if data.get("prompt") else [])
    if not isinstance(data, list):
        return [], [{"reason": "la respuesta no es JSON", "excerpt": (text or "")[:400]}]
    valid = {p["n"]: p for p in passages}
    left = dict(budget)
    accepted, drops = [], []
    for item in data:
        if not isinstance(item, dict):
            drops.append({"reason": "no es una pregunta", "excerpt": _excerpt(item)})
            continue
        qtype = str(item.get("type") or item.get("tipo") or "").upper()
        if qtype not in left:
            drops.append({"reason": "tipo no pedido", "excerpt": _excerpt(item)})
            continue
        if left[qtype] <= 0:
            drops.append({"reason": "sobra (ya hay las pedidas de su tipo)", "excerpt": _excerpt(item)})
            continue
        raw = {**item, "type": qtype}
        if not raw.get("prompt") and raw.get("enunciado"):
            raw["prompt"] = raw["enunciado"]
        if qtype == "TEST":
            raw_options = next((raw[k] for k in _OPTION_ALIASES if raw.get(k) not in (None, "", [], {})), None)
            options, id_map, flagged = normalize_options(raw_options)
            candidate = {"options": options, "correctOptionIds": correct_from_item(raw, options, id_map, flagged)}
            problem = invalid_test_reason(candidate)
            if problem:  # repair: options written inside the stem
                inline = options_from_prompt(str(raw.get("prompt") or ""))
                if inline:
                    stem, opts = inline
                    _, inline_map, _ = normalize_options(opts)
                    repaired = {"options": opts, "correctOptionIds": correct_from_item(raw, opts, inline_map, [])}
                    if not invalid_test_reason(repaired):
                        raw["prompt"], candidate, problem = stem, repaired, None
            if problem:
                drops.append({"reason": f"test inválido: {problem}", "excerpt": _excerpt(item)})
                continue
            raw = {**raw, **candidate}
        q = normalize_draft(raw, [qtype])
        if q is None:
            drops.append({"reason": "no tiene la forma de una pregunta", "excerpt": _excerpt(item)})
            continue
        cites = _cites(item.get("cita") or item.get("cite") or item.get("citas"), valid)
        if not cites:
            drops.append({"reason": "sin cita a un pasaje válido", "excerpt": _excerpt(item)})
            continue
        left[qtype] -= 1
        accepted.append({"question": q, "cites": cites,
                         "answerCites": _cites(item.get("citaRespuesta") or item.get("answerCite"), valid)})
    return accepted, drops


def _pick_passages(passages: list[dict], limit: int = MATERIAL_CHARS) -> list[dict]:
    """Spread the budget over the whole material (every k-th passage), renumbered 1..n."""
    total = sum(len(p["text"]) for p in passages)
    chosen = passages if total <= limit else passages[:: math.ceil(total / limit)]
    kept, used = [], 0
    for p in chosen:
        if kept and used + len(p["text"]) > limit:
            break
        kept.append(p)
        used += len(p["text"])
    return [{**p, "n": i} for i, p in enumerate(kept, start=1)]


def _cites(value: Any, valid: dict[int, dict]) -> list[dict]:
    nums: list[int] = []
    if isinstance(value, (int, float)):
        value = [value]
    if isinstance(value, str):
        value = re.findall(r"\d+", value)
    for v in value or []:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n in valid and n not in nums:
            nums.append(n)
    from ..notebook.retrieval import citation

    return [citation(valid[n]) for n in nums]


def _wanted(counts: dict[str, int]) -> str:
    return ", ".join(f"{n} de tipo {t}" for t, n in counts.items() if n)


def _split_counts(counts: dict[str, int], groups: int) -> list[dict[str, int]]:
    """Distribute per-type counts over `groups` topics, round robin."""
    out = [{t: 0 for t in counts} for _ in range(max(1, groups))]
    i = 0
    for t in QTYPES:
        for _ in range(int(counts.get(t) or 0)):
            out[i % len(out)][t] += 1
            i += 1
    return out


@jobs.handler("exam_generate")
def run_generation(services: Any, params: dict, ctx: jobs.Context) -> tuple[str, Any, Optional[str]]:
    from ..notebook import retrieval
    from . import llm

    store = teacher_store(services)
    exam = store.get("teacherExam", params["examId"])
    if exam is None:
        raise LookupError("The exam no longer exists.")
    subject_id = exam["subjectId"]
    topic_ids = list((exam.get("spec") or {}).get("topicIds") or []) or [None]
    plan = _split_counts({k: int(v) for k, v in (params.get("counts") or {}).items()}, len(topic_ids))
    materials = []
    for topic_id, want in zip(topic_ids, plan):
        if not sum(want.values()):
            continue
        mat = retrieval.material(services, subject_id, topic=topic_id)
        if mat["passages"]:
            materials.append((topic_id, want, _pick_passages(mat["passages"]), mat["scope"].get("note")))
    if not materials:
        note = "No hay fuentes indexadas en el Cuaderno para estos temas: añade los PDF del profesor y vuelve a generar."
        return "no_sources", {"examId": exam["id"], "generated": 0}, note
    ok, _model, reason = llm.resolve(services, "llm")
    if not ok:
        text = "\n\n".join(retrieval.format_passages(p, 600) for _, _, p, _ in materials)[:30_000]
        return "no_model", {"examId": exam["id"], "generated": 0, "material": text}, (
            f"No hay modelo local ({reason}). No se ha generado nada; redacta las preguntas a partir de `material`.")
    drafts, drops, model, notes = [], [], None, []
    for step, (topic_id, want, passages, scope_note) in enumerate(materials):
        ctx.progress(step, len(materials), "Redactando preguntas")
        if scope_note:
            notes.append(scope_note)
        prompt = (f"Genera exactamente {_wanted(want)}.\n"
                  + (f"Dificultad deseada (porcentaje): {exam['spec'].get('difficulty')}.\n"
                     if exam["spec"].get("difficulty") else "")
                  + "\nPasajes:\n\n" + retrieval.format_passages(passages))
        try:
            reply = llm.chat(services, [{"role": "system", "content": GEN_SYSTEM}, {"role": "user", "content": prompt}],
                             max_tokens=GEN_MAX_TOKENS, temperature=0.3, effort="high", schema=GEN_SCHEMA,
                             schema_name="preguntas")
        except llm.NoModel as exc:
            return "no_model", {"examId": exam["id"], "generated": len(drafts)}, exc.note()
        model = reply.model or model
        llm.log.debug("exam_generate reply (%s, format %s): %s", reply.model, reply.format, reply.text[:4000])
        accepted, dropped_here = read_generated(reply.text, want, passages)
        drops += dropped_here
        for a in accepted:
            q = a["question"]
            drafts.append({"id": new_id(), "type": q["type"], "question": q, "topicId": topic_id,
                           "points": _points_for(exam.get("spec") or {}, q["type"]),
                           "citations": a["cites"], "answerCitations": a["answerCites"],
                           "status": "pending", "model": reply.model, "createdAt": services.now_iso()})
    ctx.progress(len(materials), len(materials), "Hecho")
    exam = store.get("teacherExam", params["examId"]) or exam
    exam = store.put("teacherExam", {**exam, "drafts": (exam.get("drafts") or []) + drafts,
                                     "notes": (exam.get("notes") or []) + notes})
    reasons: dict[str, int] = {}
    for d in drops:
        reasons[d["reason"]] = reasons.get(d["reason"], 0) + 1
    note = None
    if drops:
        llm.log.info("exam_generate dropped %d drafts: %s", len(drops), reasons)
        note = f"{len(drops)} propuestas descartadas: " + "; ".join(f"{n} {r}" for r, n in reasons.items()) + "."
    if not drafts:
        note = (note + " " if note else "") + "El modelo no produjo ninguna pregunta válida y citada."
    return "done", {"examId": exam["id"], "generated": len(drafts), "dropped": len(drops), "dropReasons": reasons,
                    "dropSamples": drops[:DROP_SAMPLES], "model": model}, note


# ---------------------------------------------------------------- drafts -> bank

def _source_line(cites: list[dict]) -> str:
    parts = []
    for c in cites[:3]:
        where = c.get("filename") or ""
        if c.get("page"):
            where += f", p. {c['page']}"
        parts.append(where)
    return "Fuente: " + "; ".join(parts) if parts else ""


def review_drafts(services: Any, exam_id: str, accept: list[str], reject: list[str]) -> dict:
    """Approve drafts into the bank (and the exam), or reject them."""
    store = teacher_store(services)
    exam = store.get("teacherExam", exam_id)
    if exam is None:
        raise LookupError(f"No teacher exam {exam_id}.")
    subject = services.store.get("subject", exam["subjectId"])
    if subject is None:
        raise LookupError("The exam's subject no longer exists.")
    accept_set, reject_set = set(accept or []), set(reject or [])
    unknown = (accept_set | reject_set) - {d["id"] for d in exam.get("drafts") or []}
    if unknown:
        raise LookupError("Unknown draft ids: " + ", ".join(sorted(unknown)))
    from ..options import invalid_test_reason

    added, existing, invalid = [], [], []
    items = list(exam.get("items") or [])
    drafts = []
    for d in exam.get("drafts") or []:
        d = dict(d)
        problem = invalid_test_reason(d["question"]) if d.get("type") == "TEST" else None
        if d["id"] in accept_set and d.get("status") == "pending" and problem:
            d.update(status="rejected", rejectedReason=f"test inválido: {problem}")  # never into the bank
            invalid.append(d["id"])
        elif d["id"] in accept_set and d.get("status") == "pending":
            topic = None
            if d.get("topicId"):
                topic = services.store.get("topic", d["topicId"])
            topic = topic or bank.ensure_topic(services, subject["id"], None)
            data = dict(d["question"])
            line = _source_line(d.get("citations") or [])
            if line:
                data["explanation"] = (data.get("explanation") + "\n\n" if data.get("explanation") else "") + line
            data["tags"] = sorted(set((data.get("tags") or []) + ["profesor"]))
            q, was = bank.add_question(services, subject, topic, data, origin="test")
            (existing if was else added).append(q["id"])
            d.update(status="approved", questionId=q["id"])
            if q["id"] not in [i["questionId"] for i in items]:
                items.append({"questionId": q["id"], "points": d.get("points") or DEFAULT_POINTS[q["type"]]})
        elif d["id"] in reject_set and d.get("status") == "pending":
            d["status"] = "rejected"
        drafts.append(d)
    exam = refresh(services, {**exam, "items": items, "drafts": drafts})
    exam = store.put("teacherExam", exam)
    return {"exam": exam, "added": added, "existing": existing, "rejected": sorted(reject_set), "invalid": invalid}


def exam_view(services: Any, exam: dict, with_answers: bool = True) -> dict:
    """The exam as the assistant needs it: items in order with prompts, versions, keys, drafts."""
    ids = [i["questionId"] for i in exam.get("items") or []]
    questions = questions_by_id(services, ids)
    titles = bank.topic_titles(services, exam.get("subjectId"))
    items = []
    for pos, item in enumerate(exam.get("items") or [], start=1):
        q = questions.get(item["questionId"])
        row = {"position": pos, "questionId": item["questionId"], "points": item.get("points"),
               "rubricId": item.get("rubricId")}
        if q is None:
            row["missing"] = True
        else:
            row.update(bank.brief(q, with_answers, titles))
            row.pop("stats", None)
        items.append(row)
    out = {k: exam.get(k) for k in ("id", "title", "status", "subjectId", "classId", "header", "spec", "notes",
                                     "practiceExamId", "jobId", "createdAt", "updatedAt")}
    out["items"] = items
    out["maxPoints"] = core.round2(sum(float(i.get("points") or 0) for i in exam.get("items") or []))
    out["versions"] = [{"label": v["label"], "questionOrder": v["questionOrder"]} for v in exam.get("versions") or []]
    if with_answers:
        out["answerKeys"] = {v["label"]: core.answer_key(exam, questions, v["label"]) for v in exam.get("versions") or []}
    from ..options import invalid_test_reason

    out["drafts"] = []
    for d in exam.get("drafts") or []:
        row = {k: d.get(k) for k in ("id", "type", "status", "topicId", "points", "citations", "answerCitations",
                                     "questionId", "rejectedReason")}
        row["prompt"] = d["question"].get("prompt")
        if d.get("type") == "TEST":
            row["options"] = d["question"].get("options")
            row["correctOptionIds"] = d["question"].get("correctOptionIds")
            row["problem"] = invalid_test_reason(d["question"])
        out["drafts"].append(row)
    return out


def find_exam(services: Any, ref: str) -> dict:
    store = teacher_store(services)
    ref = (ref or "").strip()
    exams = store.list("teacherExam")
    if not exams:
        raise LookupError("There are no teacher exams yet (exam_generate).")
    for e in exams:
        if e["id"] == ref:
            return e
    slug = slugify(ref)
    for match in (lambda e: slugify(e.get("title") or "") == slug,
                  lambda e: slug and slugify(e.get("title") or "").startswith(slug),
                  lambda e: slug and slug in slugify(e.get("title") or "")):
        found = [e for e in exams if match(e)]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            found.sort(key=lambda e: e.get("createdAt") or "", reverse=True)
            return found[0]
    names = "; ".join(e.get("title") or e["id"] for e in sorted(exams, key=lambda e: e.get("createdAt") or ""))
    raise LookupError(f"No teacher exam matches «{ref}». Exams: {names}.")
