"""Stats: retention window, streak across local midnight, 7-day forecast."""

import datetime as dt

import pytest

from hypatia.scheduler import Grade


def ts(date: dt.date, hour: int = 12) -> float:
    return dt.datetime.combine(date, dt.time(hour)).timestamp()


def test_retention_is_none_without_non_new_reviews(services):
    deck, _ = services.decks.add("Vacio", "", services.now())
    stats = services.stats.deck_stats(deck.id, services.now())
    assert stats["retention_30d"] is None
    assert stats["streak_days"] == 0
    assert len(stats["forecast_7d"]) == 7


def test_retention_excludes_the_first_new_review_and_windows_to_30_days(services):
    deck, _ = services.decks.add("Retencion", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "Q", "A", [], "", "", services.now())
    services.cards.apply_review(card["id"], Grade.GOOD, services.now(), None)  # was_new: excluded
    services.cards.apply_review(card["id"], Grade.AGAIN, services.now(), None)  # counts, a failure, but will age out
    services.clock.advance(days=40)  # push the old failure outside the 30-day window
    services.cards.apply_review(card["id"], Grade.GOOD, services.now(), None)
    services.cards.apply_review(card["id"], Grade.EASY, services.now(), None)
    stats = services.stats.deck_stats(deck.id, services.now())
    assert stats["retention_30d"] == pytest.approx(1.0)  # only the two recent good/easy reviews count


def test_streak_crosses_midnight_and_resets_after_a_gap(services):
    deck, _ = services.decks.add("Racha", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "Q", "A", [], "", "", services.now())
    day1 = dt.date(2030, 3, 1)

    services.clock.value = ts(day1)
    services.cards.apply_review(card["id"], Grade.GOOD, services.now(), None)
    assert services.stats.deck_stats(deck.id, services.now())["streak_days"] == 1

    day2 = day1 + dt.timedelta(days=1)
    services.clock.value = ts(day2)
    services.cards.apply_review(card["id"], Grade.GOOD, services.now(), None)
    assert services.stats.deck_stats(deck.id, services.now())["streak_days"] == 2

    day3 = day2 + dt.timedelta(days=1)
    services.clock.value = ts(day3, hour=1)  # day3 just started, nothing reviewed yet today
    assert services.stats.deck_stats(deck.id, services.now())["streak_days"] == 2  # yesterday still counts

    day4 = day3 + dt.timedelta(days=1)  # day3 passed with no review: the streak breaks
    services.clock.value = ts(day4)
    services.cards.apply_review(card["id"], Grade.GOOD, services.now(), None)
    assert services.stats.deck_stats(deck.id, services.now())["streak_days"] == 1


def test_forecast_places_due_cards_on_the_right_day_and_folds_overdue_into_today(services):
    deck, _ = services.decks.add("Prevision", "", services.now())
    now = services.now()
    ids = {}
    for label, offset_days in (("hoy", 0), ("manana", 1), ("tres", 3), ("vencida", -2)):
        card, _ = services.cards.add_or_update(deck.id, label, "x", [], "", "", now)
        ids[label] = card["id"]
        with services.db.transaction() as conn:
            conn.execute("UPDATE cards SET due_at = ? WHERE id = ?", (now + offset_days * 86400, card["id"]))

    stats = services.stats.deck_stats(deck.id, now)
    forecast = {d["date"]: d["due"] for d in stats["forecast_7d"]}
    days = [d["date"] for d in stats["forecast_7d"]]
    assert len(days) == 7
    # day 0 folds in both "hoy" and the overdue card
    assert forecast[days[0]] == 2
    assert forecast[days[1]] == 1  # "manana"
    assert forecast[days[3]] == 1  # "tres"
    assert forecast[days[2]] == 0


def test_new_seen_today_by_deck_counts_only_first_reviews_of_new_cards(services):
    deck, _ = services.decks.add("Vistas", "", services.now())
    c1, _ = services.cards.add_or_update(deck.id, "Uno", "x", [], "", "", services.now())
    c2, _ = services.cards.add_or_update(deck.id, "Dos", "x", [], "", "", services.now())
    services.cards.apply_review(c1["id"], Grade.GOOD, services.now(), None)
    services.cards.apply_review(c1["id"], Grade.GOOD, services.now(), None)  # second review of c1: not new anymore
    services.cards.apply_review(c2["id"], Grade.AGAIN, services.now(), None)
    seen = services.stats.new_seen_today_by_deck(services.now())
    assert seen[deck.id] == 2  # c1's first review + c2's first review
