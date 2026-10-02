"""What this app says on the family bus, and the address it says it with.

Canonical job events: ``hypatia.job.queued|started|progress|done|failed|cancelled`` with
``{job_id, title, kind, progress (0..1), gpu, eta_s, url, error}``. (The hub maps the older ``hypatia.teacher_job.*``
names onto these, so those are not sent as well: both would count one job twice.)
"""

from __future__ import annotations

import time
from typing import Any, Optional

PROGRESS_EVERY_S = 3.0
_last_progress: dict[str, float] = {}

JOB_TITLES = {"exam_generate": "Generar preguntas del examen", "grading_run": "Corregir respuestas abiertas"}


def public_url(services: Any) -> str:
    port = getattr(getattr(services, "config", None), "port", None)
    return f"http://127.0.0.1:{port}" if port else ""


def app_link(services: Any, route: str = "") -> str:
    base = public_url(services)
    return f"{base}/#/{route.lstrip('#/')}" if base else ""


def _title_of(services: Any, row: dict, params: dict) -> str:
    base = JOB_TITLES.get(row.get("kind"), str(row.get("kind") or "Trabajo"))
    try:
        from .teacher.store import teacher_store

        store = teacher_store(services)
        exam = store.get("teacherExam", params.get("examId")) if params.get("examId") else None
        if exam is None and params.get("batchId"):
            batch = store.get("gradingBatch", params["batchId"])
            exam = store.get("teacherExam", batch.get("examId")) if batch else None
        if exam and exam.get("title"):
            return f"{base}: {exam['title']}"[:200]
    except Exception:  # noqa: BLE001 - a title is a nicety
        pass
    return base[:200]


def _route_of(row: dict, params: dict) -> str:
    if params.get("batchId"):
        return f"teacher/batch/{params['batchId']}"
    if params.get("examId"):
        return f"teacher/exam/{params['examId']}"
    return "teacher"


def job_event(services: Any, name: str, row: dict, params: dict, *, progress: Optional[float] = None,
              eta_s: Optional[int] = None, error: str = "") -> None:
    """One ``hypatia.job.<name>`` event, kind "teacher". Never raises, never waits."""
    try:
        from .hoard_link import family

        job_id = row["id"]
        if name == "progress":
            now = time.monotonic()
            if now - _last_progress.get(job_id, -1e9) < PROGRESS_EVERY_S:
                return
            _last_progress[job_id] = now
        if name in ("done", "failed", "cancelled"):
            _last_progress.pop(job_id, None)
        value = 1.0 if name == "done" else max(0.0, min(1.0, float(progress or 0.0)))
        family.emit(f"hypatia.job.{name}", {
            "job_id": job_id, "title": _title_of(services, row, params), "kind": "teacher", "progress": round(value, 3),
            "gpu": False, "eta_s": eta_s, "url": app_link(services, _route_of(row, params)), "error": error,
            "job_kind": row.get("kind"),
        })
    except Exception:  # noqa: BLE001 - the bus is optional
        pass
