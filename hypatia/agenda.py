"""The family agenda contract (``GET /api/family/agenda``): what this app has coming up for the person.

* exams: a subject's exam date, and the date in the header of a teacher exam (when it is a real date);
* deliverables (activities, tests, practicals) not yet done, with their due date and time;
* cards: "N tarjetas para repasar hoy", one all-day item for today, only when something is due.

Nothing here reads a student's name or answers: only subject names, exam titles and counts.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from . import familyevents
from .hoard_link import fam_agenda

SOON_DAYS = 7


def _local_today(services: Any) -> date:
    return services.now().astimezone().date()


def _in_range(value: Any, date_from: date, date_to: date) -> bool:
    parsed = fam_agenda.parse_when(value)
    return parsed is not None and date_from <= parsed[0] <= date_to


def _due_cards(services: Any) -> int:
    today = services.today()
    total = 0
    for question in services.store.list("question"):
        due = (question.get("stats") or {}).get("nextReviewAt")
        if due and str(due)[:10] <= today:
            total += 1
    return total


def agenda_items(services: Any, date_from: date, date_to: date, sphere: str = "") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    today = _local_today(services)
    subjects = {s["id"]: s for s in services.store.list("subject")}

    for subject in subjects.values():
        exam = subject.get("examDate")
        if exam and _in_range(exam, date_from, date_to):
            day = fam_agenda.parse_when(exam)[0]
            items.append({"id": f"hypatia:exam:{subject['id']}", "title": f"Examen: {subject.get('name') or 'asignatura'}",
                          "start": str(exam)[:25] if len(str(exam)) > 10 else day.isoformat(), "kind": "exam",
                          "priority": "high" if 0 <= (day - today).days <= SOON_DAYS else "normal",
                          "url": familyevents.app_link(services, f"subject/{subject['id']}")})

    try:
        from .teacher.store import teacher_store

        for exam in teacher_store(services).list("teacherExam"):
            when = (exam.get("header") or {}).get("date")
            if when and _in_range(when, date_from, date_to):
                subject = subjects.get(exam.get("subjectId")) or {}
                items.append({"id": f"hypatia:teacher-exam:{exam['id']}", "title": f"Examen: {exam.get('title') or 'examen'}",
                              "start": str(when), "kind": "exam", "priority": "normal",
                              "detail": subject.get("name") or "", "url": familyevents.app_link(services, f"teacher/exam/{exam['id']}")})
    except Exception:  # noqa: BLE001 - the teacher tables are optional
        pass

    for d in services.store.list("deliverable"):
        due = d.get("dueDate")
        if d.get("status") in ("done", "submitted") or not due or not _in_range(due, date_from, date_to):
            continue
        day = fam_agenda.parse_when(due)[0]
        clock = str(d.get("dueTime") or "").strip()
        start = f"{day.isoformat()}T{clock}" if len(clock) == 5 and clock[2] == ":" else day.isoformat()
        subject = subjects.get(d.get("subjectId")) or {}
        name = d.get("name") or "entrega"
        items.append({"id": f"hypatia:deliverable:{d['id']}", "title": f"{subject['name']}: {name}" if subject.get("name") else name,
                      "start": start, "kind": "exam" if d.get("type") == "exam" else "deadline",
                      "priority": "high" if (day - today).days <= 2 else "normal",
                      "url": familyevents.app_link(services, "deliverables")})

    if date_from <= today <= date_to:
        due = _due_cards(services)
        if due:
            items.append({"id": f"hypatia:cards:{today.isoformat()}", "all_day": True, "start": today.isoformat(), "kind": "cards",
                          "title": f"{due} tarjeta{'' if due == 1 else 's'} para repasar hoy",
                          "priority": "normal", "url": familyevents.app_link(services, "")})
    items.sort(key=lambda i: (str(i["start"]), i["id"]))
    return items
