"""Exact port of src/domain/spacedRepetition.ts (+ a graded variant) and of
questionRepo.updateStats (src/data/repos.ts)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

GRADE_QUALITY = {"again": 0, "hard": 3, "good": 4, "easy": 5}
GRADE_ALIASES = {
    "0": "again", "1": "hard", "2": "good", "3": "easy",
    "again": "again", "hard": "hard", "good": "good", "easy": "easy",
    "wrong": "again", "fail": "again", "mal": "again", "otra": "again", "otra vez": "again",
    "dificil": "hard", "difícil": "hard", "bien": "good", "facil": "easy", "fácil": "easy",
}


def parse_grade(value: Any) -> str:
    """again/hard/good/easy from a word or 0-3."""
    if isinstance(value, bool):
        raise ValueError("Grade must be again/hard/good/easy or 0-3.")
    key = str(value).strip().lower()
    if key in GRADE_ALIASES:
        return GRADE_ALIASES[key]
    raise ValueError(f"Unknown grade {value!r}; use again/hard/good/easy or 0-3.")


def grade_result(grade: str) -> str:
    return "WRONG" if grade == "again" else "CORRECT"


def _to_date(now: datetime, days: int) -> str:
    return (now.astimezone(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")


def js_round(x: float) -> int:
    """Math.round: halves round up (towards +inf)."""
    import math

    return int(math.floor(x + 0.5))


def _calc(current: dict[str, Any], q: int, now: datetime) -> dict[str, Any]:
    ef = current.get("easeFactor")
    ef = 2.5 if ef is None else ef
    reps = current.get("repetitions")
    reps = 0 if reps is None else reps
    new_ef = max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    if q < 3:
        interval, new_reps = 1, 0
    else:
        new_reps = reps + 1
        if reps == 0:
            interval = 1
        elif reps == 1:
            interval = 6
        else:
            prev = current.get("interval")
            interval = js_round((1 if prev is None else prev) * new_ef)
    return {"easeFactor": new_ef, "interval": interval, "repetitions": new_reps, "nextReviewAt": _to_date(now, interval)}


def calc_next_review(current: dict[str, Any], result: str, now: datetime) -> dict[str, Any]:
    return _calc(current, 5 if result == "CORRECT" else 0, now)


def calc_next_review_graded(current: dict[str, Any], grade: str, now: datetime) -> dict[str, Any]:
    return _calc(current, GRADE_QUALITY[parse_grade(grade)], now)


def updated_stats(stats: dict[str, Any] | None, grade: str, now: datetime, now_iso: str) -> dict[str, Any]:
    """questionRepo.updateStats with a graded SM-2 step."""
    stats = dict(stats or {})
    grade = parse_grade(grade)
    result = grade_result(grade)
    out = {
        "seen": (stats.get("seen") or 0) + 1,
        "correct": (stats.get("correct") or 0) + (1 if result == "CORRECT" else 0),
        "wrong": (stats.get("wrong") or 0) + (1 if result == "WRONG" else 0),
        "lastSeenAt": now_iso,
        "lastResult": result,
    }
    out.update(calc_next_review_graded(stats, grade, now))
    return out
