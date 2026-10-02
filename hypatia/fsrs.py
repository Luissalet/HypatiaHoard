"""FSRS-5 scheduler (Free Spaced Repetition Scheduler) with day granularity.

Same maths as src/domain/fsrs.ts (tests/test_fsrs.py runs both and compares).
Each review updates two numbers per card: stability S (days until recall drops
to 90 %) and difficulty D (1-10). The next interval is the day on which the
predicted recall falls to the desired retention (0.9 by default), so easy cards
space out faster than with SM-2 and hard ones come back sooner.

Cards that only have SM-2 state start from it: S = their current interval and
D from the ease factor, so switching scheduler never resets a bank.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Any

# FSRS-5 default parameters (w0..w18).
W = (0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
     1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621)
DECAY = -0.5
FACTOR = 19 / 81  # so that R(S, S) = 0.9
RATING = {"again": 1, "hard": 2, "good": 3, "easy": 4}
MAX_INTERVAL = 36500
MIN_RETENTION, MAX_RETENTION, DEFAULT_RETENTION = 0.7, 0.97, 0.9
SCHEDULERS = ("sm2", "fsrs")


def js_round(x: float) -> int:
    """Math.round: halves round up (towards +inf)."""
    return int(math.floor(x + 0.5))


def _r4(x: float) -> float:
    """Stored precision: 4 decimals, rounded the way Math.round does."""
    return math.floor(x * 10000 + 0.5) / 10000


def clamp_retention(value: Any) -> float:
    try:
        r = float(value)
    except (TypeError, ValueError):
        return DEFAULT_RETENTION
    if math.isnan(r) or math.isinf(r):
        return DEFAULT_RETENTION
    return min(MAX_RETENTION, max(MIN_RETENTION, r))


def _clamp_d(d: float) -> float:
    return min(10.0, max(1.0, d))


def retrievability(elapsed_days: float, stability: float) -> float:
    """Predicted probability of recall after `elapsed_days`."""
    return (1 + FACTOR * max(0.0, elapsed_days) / stability) ** DECAY


def next_interval(stability: float, retention: float = DEFAULT_RETENTION) -> int:
    days = stability / FACTOR * (retention ** (1 / DECAY) - 1)
    return min(MAX_INTERVAL, max(1, js_round(days)))


def init_stability(rating: int) -> float:
    return max(0.1, W[rating - 1])


def init_difficulty(rating: int) -> float:
    return _clamp_d(W[4] - math.exp(W[5] * (rating - 1)) + 1)


def next_difficulty(d: float, rating: int) -> float:
    delta = -W[6] * (rating - 3)
    damped = d + delta * (10 - d) / 9
    return _clamp_d(W[7] * init_difficulty(4) + (1 - W[7]) * damped)


def stability_after_recall(d: float, s: float, r: float, rating: int) -> float:
    hard = W[15] if rating == 2 else 1.0
    easy = W[16] if rating == 4 else 1.0
    inc = math.exp(W[8]) * (11 - d) * s ** (-W[9]) * (math.exp(W[10] * (1 - r)) - 1) * hard * easy
    return s * (1 + inc)


def stability_after_forget(d: float, s: float, r: float) -> float:
    s_f = W[11] * d ** (-W[12]) * ((s + 1) ** W[13] - 1) * math.exp(W[14] * (1 - r))
    return min(s, s_f)


def stability_same_day(s: float, rating: int) -> float:
    return s * math.exp(W[17] * (rating - 3 + W[18]))


def difficulty_from_ease(ease: Any) -> float:
    """SM-2 ease 2.5 -> D 6.2; 1.3 -> 10; 2.9 -> 4.6."""
    try:
        ef = float(ease)
    except (TypeError, ValueError):
        ef = 2.5
    if math.isnan(ef) or math.isinf(ef):
        ef = 2.5
    return _clamp_d(11 - 4 * (ef - 1.3))


def _day(iso: str | None) -> date | None:
    if not iso:
        return None
    try:
        return date.fromisoformat(str(iso)[:10])
    except ValueError:
        return None


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def step(stats: dict[str, Any] | None, grade: str, now: datetime,
         retention: float = DEFAULT_RETENTION) -> dict[str, Any]:
    """Schedule fields after one review: fsrsStability, fsrsDifficulty, interval,
    repetitions, easeFactor (kept so SM-2 can take over again) and nextReviewAt."""
    stats = stats or {}
    rating = RATING[grade]
    retention = clamp_retention(retention)
    today = now.astimezone(timezone.utc).date()
    s = stats.get("fsrsStability")
    d = stats.get("fsrsDifficulty")
    if not (_num(s) and s > 0 and _num(d)):
        if stats.get("seen") and stats.get("interval"):
            s, d = max(0.1, float(stats["interval"])), difficulty_from_ease(stats.get("easeFactor"))
        else:
            s, d = None, None
    if s is None:
        new_s, new_d = init_stability(rating), init_difficulty(rating)
    else:
        last = _day(stats.get("lastSeenAt"))
        elapsed = (today - last).days if last else max(1, js_round(s))
        if elapsed <= 0:
            new_s = stability_same_day(s, rating)
        else:
            r = retrievability(elapsed, s)
            new_s = stability_after_forget(d, s, r) if rating == 1 else stability_after_recall(d, s, r, rating)
        new_d = next_difficulty(d, rating)
    new_s = min(float(MAX_INTERVAL), max(0.1, new_s))
    interval = next_interval(new_s, retention)
    reps = stats.get("repetitions") or 0
    ease = stats.get("easeFactor")
    return {"easeFactor": 2.5 if ease is None else ease, "interval": interval,
            "repetitions": 0 if rating == 1 else reps + 1,
            "fsrsStability": _r4(new_s), "fsrsDifficulty": _r4(new_d),
            "nextReviewAt": (today + timedelta(days=interval)).isoformat()}


def preview(stats: dict[str, Any] | None, now: datetime, retention: float = DEFAULT_RETENTION) -> dict[str, int]:
    """Days until the next review for each possible grade."""
    return {g: step(stats, g, now, retention)["interval"] for g in RATING}


def card_retrievability(stats: dict[str, Any] | None, today: str) -> float | None:
    """Current predicted recall of a card that has FSRS state, else None."""
    stats = stats or {}
    s, last = stats.get("fsrsStability"), _day(stats.get("lastSeenAt"))
    if not (_num(s) and s > 0) or last is None:
        return None
    return round(retrievability((date.fromisoformat(today) - last).days, s), 3)


def settings_of(synced: dict[str, Any] | None) -> tuple[str, float]:
    """(scheduler, desired retention) from the synced app settings."""
    synced = synced or {}
    scheduler = synced.get("scheduler") if synced.get("scheduler") in SCHEDULERS else "sm2"
    return scheduler, clamp_retention(synced.get("desiredRetention", DEFAULT_RETENTION))
