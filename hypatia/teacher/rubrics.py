"""Rubrics: criteria with a weight and levels (descriptor + points), per question or
per exam. `propose` drafts one with the local model from the question and its model
answer; without a model it returns a deterministic template. Either way the teacher
edits it before saving (`save`)."""

from __future__ import annotations

from typing import Any, Optional

from . import core
from .store import new_id, teacher_store

PROPOSE_SYSTEM = (
    "Eres un profesor que diseña rúbricas de corrección. A partir de la pregunta, la respuesta modelo y los puntos, "
    "propón entre 2 y 5 criterios observables en la respuesta del alumno. Cada criterio tiene un peso (porcentaje, "
    "los pesos suman 100) y entre 3 y 4 niveles ordenados de peor a mejor, cada uno con un descriptor concreto "
    "(qué tiene que aparecer en la respuesta) y unos puntos (el peor 0, el mejor el máximo del criterio). "
    "No inventes contenido que no esté en la respuesta modelo. Responde SOLO con JSON: "
    '{"criteria":[{"name":"...","weight":40,"levels":[{"descriptor":"...","points":0},...]}]}'
)


def template(question: dict) -> dict:
    """A deterministic starting rubric (no model): content / precision / clarity, or
    approach / development / result for a practical question."""
    keywords = ", ".join((question.get("keywords") or [])[:6])
    if question.get("type") == "PRACTICO":
        result = f" ({question['numericAnswer']})" if question.get("numericAnswer") else ""
        criteria = [
            ("Planteamiento", 30, ["No plantea el problema", "Planteamiento incompleto o con errores",
                                   "Planteamiento correcto y justificado"]),
            ("Desarrollo y cálculo", 40, ["Sin desarrollo", "Desarrollo con errores importantes",
                                          "Desarrollo con errores menores", "Desarrollo correcto"]),
            ("Resultado", 30, ["Sin resultado o incorrecto", f"Resultado correcto{result}"]),
        ]
    else:
        content = "Todos los conceptos clave correctos" + (f" ({keywords})" if keywords else "")
        criteria = [
            ("Contenido y conceptos clave", 60, ["No aborda los conceptos pedidos", "Algunos conceptos, con errores",
                                                 "Casi todos los conceptos, sin errores graves", content]),
            ("Precisión y justificación", 25, ["Imprecisa o sin justificar", "Parcialmente justificada",
                                               "Precisa y bien justificada"]),
            ("Claridad y organización", 15, ["Desordenada o confusa", "Comprensible", "Clara y bien estructurada"]),
        ]
    out = []
    for i, (name, weight, levels) in enumerate(criteria, start=1):
        out.append({"id": f"c{i}", "name": name, "weight": weight,
                    "levels": [{"id": f"c{i}l{j}", "descriptor": d, "points": j} for j, d in enumerate(levels)]})
    return {"criteria": out}


def normalize(raw: Any) -> Optional[dict]:
    """Model/assistant JSON -> {criteria:[{id,name,weight,levels:[{id,descriptor,points}]}]} or None."""
    if isinstance(raw, list):
        raw = {"criteria": raw}
    if not isinstance(raw, dict):
        return None
    criteria = []
    for i, c in enumerate(raw.get("criteria") or raw.get("criterios") or [], start=1):
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or c.get("nombre") or "").strip()
        levels = []
        for j, l in enumerate(c.get("levels") or c.get("niveles") or []):
            if not isinstance(l, dict):
                continue
            try:
                points = max(0.0, float(l.get("points") if l.get("points") is not None else l.get("puntos")))
            except (TypeError, ValueError):
                continue
            descriptor = str(l.get("descriptor") or l.get("descripcion") or l.get("description") or "").strip()
            if descriptor:
                levels.append({"id": str(l.get("id") or f"c{i}l{j}"), "descriptor": descriptor[:600],
                               "points": core.round2(points)})
        levels.sort(key=lambda l: l["points"])
        try:
            weight = max(0.0, float(c.get("weight") if c.get("weight") is not None else c.get("peso") or 0))
        except (TypeError, ValueError):
            weight = 0.0
        if name and len(levels) >= 2:
            ids = set()
            for j, l in enumerate(levels):  # unique ids
                if l["id"] in ids:
                    l["id"] = f"c{i}l{j}"
                ids.add(l["id"])
            criteria.append({"id": str(c.get("id") or f"c{i}"), "name": name[:200], "weight": core.round2(weight),
                             "levels": levels})
    if not criteria:
        return None
    seen = set()
    for i, c in enumerate(criteria, start=1):
        if c["id"] in seen:
            c["id"] = f"c{i}"
        seen.add(c["id"])
    if not sum(c["weight"] for c in criteria):
        for c in criteria:
            c["weight"] = core.round2(100 / len(criteria))
    rubric = {"criteria": criteria}
    return None if core.validate_rubric(rubric) else rubric


def propose(services: Any, question: dict, points: float) -> dict:
    """{status: ok|no_model|invalid, rubric, model, note}. The rubric is a draft (not saved)."""
    from . import llm

    user = (f"Pregunta ({question.get('type')}, {points} puntos): {question.get('prompt') or ''}\n\n"
            f"Respuesta modelo: {question.get('modelAnswer') or '(no hay)'}\n"
            + (f"Resultado numérico: {question['numericAnswer']}\n" if question.get("numericAnswer") else "")
            + f"Palabras clave: {', '.join(question.get('keywords') or []) or '(ninguna)'}")
    try:
        reply = llm.chat(services, [{"role": "system", "content": PROPOSE_SYSTEM}, {"role": "user", "content": user}],
                         max_tokens=2500, temperature=0.2, json_mode=True, effort="medium")
    except llm.NoModel as exc:
        return {"status": "no_model", "rubric": {**template(question), "origin": "template"}, "model": None,
                "note": "No hay modelo local: se propone una plantilla fija para editar. " + exc.detail}
    rubric = normalize(llm.parse_json(reply.text))
    if rubric is None:
        return {"status": "invalid", "rubric": {**template(question), "origin": "template"}, "model": reply.model,
                "note": "El modelo no devolvió una rúbrica válida; se propone la plantilla fija para editar."}
    return {"status": "ok", "rubric": {**rubric, "origin": "llm"}, "model": reply.model, "note": None}


def save(services: Any, exam: dict, rubric: dict, *, question_id: Optional[str] = None,
         title: Optional[str] = None, rubric_id: Optional[str] = None) -> dict:
    """Store a rubric for one question of the exam (or the whole exam when no question)
    and link it from the item. Returns the saved rubric."""
    clean = normalize(rubric)
    if clean is None:
        problems = core.validate_rubric(rubric if isinstance(rubric, dict) else {}) or ["Rúbrica vacía o mal formada."]
        raise ValueError(" ".join(problems))
    store = teacher_store(services)
    if question_id and question_id not in [i["questionId"] for i in exam.get("items") or []]:
        raise LookupError("That question is not in the exam.")
    existing = None
    if rubric_id:
        existing = store.get("rubric", rubric_id)
    if existing is None:
        for r in store.list("rubric", examId=exam["id"]):
            if r.get("questionId") == question_id:
                existing = r
                break
    record = {**(existing or {}), "id": (existing or {}).get("id") or new_id(), "subjectId": exam["subjectId"],
              "examId": exam["id"], "questionId": question_id, "scope": "question" if question_id else "exam",
              "title": title or (existing or {}).get("title") or ("Rúbrica del examen" if not question_id else "Rúbrica"),
              "criteria": clean["criteria"], "origin": rubric.get("origin") or (existing or {}).get("origin") or "manual"}
    record = store.put("rubric", record)
    if question_id:
        items = [{**i, "rubricId": record["id"]} if i["questionId"] == question_id else i for i in exam["items"]]
        store.put("teacherExam", {**exam, "items": items})
    return record


def rubric_for(services: Any, exam: dict, question_id: str) -> Optional[dict]:
    """The question's own rubric, else the exam-wide one."""
    store = teacher_store(services)
    item = next((i for i in exam.get("items") or [] if i["questionId"] == question_id), None)
    if item and item.get("rubricId"):
        found = store.get("rubric", item["rubricId"])
        if found:
            return found
    exam_wide = None
    for r in store.list("rubric", examId=exam["id"]):
        if r.get("questionId") == question_id:
            return r
        if not r.get("questionId"):
            exam_wide = r
    return exam_wide
