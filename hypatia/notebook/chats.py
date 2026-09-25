"""Persisted notebook chats (mode 'sources' for grounded Q&A, 'tutor' for the Socratic tutor)."""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional

from .schema import row, rows


def _loads(v: Optional[str], default: Any) -> Any:
    if not v:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return default


def get_or_create(services: Any, chat_id: Optional[str], subject_id: str, mode: str,
                  title: str, topic_id: Optional[str] = None) -> dict[str, Any]:
    if chat_id:
        found = row(services, "SELECT * FROM chats WHERE id=?", (chat_id,))
        if found:
            if found["subject_id"] != subject_id or found["mode"] != mode:
                raise LookupError(f"El chat {chat_id} pertenece a otra asignatura o modo")
            found["state"] = _loads(found.get("state"), {})
            return found
    now = services.now_iso()
    cid = chat_id or "chat_" + uuid.uuid4().hex[:16]
    with services.db.tx() as conn:
        conn.execute("INSERT INTO chats(id, subject_id, mode, title, topic_id, state, created_at, updated_at)"
                     " VALUES(?,?,?,?,?,?,?,?)", (cid, subject_id, mode, title[:120], topic_id, "{}", now, now))
    created = row(services, "SELECT * FROM chats WHERE id=?", (cid,)) or {}
    created["state"] = {}
    return created


def history(services: Any, chat_id: str, limit: int = 8) -> list[dict[str, Any]]:
    found = rows(services, "SELECT role, content FROM chat_messages WHERE chat_id=? ORDER BY id DESC LIMIT ?",
                 (chat_id, limit))
    return [{"role": r["role"], "content": r["content"] or ""} for r in reversed(found)]


def add_message(services: Any, chat_id: str, role: str, content: Optional[str],
                citations: Optional[list] = None, meta: Optional[dict] = None,
                state: Optional[dict] = None) -> None:
    now = services.now_iso()
    with services.db.tx() as conn:
        conn.execute("INSERT INTO chat_messages(chat_id, role, content, citations, meta, created_at)"
                     " VALUES(?,?,?,?,?,?)",
                     (chat_id, role, content, json.dumps(citations or [], ensure_ascii=False),
                      json.dumps(meta or {}, ensure_ascii=False), now))
        if state is not None:
            conn.execute("UPDATE chats SET updated_at=?, state=? WHERE id=?",
                         (now, json.dumps(state, ensure_ascii=False), chat_id))
        else:
            conn.execute("UPDATE chats SET updated_at=? WHERE id=?", (now, chat_id))


def _public_chat(c: dict[str, Any]) -> dict[str, Any]:
    return {"id": c["id"], "subjectId": c["subject_id"], "mode": c["mode"], "title": c.get("title"),
            "topicId": c.get("topic_id"), "createdAt": c.get("created_at"), "updatedAt": c.get("updated_at")}


def list_chats(services: Any, subject_id: str, mode: Optional[str] = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM chats WHERE subject_id=?"
    params: list[Any] = [subject_id]
    if mode:
        sql += " AND mode=?"
        params.append(mode)
    return [_public_chat(c) for c in rows(services, sql + " ORDER BY updated_at DESC", params)]


def get_chat(services: Any, chat_id: str) -> Optional[dict[str, Any]]:
    c = row(services, "SELECT * FROM chats WHERE id=?", (chat_id,))
    if not c:
        return None
    out = _public_chat(c)
    out["messages"] = [
        {"id": m["id"], "role": m["role"], "content": m["content"], "citations": _loads(m["citations"], []),
         "meta": _loads(m["meta"], {}), "createdAt": m["created_at"]}
        for m in rows(services, "SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id", (chat_id,))
    ]
    return out


def delete_chat(services: Any, chat_id: str) -> bool:
    with services.db.tx() as conn:
        conn.execute("DELETE FROM chat_messages WHERE chat_id=?", (chat_id,))
        cur = conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
        return cur.rowcount > 0
