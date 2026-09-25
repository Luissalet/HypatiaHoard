"""Records store: the PWA's IndexedDB tables as generic JSON documents.

Every write bumps a global revision (kv 'rev') stored on the row, so a device
can pull "everything after rev N". Deletes leave a tombstone with its own rev.
`data` is exactly the object the PWA uses (camelCase, unknown fields kept).
"""

from __future__ import annotations

import json
from typing import Any, Callable, Iterable

from .db import Database

# kind -> FullBackup array name
KINDS: dict[str, str] = {
    "subject": "subjects",
    "topic": "topics",
    "question": "questions",
    "session": "sessions",
    "pdfAnchor": "pdfAnchors",
    "keyConcept": "keyConcepts",
    "exam": "exams",
    "deliverable": "deliverables",
    "gradingConfig": "gradingConfigs",
    "installedPackage": "installedPackages",
}
ARRAY_TO_KIND = {v: k for k, v in KINDS.items()}

# Children removed with a subject (subjectRepo.delete) and with a topic (topicRepo.delete).
SUBJECT_CASCADE = ("topic", "question", "session", "pdfAnchor", "keyConcept")


def subject_of(kind: str, obj: dict[str, Any]) -> str | None:
    if kind in ("subject", "gradingConfig"):
        return obj.get("id")
    value = obj.get("subjectId")
    return value if isinstance(value, str) else None


def question_fts_text(q: dict[str, Any]) -> str:
    parts: list[str] = [q.get("prompt") or ""]
    parts += [o.get("text") or "" for o in (q.get("options") or []) if isinstance(o, dict)]
    parts += [q.get("modelAnswer") or "", q.get("clozeText") or "", q.get("explanation") or ""]
    parts += [str(t) for t in (q.get("tags") or [])] + [str(k) for k in (q.get("keywords") or [])]
    return "\n".join(p for p in parts if p)


class RecordStore:
    def __init__(self, db: Database, now_iso: Callable[[], str]):
        self.db = db
        self.now_iso = now_iso

    # ---------- revision / kv ----------
    def kv_get(self, key: str, default: Any = None) -> Any:
        with self.db.lock:
            row = self.db.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    def kv_set(self, key: str, value: Any) -> None:
        with self.db.lock:
            self.db.conn.execute("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                 (key, json.dumps(value, ensure_ascii=False)))

    def current_rev(self) -> int:
        return int(self.kv_get("rev", 0) or 0)

    def _next_rev(self) -> int:
        rev = self.current_rev() + 1
        self.kv_set("rev", rev)
        return rev

    # ---------- reads ----------
    def get(self, kind: str, id: str) -> dict | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, id)).fetchone()
        return json.loads(row["data"]) if row else None

    def list(self, kind: str, subject_id: str | None = None) -> list[dict]:
        sql, params = "SELECT data FROM records WHERE kind=?", [kind]
        if subject_id is not None:
            sql += " AND subject_id=?"
            params.append(subject_id)
        with self.db.lock:
            rows = self.db.conn.execute(sql + " ORDER BY id", params).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def by_hash(self, kind: str, content_hash: str) -> list[dict]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT data FROM records WHERE kind=? AND content_hash=? ORDER BY id",
                                        (kind, content_hash)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def count(self, kind: str) -> int:
        with self.db.lock:
            return self.db.conn.execute("SELECT COUNT(*) FROM records WHERE kind=?", (kind,)).fetchone()[0]

    def changed_since(self, rev: int) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {k: [] for k in KINDS}
        with self.db.lock:
            rows = self.db.conn.execute("SELECT kind, data FROM records WHERE rev>? ORDER BY kind, id", (rev,)).fetchall()
        for r in rows:
            out.setdefault(r["kind"], []).append(json.loads(r["data"]))
        return out

    def tombstones_since(self, rev: int) -> list[dict]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT kind, id, deleted_at FROM tombstones WHERE rev>? ORDER BY rev", (rev,)).fetchall()
        return [{"kind": r["kind"], "id": r["id"], "deletedAt": r["deleted_at"]} for r in rows]

    def tombstone(self, kind: str, id: str) -> dict | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT rev, deleted_at FROM tombstones WHERE kind=? AND id=?", (kind, id)).fetchone()
        return {"rev": row["rev"], "deletedAt": row["deleted_at"]} if row else None

    # ---------- writes ----------
    def put(self, kind: str, obj: dict[str, Any]) -> int:
        if kind not in KINDS:
            raise ValueError(f"Unknown record kind {kind!r}.")
        rid = obj.get("id")
        if not isinstance(rid, str) or not rid:
            raise ValueError(f"A {kind} record needs a string id.")
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        with self.db.tx() as conn:
            # A put that stores exactly the same JSON is a no-op: bumping the rev would
            # make every device re-pull (and re-merge) records nobody changed.
            same = conn.execute("SELECT rev FROM records WHERE kind=? AND id=? AND data=?", (kind, rid, data)).fetchone()
            if same is not None:
                return int(same["rev"])
            rev = self._next_rev()
            conn.execute(
                "INSERT INTO records(kind, id, subject_id, content_hash, updated_at, rev, data) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(kind, id) DO UPDATE SET subject_id=excluded.subject_id, content_hash=excluded.content_hash, "
                "updated_at=excluded.updated_at, rev=excluded.rev, data=excluded.data",
                (kind, rid, subject_of(kind, obj), obj.get("contentHash"), obj.get("updatedAt"), rev, data))
            conn.execute("DELETE FROM tombstones WHERE kind=? AND id=?", (kind, rid))
            if kind == "question":
                conn.execute("DELETE FROM questions_fts WHERE id=?", (rid,))
                conn.execute("INSERT INTO questions_fts(id, subject_id, text) VALUES (?,?,?)",
                             (rid, obj.get("subjectId"), question_fts_text(obj)))
        return rev

    def delete(self, kind: str, id: str, deleted_at: str | None = None) -> bool:
        """Remove a record (and its cascade), leaving tombstones. False if it did not exist."""
        with self.db.tx():
            existed = self._delete_one(kind, id, deleted_at)
            if kind == "subject":
                for child in SUBJECT_CASCADE:
                    for rid in self._ids_where(child, "subject_id=?", (id,)):
                        self._delete_one(child, rid, deleted_at)
            elif kind == "topic":
                for rid in self._ids_where("question", "json_extract(data, '$.topicId')=?", (id,)):
                    self._delete_one("question", rid, deleted_at)
        return existed

    def tombstone_only(self, kind: str, id: str, deleted_at: str | None = None) -> None:
        """Record a deletion of an id the server never had (so pushes do not bring it back)."""
        with self.db.tx():
            self._delete_one(kind, id, deleted_at)

    def _ids_where(self, kind: str, where: str, params: Iterable[Any]) -> list[str]:
        rows = self.db.conn.execute(f"SELECT id FROM records WHERE kind=? AND {where}", (kind, *params)).fetchall()
        return [r["id"] for r in rows]

    def _delete_one(self, kind: str, id: str, deleted_at: str | None) -> bool:
        conn = self.db.conn
        cur = conn.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, id))
        if kind == "question":
            conn.execute("DELETE FROM questions_fts WHERE id=?", (id,))
        rev = self._next_rev()
        conn.execute("INSERT INTO tombstones(kind, id, rev, deleted_at) VALUES (?,?,?,?) "
                     "ON CONFLICT(kind, id) DO UPDATE SET rev=excluded.rev, deleted_at=excluded.deleted_at",
                     (kind, id, rev, deleted_at or self.now_iso()))
        return cur.rowcount > 0

    # ---------- images ----------
    def image(self, filename: str) -> tuple[str, bytes] | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT mime, data FROM images WHERE filename=?", (filename,)).fetchone()
        return (row["mime"], bytes(row["data"])) if row else None

    def image_stems(self) -> set[str]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT filename FROM images").fetchall()
        return {r["filename"].rsplit(".", 1)[0] if "." in r["filename"] else r["filename"] for r in rows}

    def put_image(self, filename: str, mime: str, data: bytes) -> int:
        with self.db.tx() as conn:
            rev = self._next_rev()
            conn.execute("INSERT INTO images(filename, mime, data, rev) VALUES (?,?,?,?) ON CONFLICT(filename) DO UPDATE "
                         "SET mime=excluded.mime, data=excluded.data, rev=excluded.rev", (filename, mime, data, rev))
        return rev

    def images_since(self, rev: int) -> list[tuple[str, str, bytes]]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT filename, mime, data FROM images WHERE rev>? ORDER BY filename", (rev,)).fetchall()
        return [(r["filename"], r["mime"], bytes(r["data"])) for r in rows]
