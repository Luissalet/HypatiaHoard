"""SM-2 scheduler: every grade path, caps, lapses, ease floor."""

import pytest

from hypatia.scheduler import Grade, MAX_INTERVAL_DAYS, MIN_EASE, grade_card, parse_grade

NOW = 1_700_000_000.0
DAY = 86400


def test_parse_grade_accepts_ints_and_words():
    assert parse_grade(0) == Grade.AGAIN
    assert parse_grade("good") == Grade.GOOD
    assert parse_grade("EASY") == Grade.EASY
    assert parse_grade(3) == Grade.EASY
    with pytest.raises(ValueError):
        parse_grade("wrong")
    with pytest.raises(ValueError):
        parse_grade(9)


def test_again_from_review_lapses_and_sets_ten_minute_due():
    result = grade_card(ease=2.5, interval_days=10, repetitions=3, lapses=0, state="review", grade=Grade.AGAIN, now=NOW)
    assert result.ease == pytest.approx(2.3)
    assert result.interval_days == 0
    assert result.repetitions == 0
    assert result.lapses == 1
    assert result.state == "lapsed"
    assert result.due_at == NOW + 600


def test_again_from_learning_does_not_become_lapsed():
    result = grade_card(ease=2.5, interval_days=0, repetitions=0, lapses=0, state="learning", grade=Grade.AGAIN, now=NOW)
    assert result.state == "learning"
    assert result.lapses == 1


def test_ease_never_drops_below_floor():
    result = grade_card(ease=1.35, interval_days=5, repetitions=1, lapses=2, state="review", grade=Grade.AGAIN, now=NOW)
    assert result.ease == MIN_EASE
    result2 = grade_card(ease=MIN_EASE, interval_days=5, repetitions=1, lapses=2, state="review", grade=Grade.HARD, now=NOW)
    assert result2.ease == MIN_EASE


def test_hard_on_new_card_gives_one_day_and_stays_learning():
    result = grade_card(ease=2.5, interval_days=0, repetitions=0, lapses=0, state="new", grade=Grade.HARD, now=NOW)
    assert result.interval_days == 1
    assert result.repetitions == 1
    assert result.state == "learning"
    assert result.ease == pytest.approx(2.35)
    assert result.due_at == NOW + DAY


def test_hard_graduates_to_review_on_second_repetition():
    result = grade_card(ease=2.35, interval_days=1, repetitions=1, lapses=0, state="learning", grade=Grade.HARD, now=NOW)
    assert result.repetitions == 2
    assert result.state == "review"
    assert result.interval_days == max(1, round(1 * 1.2))


def test_hard_in_review_multiplies_interval_by_1_2():
    result = grade_card(ease=2.5, interval_days=10, repetitions=4, lapses=0, state="review", grade=Grade.HARD, now=NOW)
    assert result.interval_days == round(10 * 1.2)
    assert result.state == "review"
    assert result.ease == pytest.approx(2.35)


def test_good_on_new_card_gives_one_day_then_six_on_second_good():
    first = grade_card(ease=2.5, interval_days=0, repetitions=0, lapses=0, state="new", grade=Grade.GOOD, now=NOW)
    assert first.interval_days == 1 and first.state == "learning" and first.ease == pytest.approx(2.5)
    second = grade_card(ease=2.5, interval_days=1, repetitions=1, lapses=0, state="learning", grade=Grade.GOOD, now=NOW)
    assert second.interval_days == 6 and second.state == "review"


def test_good_in_review_multiplies_by_ease():
    result = grade_card(ease=2.3, interval_days=6, repetitions=2, lapses=0, state="review", grade=Grade.GOOD, now=NOW)
    assert result.interval_days == round(6 * 2.3)
    assert result.ease == pytest.approx(2.3)
    assert result.state == "review"


def test_easy_multiplies_good_interval_by_1_3_and_raises_ease():
    base = grade_card(ease=2.5, interval_days=6, repetitions=2, lapses=0, state="review", grade=Grade.GOOD, now=NOW)
    easy = grade_card(ease=2.5, interval_days=6, repetitions=2, lapses=0, state="review", grade=Grade.EASY, now=NOW)
    assert easy.interval_days == round(base.interval_days * 1.3)
    assert easy.ease == pytest.approx(2.65)
    assert easy.state == "review"


def test_easy_on_new_card_jumps_straight_to_review():
    result = grade_card(ease=2.5, interval_days=0, repetitions=0, lapses=0, state="new", grade=Grade.EASY, now=NOW)
    assert result.state == "review"
    assert result.repetitions == 1


def test_relearning_after_lapse_uses_tiered_interval_not_zero():
    """A card that just lapsed (state=lapsed, interval=0) relearns like a new card,
    not `round(0 * ease) == 0` — otherwise it would stay due immediately forever."""
    result = grade_card(ease=2.3, interval_days=0, repetitions=0, lapses=1, state="lapsed", grade=Grade.GOOD, now=NOW)
    assert result.interval_days == 1
    assert result.state == "learning"


def test_interval_is_capped_at_365_days():
    result = grade_card(ease=2.5, interval_days=400, repetitions=5, lapses=0, state="review", grade=Grade.GOOD, now=NOW)
    assert result.interval_days == MAX_INTERVAL_DAYS
    result_easy = grade_card(ease=2.5, interval_days=400, repetitions=5, lapses=0, state="review", grade=Grade.EASY, now=NOW)
    assert result_easy.interval_days == MAX_INTERVAL_DAYS


def test_due_at_matches_capped_interval_in_days():
    result = grade_card(ease=2.5, interval_days=10, repetitions=4, lapses=0, state="review", grade=Grade.GOOD, now=NOW)
    assert result.due_at == NOW + result.interval_days * DAY
