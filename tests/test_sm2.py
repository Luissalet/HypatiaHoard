"""sm2.py: port of spacedRepetition.ts + the graded variant + updateStats."""

from datetime import datetime, timezone

import pytest

from hypatia.sm2 import calc_next_review, calc_next_review_graded, parse_grade, updated_stats

NOW = datetime(2026, 9, 25, 23, 30, tzinfo=timezone.utc)


def test_correct_sequence_matches_typescript():
    s = calc_next_review({}, "CORRECT", NOW)
    assert s == {"easeFactor": pytest.approx(2.6), "interval": 1, "repetitions": 1, "nextReviewAt": "2026-09-26"}
    s = calc_next_review(s, "CORRECT", NOW)
    assert (s["interval"], s["repetitions"]) == (6, 2) and s["nextReviewAt"] == "2026-10-01"
    s = calc_next_review(s, "CORRECT", NOW)
    assert s["interval"] == round(6 * 2.8) and s["repetitions"] == 3


def test_wrong_resets_and_floors_ease():
    s = calc_next_review({"easeFactor": 1.4, "interval": 20, "repetitions": 5}, "WRONG", NOW)
    assert s == {"easeFactor": 1.3, "interval": 1, "repetitions": 0, "nextReviewAt": "2026-09-26"}


def test_graded_variant_qualities():
    base = {"easeFactor": 2.5, "interval": 6, "repetitions": 2}
    assert calc_next_review_graded(base, "easy", NOW) == calc_next_review(base, "CORRECT", NOW)
    assert calc_next_review_graded(base, "again", NOW) == calc_next_review(base, "WRONG", NOW)
    hard = calc_next_review_graded(base, "hard", NOW)
    assert hard["easeFactor"] == pytest.approx(2.5 - 0.14) and hard["interval"] == round(6 * 2.36) and hard["repetitions"] == 3
    good = calc_next_review_graded(base, 2, NOW)
    assert good["easeFactor"] == pytest.approx(2.5) and good["interval"] == 15


def test_js_math_round_half_up():
    # interval 5 * ease 2.5 = 12.5 -> Math.round gives 13 (Python's round would give 12)
    s = calc_next_review_graded({"easeFactor": 2.5, "interval": 5, "repetitions": 3}, "good", NOW)
    assert s["interval"] == 13


def test_parse_grade():
    assert [parse_grade(x) for x in (0, 1, 2, 3, "Easy", " hard ")] == ["again", "hard", "good", "easy", "easy", "hard"]
    with pytest.raises(ValueError):
        parse_grade(7)


def test_updated_stats_like_update_stats():
    stats = updated_stats({"seen": 2, "correct": 1, "wrong": 1, "junk": 1}, "hard", NOW, "2026-09-25T23:30:00.000Z")
    assert stats["seen"] == 3 and stats["correct"] == 2 and stats["wrong"] == 1
    assert stats["lastResult"] == "CORRECT" and stats["lastSeenAt"] == "2026-09-25T23:30:00.000Z"
    assert "junk" not in stats and stats["repetitions"] == 1
    assert updated_stats(stats, "again", NOW, "x")["lastResult"] == "WRONG"
