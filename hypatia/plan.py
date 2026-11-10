"""Study plan up to an exam date.

Given a subject, the exam date and the minutes a day the student can give, it lays out every day
until the exam: the reviews the spaced-repetition schedule already has due that day, the cards
never seen spread so the whole bank is studied before the last days, timed mock exams weighted to
the weak topics (one a week and one shortly before the exam), a final review day and the exam.

No model is involved: the plan is computed from the bank and the review schedule, so it changes
as the student studies. The settings (exam date, minutes, rest days) are kept per subject so the
family agenda can show the day's plan and the exam even when the date was set on another device.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any, Iterable, Optional

from . import study

REVIEW_MIN = 1.0      # minutes per review of a known card
NEW_MIN = 2.5         # minutes to study a card for the first time
LEARN_STEPS = (1, 3, 7, 16)  # follow-up reviews of a new card, in days after it is first studied
MAX_DAYS = 366
WEEKDAYS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")
KV_PREFIX = "studyPlan:"


def _parse_day(value: Any) -> Optional[date]:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def settings_of(services: Any, subject_id: str) -> dict[str, Any]:
    return services.store.kv_get(KV_PREFIX + subject_id) or {}


def saved_plans(services: Any) -> list[tuple[dict, dict]]:
    """(subject, settings) for every subject with a saved plan."""
    out = []
    for subject in services.store.list("subject"):
        cfg = settings_of(services, subject["id"])
        if cfg.get("examDate"):
            out.append((subject, cfg))
    return out


def exam_deliverable_dates(services: Any, subject_id: str) -> list[date]:
    """Dates of the subject's pending exam deliverables (how the app records an exam), soonest first."""
    out = []
    for d in services.store.list("deliverable", subject_id):
        when = _parse_day(d.get("dueDate"))
        if d.get("type") == "exam" and when and d.get("status") not in ("done", "submitted"):
            out.append(when)
    return sorted(out)


def _is_page(q: dict) -> bool:
    return bool(q.get("pageHtml"))


def _plain_topics(services: Any, subject_id: str) -> tuple[list[dict], dict[str, str]]:
    topics = services.topics_of(subject_id)
    return topics, {t["id"]: t.get("title") or "" for t in topics}


def build(services: Any, subject: dict, *, exam_date: Optional[str] = None, minutes_per_day: Optional[int] = None,
          rest_days: Optional[Iterable[int]] = None, mock_questions: Optional[int] = None,
          mock_minutes: Optional[int] = None, save: bool = False) -> dict[str, Any]:
    """The day-by-day plan. Missing settings come from the saved plan, then from defaults."""
    sid = subject["id"]
    saved = settings_of(services, sid)
    today = date.fromisoformat(services.today())
    exam_raw = exam_date or saved.get("examDate") or subject.get("examDate")
    if not exam_raw:
        upcoming = [d for d in exam_deliverable_dates(services, sid) if d >= today]
        exam_raw = upcoming[0].isoformat() if upcoming else None
    exam = _parse_day(exam_raw)
    if exam is None:
        raise ValueError("Pon la fecha del examen para preparar el plan.")
    days_left = (exam - today).days
    if days_left < 0:
        raise ValueError(f"La fecha del examen ({exam.isoformat()}) ya ha pasado.")
    if days_left > MAX_DAYS:
        raise ValueError("El examen está a más de un año: el plan cubre como mucho 366 días.")
    minutes = int(minutes_per_day if minutes_per_day is not None else saved.get("minutesPerDay") or 60)
    if not 10 <= minutes <= 600:
        raise ValueError("Los minutos al día deben estar entre 10 y 600.")
    rest = sorted({int(d) for d in (rest_days if rest_days is not None else saved.get("restDays") or [])})
    if any(d < 0 or d > 6 for d in rest):
        raise ValueError("Los días de descanso van de 0 (lunes) a 6 (domingo).")
    if len(rest) == 7:
        raise ValueError("Deja al menos un día de la semana para estudiar.")
    mock_n = int(mock_questions if mock_questions is not None else saved.get("mockQuestions") or 20)
    mock_n = max(5, min(mock_n, 100))
    mock_min = int(mock_minutes if mock_minutes is not None else saved.get("mockMinutes") or round(mock_n * 1.5))
    mock_min = max(5, min(mock_min, 300))

    settings = {"examDate": exam.isoformat(), "minutesPerDay": minutes, "restDays": rest,
                "mockQuestions": mock_n, "mockMinutes": mock_min}
    if save:
        services.store.kv_set(KV_PREFIX + sid, {**settings, "updatedAt": services.now_iso()})

    topics, titles = _plain_topics(services, sid)
    topic_order = {t["id"]: i for i, t in enumerate(topics)}
    questions = [q for q in services.store.list("question", sid) if not _is_page(q)]
    weak = study.weak_topics(services, sid)
    weak_named = [w for w in weak if w["topicId"] is not None and (w["accuracy"] is not None and w["accuracy"] < 0.7
                                                                    or w["failedLast"] > 0)]
    weak_titles = [w["topic"] for w in weak_named][:3]

    calendar = [today + timedelta(days=i) for i in range(days_left)]
    study_days = [d for d in calendar if d.weekday() not in rest]
    study_set = set(study_days)

    def next_study_day(d: date) -> Optional[date]:
        while d < exam:
            if d in study_set:
                return d
            d += timedelta(days=1)
        return None

    reviews: dict[date, int] = {d: 0 for d in study_days}

    def add_review(d: date) -> None:
        day = next_study_day(max(d, today))
        if day is not None:
            reviews[day] += 1

    due_now = 0
    for q in questions:
        st = q.get("stats") or {}
        if not st.get("seen"):
            continue
        nxt = _parse_day(st.get("nextReviewAt"))
        if nxt is None:
            continue
        if nxt <= today:
            due_now += 1
        day = max(nxt, today)
        interval = max(1.0, float(st.get("interval") or 1))
        while day < exam:
            add_review(day)
            interval = interval * 2.5
            day = day + timedelta(days=max(1, round(interval)))

    unseen = sorted((q for q in questions if not (q.get("stats") or {}).get("seen")),
                    key=lambda q: (topic_order.get(q.get("topicId"), 10_000), q.get("createdAt") or "", q["id"]))

    # Special days: the last study day is the final review; timed mocks once a week and a few days before.
    final_day = study_days[-1] if len(study_days) >= 2 else None
    mock_days: set[date] = set()
    if len(study_days) >= 5 and questions:
        target = next_study_day(exam - timedelta(days=3)) or study_days[-2]
        if target == final_day:
            target = study_days[-2]
        mock_days.add(target)
        if days_left >= 12:
            d = today + timedelta(days=6)
            while d < target - timedelta(days=4):
                day = next_study_day(d)
                if day and day not in (final_day,) and day < target:
                    mock_days.add(day)
                d += timedelta(days=7)
    learning = [d for d in study_days if d != final_day and d not in mock_days]
    cutoff = exam - timedelta(days=2)
    early = [d for d in learning if d <= cutoff] or learning or study_days

    new_by_day: dict[date, list[dict]] = {d: [] for d in study_days}
    pending = list(unseen)
    for i, day in enumerate(early):
        if not pending:
            break
        left_days = len(early) - i
        take = math.ceil(len(pending) / left_days)
        chosen, pending = pending[:take], pending[take:]
        new_by_day[day] = chosen
        for step in LEARN_STEPS:
            follow = day + timedelta(days=step)
            if follow < exam:
                add_review(follow)

    days_out: list[dict[str, Any]] = []
    rotate = 0
    peak = 0
    for d in calendar + [exam]:
        entry: dict[str, Any] = {"date": d.isoformat(), "weekday": WEEKDAYS[d.weekday()],
                                 "inDays": (d - today).days}
        if d == exam:
            entry.update(kind="exam", minutes=0, newCards=0, reviews=0, topics=[],
                         tasks=[f"Examen de {subject.get('name') or 'la asignatura'}."])
            days_out.append(entry)
            continue
        if d not in study_set:
            entry.update(kind="rest", minutes=0, newCards=0, reviews=0, topics=[], tasks=["Descanso."])
            days_out.append(entry)
            continue
        n_rev = reviews.get(d, 0)
        new = new_by_day.get(d, [])
        new_topics: list[str] = []
        for q in new:
            title = titles.get(q.get("topicId") or "", "")
            if title and title not in new_topics:
                new_topics.append(title)
        tasks: list[str] = []
        if d in mock_days:
            kind = "mock"
            tasks.append(f"Simulacro cronometrado: {min(mock_n, len(questions))} preguntas en {mock_min} min, "
                         "con más peso en tus temas flojos.")
            if n_rev:
                tasks.append(f"Repasa {n_rev} tarjeta{'s' if n_rev != 1 else ''} pendiente{'s' if n_rev != 1 else ''}.")
            mins = mock_min + n_rev * REVIEW_MIN
            focus = weak_titles[:2]
        elif d == final_day:
            kind = "final"
            focus = weak_titles[:3]
            tasks.append("Repaso final: las tarjetas falladas y las marcadas como difíciles"
                         + (f"; insiste en {', '.join(focus)}." if focus else "."))
            if n_rev:
                tasks.append(f"Repasa {n_rev} tarjeta{'s' if n_rev != 1 else ''} pendiente{'s' if n_rev != 1 else ''}.")
            tasks.append("Acuéstate pronto: nada nuevo la víspera.")
            mins = max(n_rev * REVIEW_MIN, min(minutes, 45))
        else:
            kind = "study"
            focus = list(new_topics)
            if weak_titles:
                pick = weak_titles[rotate % len(weak_titles)]
                rotate += 1
                if pick not in focus:
                    focus.append(pick)
            if n_rev:
                tasks.append(f"Repasa {n_rev} tarjeta{'s' if n_rev != 1 else ''} pendiente{'s' if n_rev != 1 else ''}.")
            if new:
                where = f" de {', '.join('«' + t + '»' for t in new_topics)}" if new_topics else ""
                tasks.append(f"Estudia {len(new)} tarjeta{'s' if len(new) != 1 else ''} nueva{'s' if len(new) != 1 else ''}{where}.")
            if weak_titles and focus and focus[-1] in weak_titles:
                tasks.append(f"Dedica un rato extra a «{focus[-1]}», uno de tus temas flojos.")
            if not tasks:
                tasks.append("Día ligero: repasa tus conceptos clave o pregunta dudas al tutor del Cuaderno.")
            mins = n_rev * REVIEW_MIN + len(new) * NEW_MIN
        mins = int(math.ceil(mins))
        peak = max(peak, mins)
        entry.update(kind=kind, minutes=mins, newCards=len(new), reviews=n_rev, topics=focus, tasks=tasks,
                     overload=mins > minutes)
        if d == today:
            entry["newCardIds"] = [q["id"] for q in new]
        days_out.append(entry)

    warnings: list[str] = []
    if not questions:
        warnings.append("La asignatura no tiene preguntas todavía: añade preguntas o genera unas desde el Cuaderno.")
    if days_left == 0:
        warnings.append("El examen es hoy: repasa solo lo fallado y los conceptos clave.")
    elif days_left < 3:
        warnings.append("Quedan muy pocos días: el plan prioriza repasar lo visto antes que estudiar todo lo nuevo.")
    over = [d for d in days_out if d.get("overload")]
    if over:
        warnings.append(f"{len(over)} día{'s' if len(over) != 1 else ''} pide{'n' if len(over) != 1 else ''} más de "
                        f"{minutes} min (hasta {peak} min). Sube los minutos al día, quita días de descanso o empieza antes.")
    if pending:
        warnings.append(f"{len(pending)} tarjetas nuevas no caben antes del examen.")

    today_entry = next((d for d in days_out if d["date"] == today.isoformat()), None)
    new_ids = today_entry.pop("newCardIds", []) if today_entry else []
    due_today = sorted((q for q in questions if (q.get("stats") or {}).get("seen")
                        and (_parse_day((q.get("stats") or {}).get("nextReviewAt")) or exam) <= today),
                       key=lambda q: ((q.get("stats") or {}).get("nextReviewAt") or "", q["id"]))
    review_ids = [q["id"] for q in due_today] if today_entry and today_entry["kind"] in ("study", "mock", "final") else []
    seen_n = sum(1 for q in questions if (q.get("stats") or {}).get("seen"))
    return {
        "subject": {"id": sid, "name": subject.get("name")},
        "settings": settings,
        "saved": bool(save or saved),
        "today": today.isoformat(),
        "daysLeft": days_left,
        "studyDays": len(study_days),
        "totals": {"questions": len(questions), "seen": seen_n, "unseen": len(unseen), "dueNow": due_now,
                   "seenPct": round(100 * seen_n / len(questions), 1) if questions else 0.0,
                   "mocks": len(mock_days), "peakMinutes": peak},
        "weakTopics": [{"topicId": w["topicId"], "topic": w["topic"], "accuracy": w["accuracy"], "score": w["score"]}
                       for w in weak_named[:5]],
        "todayPlan": {"kind": today_entry["kind"] if today_entry else "exam",
                      "questionIds": review_ids + new_ids,
                      "reviewIds": review_ids, "newIds": new_ids,
                      "mock": bool(today_entry and today_entry["kind"] == "mock")},
        "days": days_out,
        "warnings": warnings,
        "feasible": not over and not pending,
    }


def clear(services: Any, subject_id: str) -> bool:
    had = bool(settings_of(services, subject_id))
    with services.db.lock:
        services.db.conn.execute("DELETE FROM kv WHERE key=?", (KV_PREFIX + subject_id,))
    return had


def agenda_items(services: Any, date_from: date, date_to: date) -> list[dict[str, Any]]:
    """Each saved plan's study days in the range (one all-day item each) and its exam date."""
    from . import familyevents

    items: list[dict[str, Any]] = []
    for subject, _cfg in saved_plans(services):
        try:
            result = build(services, subject)
        except ValueError:
            continue
        name = subject.get("name") or "asignatura"
        url = familyevents.app_link(services, f"subject/{subject['id']}?tab=plan")
        for day in result["days"]:
            d = date.fromisoformat(day["date"])
            if not date_from <= d <= date_to or day["kind"] in ("rest",):
                continue
            if day["kind"] == "exam":
                if _parse_day(subject.get("examDate")) or d in exam_deliverable_dates(services, subject["id"]):
                    continue  # the subject's own exam item (or its exam deliverable) already says it
                items.append({"id": f"hypatia:exam:{subject['id']}", "title": f"Examen: {name}", "start": d.isoformat(),
                              "kind": "exam", "priority": "high" if day["inDays"] <= 7 else "normal", "url": url})
                continue
            if not day["minutes"]:
                continue
            what = {"mock": "simulacro cronometrado", "final": "repaso final"}.get(day["kind"])
            if what is None:
                parts = []
                if day["newCards"]:
                    parts.append(f"{day['newCards']} nuevas")
                if day["reviews"]:
                    parts.append(f"{day['reviews']} repasos")
                what = ", ".join(parts)
            items.append({"id": f"hypatia:plan:{subject['id']}:{day['date']}", "all_day": True, "start": day["date"],
                          "kind": "review", "title": f"Plan de {name}: {what} (~{day['minutes']} min)",
                          "priority": "high" if day["kind"] in ("mock", "final") else "normal", "url": url})
    return items


__all__ = ["build", "clear", "agenda_items", "settings_of", "saved_plans"]
