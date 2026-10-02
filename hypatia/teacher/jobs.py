"""Long teacher tasks as background jobs (question generation, grading a batch).

They run on the notebook's single worker thread (op "teacher"), so at most one
model job runs at a time on the user's GPU, alongside studio jobs. A job keeps
its progress (done/total/label), its result, and an explicit final status:
`done`, `no_model` (nothing could run: no local model), or `error`.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any, Callable, Optional

from .store import teacher_store

ACTIVE = ("queued", "running")
FINAL = ("done", "no_model", "no_sources", "error", "cancelled")


class Stopped(Exception):
    """The worker is shutting down: the job goes back to the queue."""


def _loads(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except ValueError:
        return default


def public(row: dict) -> dict:
    return {"id": row["id"], "kind": row["kind"], "status": row["status"], "params": _loads(row.get("params"), {}),
            "progress": _loads(row.get("progress"), {}), "result": _loads(row.get("result"), None),
            "error": row.get("error"), "note": row.get("note"), "createdAt": row.get("created_at"),
            "startedAt": row.get("started_at"), "finishedAt": row.get("finished_at")}


def _row(services: Any, job_id: str) -> Optional[dict]:
    teacher_store(services)
    with services.db.lock:
        cur = services.db.conn.execute("SELECT * FROM teacher_jobs WHERE id=?", (job_id,))
        found = cur.fetchone()
        return dict(zip([d[0] for d in cur.description], tuple(found))) if found else None


def get(services: Any, job_id: str) -> Optional[dict]:
    row = _row(services, job_id)
    return public(row) if row else None


def list_jobs(services: Any, active_only: bool = False, limit: int = 20) -> list[dict]:
    teacher_store(services)
    sql = "SELECT * FROM teacher_jobs"
    if active_only:
        sql += " WHERE status IN ('queued','running')"
    with services.db.lock:
        cur = services.db.conn.execute(sql + " ORDER BY created_at DESC LIMIT ?", (limit,))
        names = [d[0] for d in cur.description]
        return [public(dict(zip(names, tuple(r)))) for r in cur.fetchall()]


def _update(services: Any, job_id: str, **fields: Any) -> None:
    for key in ("params", "progress", "result"):
        if key in fields and not isinstance(fields[key], (str, type(None))):
            fields[key] = json.dumps(fields[key], ensure_ascii=False)
    sets = ", ".join(f"{k}=?" for k in fields)
    with services.db.tx() as conn:
        conn.execute(f"UPDATE teacher_jobs SET {sets} WHERE id=?", (*fields.values(), job_id))


# kind -> handler(services, params, ctx) -> (status, result, note)
HANDLERS: dict[str, Callable[..., tuple[str, Any, Optional[str]]]] = {}


def handler(kind: str):
    def deco(fn):
        HANDLERS[kind] = fn
        return fn
    return deco


def create(services: Any, kind: str, params: dict[str, Any], *, submit: bool = True) -> dict:
    if kind not in HANDLERS:
        _load_handlers()
    if kind not in HANDLERS:
        raise ValueError(f"Unknown job kind {kind!r}.")
    teacher_store(services)
    job_id = "tj_" + uuid.uuid4().hex[:16]
    with services.db.tx() as conn:
        conn.execute("INSERT INTO teacher_jobs(id, kind, status, params, progress, created_at) VALUES (?,?,?,?,?,?)",
                     (job_id, kind, "queued", json.dumps(params, ensure_ascii=False),
                      json.dumps({"done": 0, "total": 0}), services.now_iso()))
    if submit:
        _submit(services, job_id)
    return get(services, job_id)


def _submit(services: Any, job_id: str) -> None:
    try:
        from ..notebook import worker
    except ImportError:  # pragma: no cover - the notebook ships with the server
        threading.Thread(target=run, args=(services, job_id), daemon=True, name="hypatia-teacher-job").start()
        return
    worker.get_worker(services).put(worker.P_STUDIO, "teacher", job_id)


def requeue(services: Any) -> list[str]:
    """Jobs interrupted by a restart go back to the queue (called at start-up)."""
    teacher_store(services)
    with services.db.lock:
        ids = [r["id"] for r in services.db.conn.execute(
            "SELECT id FROM teacher_jobs WHERE status IN ('queued','running') ORDER BY created_at").fetchall()]
    for job_id in ids:
        _update(services, job_id, status="queued")
        _submit(services, job_id)
    return ids


class Context:
    """What a handler gets: progress reporting and the stop check."""

    def __init__(self, services: Any, job_id: str, stop: Optional[threading.Event]):
        self.services = services
        self.job_id = job_id
        self.stop = stop

    def check(self) -> None:
        if self.stop is not None and self.stop.is_set():
            raise Stopped()

    def progress(self, done: int, total: int, label: str = "") -> None:
        _update(self.services, self.job_id, progress={"done": done, "total": total, "label": label})
        self.check()


def run(services: Any, job_id: str, stop: Optional[threading.Event] = None) -> Optional[dict]:
    """Execute one queued job (the worker calls this; tests call it inline)."""
    row = _row(services, job_id)
    if not row or row["status"] not in ACTIVE:
        return public(row) if row else None
    if row["kind"] not in HANDLERS:
        _load_handlers()
    fn = HANDLERS.get(row["kind"])
    _update(services, job_id, status="running", started_at=services.now_iso(), error=None)
    ctx = Context(services, job_id, stop)
    try:
        if fn is None:
            raise ValueError(f"Unknown job kind {row['kind']!r}.")
        status, result, note = fn(services, _loads(row.get("params"), {}), ctx)
    except Stopped:
        _update(services, job_id, status="queued")
        return get(services, job_id)
    except Exception as exc:  # noqa: BLE001 - recorded on the job
        _update(services, job_id, status="error", error=f"{type(exc).__name__}: {exc}"[:1000],
                finished_at=services.now_iso())
        return get(services, job_id)
    _update(services, job_id, status=status, result=result, note=note, finished_at=services.now_iso())
    job = get(services, job_id)
    try:
        from ..hoard_link import family

        family.emit(f"hypatia.teacher_job.{status}", {"id": job_id, "kind": row["kind"]})
    except Exception:  # noqa: BLE001 - the bus is optional
        pass
    return job


def wait(services: Any, job_id: str, wait_s: float) -> Optional[dict]:
    deadline = time.monotonic() + max(0.0, min(float(wait_s or 0), 120.0))
    while True:
        job = get(services, job_id)
        if not job or job["status"] in FINAL or time.monotonic() >= deadline:
            return job
        time.sleep(0.2)


def _load_handlers() -> None:
    from . import assess, generate  # noqa: F401 - registers the handlers
