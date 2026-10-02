"""Teacher data on the server: classes, students, generated exams, rubrics, grading
batches, submissions and grading proposals.

It lives in its own tables, NOT in the `records` store the study sync pulls from,
so nothing about students (names, answers, grades) can ever travel through the
study sync, the Gist backup, the global bank or a contribution pack. The app keeps
a copy in IndexedDB and syncs it here with `/api/teacher/sync/*` (last write wins
per record by `updatedAt`; deletions are kept as `deleted` rows so they sync too).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS teacher_records(
  kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS teacher_records_rev ON teacher_records(rev);
CREATE TABLE IF NOT EXISTS teacher_jobs(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, params TEXT, progress TEXT, result TEXT,
  error TEXT, note TEXT, created_at TEXT, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS teacher_jobs_created ON teacher_jobs(created_at);
"""

# kind -> IndexedDB table of the app (src/data/db.ts, version 9)
KINDS: dict[str, str] = {
    "class": "teacherClasses",
    "student": "teacherStudents",
    "teacherExam": "teacherExams",
    "rubric": "rubrics",
    "gradingBatch": "gradingBatches",
    "submission": "submissions",
    "proposal": "gradingProposals",
    "teacherSettings": "teacherSettings",
}

REV_KEY = "teacherRev"


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def new_id() -> str:
    return str(uuid.uuid4())


class TeacherStore:
    def __init__(self, services: Any):
        self.services = services
        self.db = services.db
        with self.db.lock:
            init_schema(self.db.conn)

    # ---------- revision ----------
    def current_rev(self) -> int:
        return int(self.services.store.kv_get(REV_KEY, 0) or 0)

    def _next_rev(self) -> int:
        rev = self.current_rev() + 1
        self.services.store.kv_set(REV_KEY, rev)
        return rev

    # ---------- reads ----------
    def get(self, kind: str, id: str) -> dict | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT data FROM teacher_records WHERE kind=? AND id=? AND deleted=0",
                                       (kind, id)).fetchone()
        return json.loads(row["data"]) if row else None

    def list(self, kind: str, **where: Any) -> list[dict]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT data FROM teacher_records WHERE kind=? AND deleted=0 ORDER BY id",
                                        (kind,)).fetchall()
        out = [json.loads(r["data"]) for r in rows]
        for key, value in where.items():
            out = [o for o in out if o.get(key) == value]
        return out

    def changed_since(self, rev: int) -> list[dict]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT kind, id, updated_at, deleted, data FROM teacher_records WHERE rev>? "
                                        "ORDER BY rev", (rev,)).fetchall()
        return [{"kind": r["kind"], "id": r["id"], "updatedAt": r["updated_at"], "deleted": bool(r["deleted"]),
                 "data": None if r["deleted"] else json.loads(r["data"])} for r in rows]

    def counts(self) -> dict[str, int]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT kind, COUNT(*) AS n FROM teacher_records WHERE deleted=0 GROUP BY kind"
                                        ).fetchall()
        found = {r["kind"]: r["n"] for r in rows}
        return {k: found.get(k, 0) for k in KINDS}

    # ---------- writes ----------
    def put(self, kind: str, obj: dict[str, Any], *, touch: bool = True) -> dict:
        """Store a record; `touch` stamps updatedAt (and createdAt when missing) with the clock."""
        if kind not in KINDS:
            raise ValueError(f"Unknown teacher record kind {kind!r}.")
        if not obj.get("id"):
            obj = {**obj, "id": new_id()}
        now = self.services.now_iso()
        if touch:
            obj = {**obj, "updatedAt": now}
            obj.setdefault("createdAt", now)
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        with self.db.tx() as conn:
            same = conn.execute("SELECT 1 FROM teacher_records WHERE kind=? AND id=? AND deleted=0 AND data=?",
                                (kind, obj["id"], data)).fetchone()
            if same is None:
                rev = self._next_rev()
                conn.execute(
                    "INSERT INTO teacher_records(kind, id, rev, updated_at, deleted, data) VALUES (?,?,?,?,0,?) "
                    "ON CONFLICT(kind, id) DO UPDATE SET rev=excluded.rev, updated_at=excluded.updated_at, deleted=0, "
                    "data=excluded.data", (kind, obj["id"], rev, obj.get("updatedAt") or now, data))
        return obj

    def delete(self, kind: str, id: str, deleted_at: str | None = None) -> bool:
        """Mark deleted (the data is dropped; only kind/id/time stay so the deletion syncs)."""
        with self.db.tx() as conn:
            row = conn.execute("SELECT deleted FROM teacher_records WHERE kind=? AND id=?", (kind, id)).fetchone()
            rev = self._next_rev()
            conn.execute("INSERT INTO teacher_records(kind, id, rev, updated_at, deleted, data) VALUES (?,?,?,?,1,'{}') "
                         "ON CONFLICT(kind, id) DO UPDATE SET rev=excluded.rev, updated_at=excluded.updated_at, "
                         "deleted=1, data='{}'", (kind, id, rev, deleted_at or self.services.now_iso()))
        return row is not None and not row["deleted"]

    def delete_cascade(self, kind: str, id: str) -> int:
        """Delete a record and what hangs from it (class -> students and batches;
        exam -> its rubrics and batches; batch -> submissions and proposals)."""
        removed = 0
        with self.db.tx():
            if kind == "class":
                for s in self.list("student", classId=id):
                    removed += self.delete("student", s["id"])
                for b in self.list("gradingBatch", classId=id):
                    removed += self.delete_cascade("gradingBatch", b["id"])
            elif kind == "teacherExam":
                for r in self.list("rubric", examId=id):
                    removed += self.delete("rubric", r["id"])
                for b in self.list("gradingBatch", examId=id):
                    removed += self.delete_cascade("gradingBatch", b["id"])
            elif kind == "gradingBatch":
                for s in self.list("submission", batchId=id):
                    removed += self.delete("submission", s["id"])
                for p in self.list("proposal", batchId=id):
                    removed += self.delete("proposal", p["id"])
            removed += self.delete(kind, id)
        return removed

    def push(self, records: Iterable[dict]) -> dict:
        """Records from the app: applied when newer than (or as new as) the server's copy."""
        applied, stale = 0, []
        with self.db.tx() as conn:
            for rec in records:
                kind, rid = rec.get("kind"), rec.get("id")
                updated = rec.get("updatedAt")
                if kind not in KINDS or not isinstance(rid, str) or not rid or not isinstance(updated, str):
                    continue
                row = conn.execute("SELECT updated_at, deleted, data FROM teacher_records WHERE kind=? AND id=?",
                                   (kind, rid)).fetchone()
                if row is not None and row["updated_at"] > updated:
                    stale.append({"kind": kind, "id": rid})
                    continue
                if rec.get("deleted"):
                    if row is not None and row["deleted"]:
                        continue
                    self.delete(kind, rid, updated)
                    applied += 1
                    continue
                data = rec.get("data")
                if not isinstance(data, dict) or data.get("id") != rid:
                    continue
                text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
                if row is not None and not row["deleted"] and row["data"] == text:
                    continue
                rev = self._next_rev()
                conn.execute(
                    "INSERT INTO teacher_records(kind, id, rev, updated_at, deleted, data) VALUES (?,?,?,?,0,?) "
                    "ON CONFLICT(kind, id) DO UPDATE SET rev=excluded.rev, updated_at=excluded.updated_at, deleted=0, "
                    "data=excluded.data", (kind, rid, rev, updated, text))
                applied += 1
        return {"rev": self.current_rev(), "applied": applied, "stale": stale}


_stores: dict[int, TeacherStore] = {}
_lock = threading.Lock()


def teacher_store(services: Any) -> TeacherStore:
    """The TeacherStore of these services (schema created on first use)."""
    key = id(services.db)
    with _lock:
        store = _stores.get(key)
        if store is None or store.services is not services:
            store = TeacherStore(services)
            _stores[key] = store
        return store
