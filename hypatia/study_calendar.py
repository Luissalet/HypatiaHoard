"""Calendar snapshot of the person's study deliverables, without teacher data."""
from __future__ import annotations

from datetime import date
import hashlib
import re

from .hoard_link.ics import build_ics


def export_calendar(services, *, date_from: date, date_to: date, subject_id=None, include_completed=False):
    if date_to < date_from:
        raise ValueError("La fecha final debe ser igual o posterior a la inicial.")
    subjects = {s["id"]: s for s in services.store.list("subject")}
    events, excluded = [], []
    completed_skipped = outside_range = 0
    states = {"pending": "Pendiente", "in_progress": "En progreso", "done": "Hecho", "submitted": "Entregado"}
    for row in services.store.list("deliverable", subject_id=subject_id):
        status = row.get("status", "pending")
        if not include_completed and status in ("done", "submitted"):
            completed_skipped += 1
            continue
        subject = subjects.get(row.get("subjectId"), {}).get("name") or "Sin asignatura"
        item = {"id": row["id"], "name": row.get("name") or "Entrega", "subject": subject,
                "subject_id": row.get("subjectId"), "type": row.get("type"), "status": status}
        raw_date = str(row.get("dueDate") or "").strip()
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date):
                raise ValueError
            day = date.fromisoformat(raw_date)
        except ValueError:
            excluded.append({**item, "reason": "Sin fecha" if not raw_date else "Fecha no válida"})
            continue
        if not date_from <= day <= date_to:
            outside_range += 1
            continue
        clock = str(row.get("dueTime") or "").strip()
        if clock and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clock):
            excluded.append({**item, "reason": "Hora no válida"})
            continue
        start = f"{day.isoformat()}T{clock}:00" if clock else day.isoformat()
        kind = "Examen" if row.get("type") == "exam" else "Entrega"
        uid = "hypatia-study-" + hashlib.sha256(str(row["id"]).encode()).hexdigest() + "@local.hypatia"
        events.append({**item, "uid": uid, "title": f"{kind}: {item['name']} · {subject}",
                       "start": start, "all_day": not bool(clock), "date": day.isoformat(), "time": clock or None,
                       "description": f"Asignatura: {subject}\nEstado: {states.get(status, status)}",
                       "categories": ["Estudio", kind], "transp": "TRANSPARENT"})
    events.sort(key=lambda e: (e["start"], e["subject"].casefold(), e["name"].casefold(), e["id"]))
    return {"date_from": date_from.isoformat(), "date_to": date_to.isoformat(), "subject_id": subject_id,
            "include_completed": include_completed, "generated_at": services.now_iso(), "source": "study_bank",
            "time_semantics": "Saved local times have no timezone; they remain floating local times in the calendar.",
            "events": events, "excluded": excluded, "completed_skipped": completed_skipped, "outside_range": outside_range,
            "filename": f"hypatia-estudio-{date_from.isoformat()}-{date_to.isoformat()}.ics",
            "ics": build_ics(events, name="Hypatia · estudio", prodid="-//Hypatia's Hoard//Study calendar//ES", now=services.now())}
