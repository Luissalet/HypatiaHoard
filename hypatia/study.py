"""Study features over the bank: due queue, graded review, weak topics, mock
exams, statistics and upcoming deliverables."""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any

from . import bank
from .hashing import normalize_text
from .sm2 import grade_result, parse_grade, updated_stats

NO_TOPIC = "(sin tema)"


def _stats(q: dict) -> dict:
    return q.get("stats") or {}


def _questions(services, subject_id: str | None, topic_id: str | None) -> list[dict]:
    items = services.store.list("question", subject_id)
    if topic_id:
        items = [q for q in items if q.get("topicId") == topic_id or topic_id in (q.get("topicIds") or [])]
    return items


# ---------- due queue ----------

def due_queue(services, subject_id: str | None, topic_id: str | None, limit: int) -> dict:
    """Overdue first (oldest nextReviewAt first), then never seen, then last answered wrong."""
    today = services.today()
    items = _questions(services, subject_id, topic_id)
    due = sorted((q for q in items if _stats(q).get("nextReviewAt") and _stats(q)["nextReviewAt"] <= today),
                 key=lambda q: (_stats(q)["nextReviewAt"], q["id"]))
    due_ids = {q["id"] for q in due}
    fresh = sorted((q for q in items if q["id"] not in due_ids and not _stats(q).get("seen")),
                   key=lambda q: (q.get("createdAt") or "", q["id"]))
    fresh_ids = {q["id"] for q in fresh}
    failed = sorted((q for q in items if q["id"] not in due_ids | fresh_ids and _stats(q).get("lastResult") == "WRONG"),
                    key=lambda q: (_stats(q).get("lastSeenAt") or "", q["id"]))
    queue = (due + fresh + failed)[:limit]
    titles = bank.topic_titles(services, subject_id)
    return {"queue": [bank.brief(q, True, titles) for q in queue], "count": len(queue),
            "totals": {"due": len(due), "neverSeen": len(fresh), "failed": len(failed)}, "today": today}


# ---------- review ----------

def pick_reviewed_question(services, id: str | None, prompt: str | None, subject_id: str | None) -> dict:
    """The prompt the user saw wins over the id (a model may pass an ordinal as id)."""
    by_prompt = bank.find_by_prompt(services, prompt, subject_id) if (prompt or "").strip() else []
    if id is None and not by_prompt:
        if (prompt or "").strip():
            raise LookupError(f"No question has the prompt «{prompt}».")
        raise ValueError("card_review needs the question's id or the prompt shown.")
    question = services.store.get("question", id) if id else None
    if question is not None and (not (prompt or "").strip()
                                 or normalize_text(prompt) == normalize_text(question.get("prompt") or "")):
        return question
    if len(by_prompt) == 1:
        return by_prompt[0]
    if len(by_prompt) > 1:
        raise ValueError(f"{len(by_prompt)} questions have that prompt; pass the subject or the id from cards_due.")
    if question is None:
        raise LookupError(f"Question {id} does not exist.")
    raise ValueError(f"Question {id} is «{question.get('prompt')}», not «{prompt}»; no grade recorded.")


def _bump_streak(services) -> None:
    """sessionRepo.finish's streak rule, applied to the synced settings."""
    settings = services.store.kv_get("syncedSettings") or {"alias": "", "importedPackIds": []}
    today = services.today()
    last = settings.get("lastStudyDate")
    if last == today:
        return
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    streak = (settings.get("studyStreak") or 0) + 1 if last == yesterday else 1
    # Settings travel in every pull; the review's own put bumps the revision.
    services.store.kv_set("syncedSettings", {**settings, "studyStreak": streak, "lastStudyDate": today})


def review(services, question: dict, grade: Any, via: str = "agent") -> dict:
    grade = parse_grade(grade)
    now_iso = services.now_iso()
    stats = updated_stats(question.get("stats"), grade, services.now(), now_iso)
    updated = {**question, "stats": stats, "updatedAt": now_iso}
    with services.db.tx() as conn:
        services.store.put("question", updated)
        conn.execute("INSERT INTO reviews(question_id, grade, result, at, via) VALUES (?,?,?,?,?)",
                     (question["id"], grade, grade_result(grade), now_iso, via))
        _bump_streak(services)
    nxt = due_queue(services, question.get("subjectId"), None, 2)["queue"]
    nxt = [q for q in nxt if q["id"] != question["id"]][:1]
    return {"question": bank.brief(updated, True), "grade": grade, "result": grade_result(grade),
            "nextReviewAt": stats.get("nextReviewAt"), "next": nxt[0] if nxt else None}


# ---------- weak topics ----------

def weak_topics(services, subject_id: str) -> list[dict]:
    today = services.today()
    topics = services.topics_of(subject_id)
    buckets: dict[str | None, list[dict]] = {t["id"]: [] for t in topics}
    for q in services.store.list("question", subject_id):
        key = q.get("topicId") if q.get("topicId") in buckets else None
        buckets.setdefault(key, []).append(q)
    titles = {t["id"]: t.get("title") for t in topics}
    rows = []
    for topic_id, items in buckets.items():
        if not items:
            continue
        n = len(items)
        correct = sum(_stats(q).get("correct") or 0 for q in items)
        wrong = sum(_stats(q).get("wrong") or 0 for q in items)
        seen_q = sum(1 for q in items if _stats(q).get("seen"))
        overdue = sum(1 for q in items if _stats(q).get("nextReviewAt") and _stats(q)["nextReviewAt"] <= today)
        never = n - seen_q
        starred = sum(1 for q in items if q.get("starred"))
        failed_last = sum(1 for q in items if _stats(q).get("lastResult") == "WRONG")
        accuracy = correct / (correct + wrong) if correct + wrong else None
        score = (0.45 * (1 - accuracy if accuracy is not None else 0.5) + 0.2 * failed_last / n
                 + 0.15 * overdue / n + 0.1 * never / n + 0.1 * starred / n)
        rows.append({"topicId": topic_id, "topic": titles.get(topic_id, NO_TOPIC), "questions": n, "seen": seen_q,
                     "accuracy": None if accuracy is None else round(accuracy, 3), "overdue": overdue,
                     "neverSeen": never, "failedLast": failed_last, "starred": starred, "score": round(100 * score, 1)})
    rows.sort(key=lambda r: (-r["score"], r["topic"] or ""))
    return rows


# ---------- mock exam ----------

def _priority(q: dict, today: str) -> tuple:
    s = _stats(q)
    return (0 if s.get("lastResult") == "WRONG" else 1 if (s.get("nextReviewAt") or "9999") <= today else
            2 if not s.get("seen") else 3, q.get("starred") is not True)


def mock_exam(services, subject: dict, n: int, topic_id: str | None, types: list[str] | None, save: bool) -> dict:
    today = services.today()
    rng = random.Random(services.now().timestamp())
    pool = [q for q in _questions(services, subject["id"], topic_id) if not types or q.get("type") in types]
    if not pool:
        raise LookupError("No questions match that subject/topic/types.")
    by_topic: dict[str | None, list[dict]] = {}
    for q in pool:
        by_topic.setdefault(q.get("topicId"), []).append(q)
    weights = {r["topicId"]: r["score"] + 10 for r in weak_topics(services, subject["id"])}
    for items in by_topic.values():
        rng.shuffle(items)
        items.sort(key=lambda q: _priority(q, today))
    chosen: list[dict] = []
    n = min(n, len(pool))
    while len(chosen) < n:
        live = [k for k, v in by_topic.items() if v]
        total = sum(weights.get(k, 10) for k in live)
        pick = rng.uniform(0, total)
        for key in live:
            pick -= weights.get(key, 10)
            if pick <= 0:
                break
        chosen.append(by_topic[key].pop(0))
    rng.shuffle(chosen)
    now = services.now_iso()
    exam = {"id": bank.new_id(), "subjectId": subject["id"], "name": f"Simulacro {today}",
            "description": f"Simulacro de {len(chosen)} preguntas generado por Hypatia (ponderado a temas débiles).",
            "questionIds": [q["id"] for q in chosen], "createdAt": now, "updatedAt": now}
    if save:
        services.store.put("exam", exam)
    titles = bank.topic_titles(services, subject["id"])
    return {"exam": exam, "saved": save,
            "questions": [bank.brief(q, False, titles) for q in chosen],
            "note": "Answers are withheld: ask one question at a time, then use answer_grade and card_review."}


# ---------- stats ----------

def upcoming_deliverables(services, subject_id: str | None, days: int) -> list[dict]:
    today = services.today()
    until = (date.fromisoformat(today) + timedelta(days=days)).isoformat()
    names = {s["id"]: s.get("name") for s in services.store.list("subject")}
    rows = []
    for d in services.store.list("deliverable", subject_id):
        due = d.get("dueDate")
        if d.get("status") in ("done", "submitted") or not due or not (today <= due <= until):
            continue
        rows.append({"id": d["id"], "subject": names.get(d.get("subjectId")), "subjectId": d.get("subjectId"),
                     "name": d.get("name"), "type": d.get("type"), "status": d.get("status"), "dueDate": due,
                     "dueTime": d.get("dueTime"), "daysLeft": (date.fromisoformat(due) - date.fromisoformat(today)).days})
    rows.sort(key=lambda r: (r["dueDate"], r.get("dueTime") or ""))
    return rows


def _subject_stats(services, subject: dict, today: str) -> dict:
    items = services.store.list("question", subject["id"])
    n = len(items)
    seen = sum(1 for q in items if _stats(q).get("seen"))
    correct = sum(_stats(q).get("correct") or 0 for q in items)
    wrong = sum(_stats(q).get("wrong") or 0 for q in items)
    out = {"id": subject["id"], "name": subject.get("name"), "questions": n,
           "seenPct": round(100 * seen / n, 1) if n else 0.0,
           "accuracy": round(correct / (correct + wrong), 3) if correct + wrong else None,
           "dueToday": sum(1 for q in items if _stats(q).get("nextReviewAt") and _stats(q)["nextReviewAt"] <= today),
           "examDate": subject.get("examDate"), "daysToExam": None}
    if subject.get("examDate"):
        try:
            out["daysToExam"] = (date.fromisoformat(subject["examDate"][:10]) - date.fromisoformat(today)).days
        except ValueError:
            pass
    out["upcomingDeliverables"] = upcoming_deliverables(services, subject["id"], 30)[:5]
    return out


def stats(services, subject: dict | None) -> dict:
    today = services.today()
    subjects = [subject] if subject else sorted(services.store.list("subject"), key=lambda s: s.get("name") or "")
    settings = services.store.kv_get("syncedSettings") or {}
    with services.db.lock:
        reviewed_today = services.db.conn.execute("SELECT COUNT(*) FROM reviews WHERE substr(at,1,10)=?", (today,)).fetchone()[0]
    streak = settings.get("studyStreak") or 0
    last = settings.get("lastStudyDate")
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    return {"today": today, "streak": streak if last in (today, yesterday) else 0, "lastStudyDate": last,
            "reviewedTodayInChat": reviewed_today, "subjects": [_subject_stats(services, s, today) for s in subjects]}
