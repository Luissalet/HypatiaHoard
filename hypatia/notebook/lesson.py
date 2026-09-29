"""Versioned tutor lesson projected from the persisted message ledger.

Inspired by OpenMAIC's separate DSL/ledger contracts, without importing its code.
Message IDs own content and citations; action IDs remain stable across reopening.
"""

from __future__ import annotations

from typing import Any

VERSION = 1


def normalize_state(state: dict[str, Any]) -> dict[str, Any]:
    """Upgrade the original unversioned point/attempts state; reject future data."""
    version = state.get("lessonVersion", VERSION)
    if type(version) is not int or version != VERSION:
        raise ValueError(f"Versión de lección no compatible: {version}")
    attempts = state.get("attempts", 0)
    if type(attempts) is not int or attempts < 0:
        raise ValueError("Los intentos de la lección deben ser un entero no negativo")
    point = state.get("point")
    if point is not None and not isinstance(point, str):
        raise ValueError("El concepto de la lección debe ser texto")
    return {**state, "lessonVersion": VERSION, "point": point, "attempts": attempts}


def project(chat_id: str, state: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Reconstruct typed actions with references scoped to this lesson.

    Corrections target the preceding student message, never an arbitrary model ID.
    Citation numbers are local to their message, not global across the lesson.
    """
    state = normalize_state(state)
    actions: list[dict[str, Any]] = []
    seen: set[int] = set()
    question = answer = None
    for message in messages:
        mid = message["id"]
        if mid in seen:
            raise ValueError("La lección contiene mensajes duplicados")
        seen.add(mid)
        role = message["role"]
        if role not in ("user", "assistant"):
            continue
        references = []
        for citation in message.get("citations") or []:
            n = citation.get("n")
            if type(n) is not int or n < 1 or n in references or not citation.get("sourceId"):
                raise ValueError("Referencia de fuente inválida en la lección")
            references.append(n)

        def append(kind: str, target: str | None = None) -> str:
            aid = f"{chat_id}:{mid}:{kind}"
            action = {"id": aid, "kind": kind, "messageId": mid, "citationNumbers": references.copy()}
            if target is not None:
                action["targetId"] = target
            actions.append(action)
            return aid

        if role == "user":
            answer = append("responder", question)
        else:
            meta = message.get("meta") or {}
            if meta.get("assessment") in ("correct", "partial", "wrong") and answer:
                append("corregir", answer)
                actions[-1]["assessment"] = meta["assessment"]
            if meta.get("explained"):
                append("explicar")
            if "?" in (message.get("content") or ""):
                question = append("preguntar")
            else:
                question = None
    return {"version": VERSION, "id": chat_id, "state": state, "actions": actions}
