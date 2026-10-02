"""Teacher role ("Profesor"): classes and students, exams generated from the
teacher's material (bank + local model with citations, versions A/B, PDF), rubrics,
batch correction with model proposals the teacher confirms, grades, feedback and
class analysis. Student data lives only in the teacher store (see store.py)."""

from __future__ import annotations

from .store import KINDS, init_schema, teacher_store

__all__ = ["KINDS", "init_schema", "teacher_store", "start", "TEACHER_TOOLS"]


def start(services) -> None:
    """At server start: create the tables and requeue interrupted jobs."""
    from . import jobs

    teacher_store(services)
    jobs.requeue(services)


def __getattr__(name: str):
    if name == "TEACHER_TOOLS":
        from .tools import TEACHER_TOOLS

        return TEACHER_TOOLS
    raise AttributeError(name)
