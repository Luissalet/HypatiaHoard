"""SM-2 spaced-repetition scheduler. Pure functions over plain values — no
database, no wall clock — so every rule is unit-testable with a fixed `now`.

Grades: 0 again, 1 hard, 2 good, 3 easy.

Rules (classic SM-2, as specified for this app):
  again → repetitions 0, interval 0 (due again in 10 minutes), ease -0.2,
          lapses +1, state "lapsed" if it was "review", else "learning".
  hard  → interval = max(1, round(interval * 1.2)), ease -0.15.
  good  → new/learning/lapsed (relearning): interval 1 day on the first good,
          6 days on the second; review: interval = round(interval * ease).
  easy  → like good, then interval *= 1.3, ease +0.15.
  Every non-again interval is capped at 365 days. Ease never drops below 1.3.
  A card graduates to "review" once it has reached 2+ repetitions since its
  last lapse (or since it was created, for a card that never lapsed).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

MIN_EASE = 1.3
MAX_INTERVAL_DAYS = 365
AGAIN_DELAY_SECONDS = 10 * 60
DAY_SECONDS = 86400

RELEARNING_STATES = ("new", "learning", "lapsed")


class Grade(IntEnum):
    AGAIN = 0
    HARD = 1
    GOOD = 2
    EASY = 3


GRADE_NAMES = {"again": Grade.AGAIN, "hard": Grade.HARD, "good": Grade.GOOD, "easy": Grade.EASY}


def parse_grade(value) -> Grade:
    """Accept an int 0..3 or one of the words "again|hard|good|easy"."""
    if isinstance(value, str):
        key = value.strip().lower()
        if key not in GRADE_NAMES:
            raise ValueError(f"Unknown grade: {value!r} (use again, hard, good, easy or 0-3).")
        return GRADE_NAMES[key]
    try:
        grade = Grade(int(value))
    except (ValueError, TypeError) as error:
        raise ValueError(f"Unknown grade: {value!r} (use again, hard, good, easy or 0-3).") from error
    return grade


@dataclass(frozen=True)
class CardSchedule:
    ease: float
    interval_days: int
    repetitions: int
    lapses: int
    state: str
    due_at: float


def grade_card(
    *,
    ease: float,
    interval_days: int,
    repetitions: int,
    lapses: int,
    state: str,
    grade: Grade,
    now: float,
) -> CardSchedule:
    """Apply one review grade to a card's current schedule and return the new one."""
    if grade == Grade.AGAIN:
        new_ease = max(MIN_EASE, ease - 0.2)
        new_state = "lapsed" if state == "review" else "learning"
        return CardSchedule(ease=new_ease, interval_days=0, repetitions=0, lapses=lapses + 1,
                             state=new_state, due_at=now + AGAIN_DELAY_SECONDS)

    if grade == Grade.HARD:
        new_ease = max(MIN_EASE, ease - 0.15)
        new_reps = repetitions + 1
        new_interval = max(1, round(interval_days * 1.2))
        new_interval = min(new_interval, MAX_INTERVAL_DAYS)
        new_state = "review" if new_reps >= 2 else "learning"
        return CardSchedule(ease=new_ease, interval_days=new_interval, repetitions=new_reps, lapses=lapses,
                             state=new_state, due_at=now + new_interval * DAY_SECONDS)

    # good and easy share the tiered/graduated interval logic
    new_reps = repetitions + 1
    if state in RELEARNING_STATES:
        base_interval = 1 if new_reps == 1 else 6
        new_state = "review" if new_reps >= 2 else "learning"
    else:  # already in "review"
        base_interval = round(interval_days * ease)
        new_state = "review"

    if grade == Grade.GOOD:
        new_ease = ease
        new_interval = base_interval
    else:  # EASY
        new_ease = ease + 0.15
        new_interval = round(base_interval * 1.3)
        new_state = "review"

    new_interval = max(1, min(new_interval, MAX_INTERVAL_DAYS))
    return CardSchedule(ease=new_ease, interval_days=new_interval, repetitions=new_reps, lapses=lapses,
                         state=new_state, due_at=now + new_interval * DAY_SECONDS)
