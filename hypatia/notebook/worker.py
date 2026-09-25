"""The notebook's single background thread: source indexing and studio jobs.

One thread consumes a priority queue, so at most one studio (LLM) job runs at a
time. Priorities: explicit index requests (uploads, source_add) 0, studio jobs 1,
background rescans and their indexing 2.
"""

from __future__ import annotations

import itertools
import logging
import os
import queue
import threading
from typing import Any, Optional

log = logging.getLogger("hypatia.notebook")

P_INDEX, P_STUDIO, P_BACKGROUND = 0, 1, 2
_STOP = object()


class Worker:
    def __init__(self, services: Any):
        self.services = services
        self.stop_event = threading.Event()
        self.queue: "queue.PriorityQueue[tuple[int, int, Any, Any]]" = queue.PriorityQueue()
        self._seq = itertools.count()
        self._queued: set[tuple[str, Any]] = set()
        self._qlock = threading.Lock()
        self.idle = threading.Event()
        self.idle.set()
        self.thread = threading.Thread(target=self._loop, name="hypatia-notebook", daemon=True)

    # ---- queueing
    def put(self, priority: int, op: str, arg: Any) -> None:
        key = (op, arg)
        with self._qlock:
            if key in self._queued:
                return
            self._queued.add(key)
            self.idle.clear()
        self.queue.put((priority, next(self._seq), op, arg))

    def start(self) -> "Worker":
        self.thread.start()
        return self

    def stop(self, timeout: float = 10.0) -> None:
        self.stop_event.set()
        self.queue.put((-1, -1, _STOP, None))
        if self.thread.is_alive() and threading.current_thread() is not self.thread:
            self.thread.join(timeout)

    def alive(self) -> bool:
        return self.thread.is_alive() and not self.stop_event.is_set()

    def wait_idle(self, timeout: float = 30.0) -> bool:
        return self.idle.wait(timeout)

    # ---- loop
    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                _prio, _seq, op, arg = self.queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if op is _STOP:
                break
            with self._qlock:
                self._queued.discard((op, arg))
            try:
                self._run(op, arg)
            except Exception:  # noqa: BLE001 - the worker must survive any job
                log.exception("notebook job %s(%r) failed", op, arg)
            with self._qlock:
                if not self._queued:
                    self.idle.set()
        self.idle.set()

    def _run(self, op: str, arg: Any) -> None:
        from . import sources, studio

        if op == "index":
            sources.index_source(self.services, arg)
        elif op == "rescan":
            self._rescan(arg)
        elif op == "embed":
            sources.embed_source(self.services, arg)
        elif op == "studio":
            studio.run(self.services, arg, self.stop_event)

    def _rescan(self, subject_id: Optional[str]) -> None:
        from . import sources

        subjects = self.services.store.list("subject") or []
        if subject_id:
            subjects = [s for s in subjects if s.get("id") == subject_id]
        for subject in subjects:
            if self.stop_event.is_set():
                return
            try:
                counts = sources.scan_subject(self.services, subject)
            except Exception:  # noqa: BLE001
                log.exception("rescan of %s failed", subject.get("id"))
                continue
            for sid in counts.get("pending", []):
                self.put(P_BACKGROUND, "index", sid)
            pending = set(counts.get("pending", []))
            for sid in sources.sources_missing_vectors(self.services, subject["id"]):
                if sid not in pending:
                    self.put(P_BACKGROUND, "embed", sid)


_worker: Optional[Worker] = None
_lock = threading.Lock()


def _requeue(services: Any, w: Worker) -> None:
    from .schema import rows

    for r in rows(services, "SELECT id FROM studio_items WHERE status IN ('queued','running') ORDER BY created_at"):
        with services.db.tx() as conn:
            conn.execute("UPDATE studio_items SET status='queued' WHERE id=?", (r["id"],))
        w.put(P_STUDIO, "studio", r["id"])
    for r in rows(services, "SELECT id FROM sources WHERE status='pending'"):
        w.put(P_BACKGROUND, "index", r["id"])


def start_worker(services: Any, *, initial_scan: Optional[bool] = None) -> Worker:
    """Start (or return) the worker for these services; requeues interrupted jobs and,
    unless HYPATIA_NOTEBOOK_AUTOSCAN=0, rescans every subject's resources."""
    global _worker
    with _lock:
        if _worker is not None and _worker.alive() and _worker.services is services:
            return _worker
        if _worker is not None:
            _worker.stop()
        w = Worker(services)
        _requeue(services, w)
        if initial_scan is None:
            initial_scan = os.environ.get("HYPATIA_NOTEBOOK_AUTOSCAN", "1").strip() != "0"
        if initial_scan:
            w.put(P_BACKGROUND, "rescan", None)
        _worker = w.start()
        return w


def get_worker(services: Any) -> Worker:
    with _lock:
        w = _worker
    if w is not None and w.alive() and w.services is services:
        return w
    return start_worker(services, initial_scan=False)


def stop_worker(timeout: float = 10.0) -> None:
    global _worker
    with _lock:
        w, _worker = _worker, None
    if w is not None:
        w.stop(timeout)


def submit_index(services: Any, source_ids: list[str], priority: int = P_INDEX) -> None:
    w = get_worker(services)
    for sid in source_ids:
        w.put(priority, "index", sid)


def submit_rescan(services: Any, subject_id: Optional[str] = None) -> None:
    get_worker(services).put(P_INDEX, "rescan", subject_id)


def submit_studio(services: Any, item_id: str) -> None:
    get_worker(services).put(P_STUDIO, "studio", item_id)
