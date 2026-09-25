"""Grounded Q&A over a subject's sources, with `[n]` citations mapped to real chunks."""

from __future__ import annotations

from typing import Any, Optional

from . import chats, llm, retrieval

ASK_SYSTEM = """Eres el asistente de estudio de un estudiante universitario. Respondes SOLO con la información de los pasajes numerados que se te dan (extraídos de sus apuntes y temas).
Reglas:
- Cita cada afirmación con el número del pasaje entre corchetes, p. ej. [2] o [1][3]. Usa solo números de pasajes que existan.
- No inventes nada que no esté en los pasajes. Si los pasajes no cubren la pregunta (o solo en parte), dilo claramente ("Las fuentes no tratan…") y responde solo lo que sí cubren.
- Responde en español, salvo que la pregunta esté escrita en otro idioma: entonces responde en ese idioma.
- Sé claro y didáctico; usa Markdown (listas, negritas) y LaTeX ($...$) cuando ayude. Nada de preámbulos."""

NO_PASSAGES_ANSWER = ("No encuentro nada sobre esto en las fuentes indexadas de la asignatura. "
                      "Prueba a reformular la pregunta, elegir otro tema o añadir fuentes.")


def ask(services: Any, subject_ref: str, question: str, *, topic: Optional[str] = None,
        source_ids: Optional[list[str]] = None, chat_id: Optional[str] = None, k: int = 8,
        persist: bool = True) -> dict[str, Any]:
    subject = services.resolve_subject(subject_ref)
    sid = subject["id"]
    question = (question or "").strip()
    if not question:
        raise ValueError("La pregunta está vacía")
    chat = None
    past: list[dict[str, Any]] = []
    if persist:
        topic_id = services.resolve_topic(sid, topic)["id"] if topic else None
        chat = chats.get_or_create(services, chat_id, sid, "sources", question, topic_id)
        past = chats.history(services, chat["id"], 6)
    query = question
    if past:
        last_user = next((m["content"] for m in reversed(past) if m["role"] == "user"), "")
        query = f"{question}\n{last_user}"
    found = retrieval.search(services, sid, query, topic=topic, source_ids=source_ids, k=k)
    passages = found["passages"]
    base = {"chatId": chat["id"] if chat else None, "subjectId": sid}
    if not passages:
        answer = NO_PASSAGES_ANSWER
        if chat:
            chats.add_message(services, chat["id"], "user", question)
            chats.add_message(services, chat["id"], "assistant", answer, [], {"model": None})
        return {**base, "answer": answer, "citations": [], "passages": [], "model": None,
                "note": found["note"]}

    messages: list[dict[str, Any]] = [{"role": "system", "content": ASK_SYSTEM}]
    for m in past:
        if m["role"] in ("user", "assistant") and m["content"]:
            messages.append({"role": m["role"], "content": m["content"][:2000]})
    messages.append({"role": "user", "content": (
        f"Pasajes de las fuentes:\n\n{retrieval.format_passages(passages)}\n\n"
        f"Pregunta: {question}\n\nResponde citando los pasajes con [n].")})
    try:
        reply = llm.chat(services, messages, max_tokens=2048, temperature=0.2)
    except llm.NoModel as exc:
        if chat:
            chats.add_message(services, chat["id"], "user", question)
        return {**base, "answer": None, "citations": [],
                "passages": [retrieval.public_passage(p) for p in passages],
                "model": None, "note": exc.note()}
    answer, citations = retrieval.apply_citations(reply.text, passages)
    if chat:
        chats.add_message(services, chat["id"], "user", question)
        chats.add_message(services, chat["id"], "assistant", answer, citations, {"model": reply.model})
    out = {**base, "answer": answer, "citations": citations, "model": reply.model}
    if found["note"]:
        out["note"] = found["note"]
    return out
