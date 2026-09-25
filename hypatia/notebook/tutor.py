"""Socratic tutor grounded in the subject's sources and the student's weak questions."""

from __future__ import annotations

from typing import Any, Optional

from . import chats, llm, retrieval

MAX_FAILS = 3

TUTOR_SYSTEM = """Eres un tutor socrático de una asignatura universitaria. Hablas en español (salvo que el estudiante escriba en otro idioma), con tono cercano y breve.
Reglas:
- Nunca des la respuesta completa de entrada: guía con preguntas y pistas para que el estudiante llegue él mismo.
- Haz UNA sola pregunta por turno, concreta, y espera su respuesta.
- Evalúa con honestidad cada respuesta del estudiante (correcta, parcial o incorrecta) y dile brevemente qué está bien y qué falta, sin revelar la solución todavía.
- Basa todo en los pasajes numerados; cuando expliques algo, cita con [n] (solo números existentes). No inventes.
- Prioriza los puntos débiles del estudiante (preguntas que ha fallado); las respuestas esperadas que se te dan son internas: no las copies literalmente.
- Tras {max_fails} intentos fallidos sobre el mismo punto, explícalo brevemente con citas [n] y pasa a otra pregunta.
- Si el estudiante saluda o pide empezar, propone tú la primera pregunta sobre su punto más débil.
Devuelve SOLO JSON: {{"reply": "texto en Markdown para el estudiante", "assessment": "correct|partial|wrong|none", "point": "concepto que se está trabajando (pocas palabras)", "explained": true|false}}
- "assessment" evalúa el ÚLTIMO mensaje del estudiante ("none" si no respondía a una pregunta).
- "explained" es true solo si en este turno has explicado la respuesta."""

EXPLAIN_SYSTEM = """Eres un tutor. El estudiante ha fallado {max_fails} veces sobre el mismo punto. Explícalo ahora de forma breve y clara (4-8 frases) usando SOLO los pasajes numerados y citando con [n]; después haz UNA pregunta nueva y sencilla para comprobar que lo ha entendido. Responde solo con el texto para el estudiante, en Markdown, en español."""


def weak_questions(services: Any, subject_id: str, topic_id: Optional[str], limit: int = 5) -> list[dict[str, Any]]:
    """The student's weakest questions of a topic (or subject), from question stats."""
    try:
        questions = services.store.list("question", subject_id) or []
    except Exception:  # noqa: BLE001
        return []
    scored = []
    for q in questions:
        if topic_id and q.get("topicId") != topic_id and topic_id not in (q.get("topicIds") or []):
            continue
        st = q.get("stats") or {}
        seen, wrong, correct = int(st.get("seen") or 0), int(st.get("wrong") or 0), int(st.get("correct") or 0)
        if seen == 0:
            score = 0.35
        else:
            score = (wrong + 1) / (seen + 2)
        if st.get("lastResult") == "WRONG":
            score += 0.3
        if q.get("starred"):
            score += 0.2
        if seen > 0 and correct >= 3 and wrong == 0:
            score -= 0.2
        scored.append((score, q))
    scored.sort(key=lambda t: t[0], reverse=True)
    out = []
    for score, q in scored[:limit]:
        st = q.get("stats") or {}
        seen = int(st.get("seen") or 0)
        answer = q.get("modelAnswer") or ""
        if q.get("type") == "TEST" and q.get("options"):
            ok = set(q.get("correctOptionIds") or [])
            answer = "; ".join(o.get("text", "") for o in q["options"] if o.get("id") in ok)
        out.append({
            "id": q.get("id"), "prompt": q.get("prompt"), "type": q.get("type"), "expected": answer[:600] or None,
            "seen": seen, "accuracy": round((int(st.get("correct") or 0) / seen), 2) if seen else None,
            "lastResult": st.get("lastResult"), "weakness": round(score, 2),
        })
    return out


def _weak_block(weak: list[dict[str, Any]]) -> str:
    if not weak:
        return "(sin datos de preguntas falladas)"
    lines = []
    for w in weak:
        acc = "nunca vista" if w["seen"] == 0 else f"acierto {int((w['accuracy'] or 0) * 100)} % en {w['seen']}"
        lines.append(f"- {w['prompt']} ({acc}; último: {w.get('lastResult') or '—'})"
                     + (f"\n  Respuesta esperada (interna): {w['expected']}" if w.get("expected") else ""))
    return "\n".join(lines)


def turn(services: Any, subject_ref: str, message: str, *, topic: Optional[str] = None,
         chat_id: Optional[str] = None) -> dict[str, Any]:
    subject = services.resolve_subject(subject_ref)
    sid = subject["id"]
    message = (message or "").strip() or "Empecemos."
    topic_obj = services.resolve_topic(sid, topic) if topic else None
    title = f"Tutor · {topic_obj['title']}" if topic_obj else f"Tutor · {subject.get('name')}"
    chat = chats.get_or_create(services, chat_id, sid, "tutor", title, topic_obj["id"] if topic_obj else None)
    if not topic_obj and chat.get("topic_id"):
        try:
            topic_obj = services.resolve_topic(sid, chat["topic_id"])
        except LookupError:
            topic_obj = None
    state = dict(chat.get("state") or {})
    point = state.get("point")
    attempts = int(state.get("attempts") or 0)
    past = chats.history(services, chat["id"], 10)
    weak = weak_questions(services, sid, topic_obj["id"] if topic_obj else None)

    query_parts = [message]
    if point:
        query_parts.append(point)
    if topic_obj:
        query_parts.append(topic_obj.get("title") or "")
    if not past:
        query_parts.extend(w["prompt"] or "" for w in weak[:3])
    found = retrieval.search(services, sid, "\n".join(query_parts), topic=topic_obj["id"] if topic_obj else None, k=6)
    passages = found["passages"]
    base = {"chatId": chat["id"], "subjectId": sid, "topicId": topic_obj["id"] if topic_obj else None}

    user_block = (
        f"Tema: {topic_obj['title'] if topic_obj else 'toda la asignatura'}\n"
        f"Punto en curso: {point or '(ninguno)'}; intentos fallidos sobre él: {attempts}\n\n"
        f"Preguntas débiles del estudiante:\n{_weak_block(weak)}\n\n"
        f"Pasajes:\n\n{retrieval.format_passages(passages) if passages else '(no hay pasajes indexados)'}\n\n"
        f"Mensaje del estudiante: {message}"
    )
    messages: list[dict[str, Any]] = [{"role": "system", "content": TUTOR_SYSTEM.format(max_fails=MAX_FAILS)}]
    for m in past:
        if m["role"] in ("user", "assistant") and m["content"]:
            messages.append({"role": m["role"], "content": m["content"][:1500]})
    messages.append({"role": "user", "content": user_block})
    try:
        reply = llm.chat(services, messages, max_tokens=1500, temperature=0.4, json_mode=True)
    except llm.NoModel as exc:
        chats.add_message(services, chat["id"], "user", message)
        return {**base, "reply": None, "passages": [retrieval.public_passage(p) for p in passages], "weak": weak,
                "state": {"point": point, "attempts": attempts},
                "note": exc.note() + " Haz tú de tutor socrático: una pregunta cada vez, sin dar la respuesta "
                        f"de entrada; tras {MAX_FAILS} fallos en el mismo punto, explícalo citando [n]."}
    data = llm.parse_json(reply.text)
    if isinstance(data, dict) and isinstance(data.get("reply"), str):
        text = data["reply"]
        assessment = str(data.get("assessment") or "none").lower()
        new_point = (str(data.get("point") or "").strip() or point)
        explained = bool(data.get("explained"))
    else:  # model ignored the JSON format: use its text as the reply
        text, assessment, new_point, explained = reply.text, "none", point, False
    model = reply.model
    if assessment not in ("correct", "partial", "wrong", "none"):
        assessment = "none"

    if assessment in ("wrong", "partial"):
        same = not point or not new_point or new_point.strip().lower() == point.strip().lower()
        attempts = attempts + 1 if same else 1
    elif assessment == "correct":
        attempts = 0
    if new_point != point and assessment == "none":
        attempts = 0

    if attempts >= MAX_FAILS and not explained and passages:
        try:
            explain = llm.chat(services, [
                {"role": "system", "content": EXPLAIN_SYSTEM.format(max_fails=MAX_FAILS)},
                {"role": "user", "content": f"Punto: {new_point or message}\n\nPasajes:\n\n"
                                            f"{retrieval.format_passages(passages)}\n\n"
                                            f"Última respuesta del estudiante: {message}"},
            ], max_tokens=1200, temperature=0.3)
            text = explain.text
            model = explain.model or model
            explained = True
        except llm.NoModel:
            pass
    if explained:
        attempts = 0
        new_point = None if assessment != "none" else new_point

    text, citations = retrieval.apply_citations(text, passages)
    state = {"point": new_point, "attempts": attempts}
    chats.add_message(services, chat["id"], "user", message)
    chats.add_message(services, chat["id"], "assistant", text, citations,
                      {"model": model, "assessment": assessment, "explained": explained}, state=state)
    out = {**base, "reply": text, "citations": citations, "model": model, "assessment": assessment,
           "explained": explained, "state": state}
    if found["note"]:
        out["note"] = found["note"]
    return out
