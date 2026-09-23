"""Deck/card store: dedupe, normalisation, due queue ordering, new-per-day limit."""

import pytest

from hypatia.scheduler import Grade
from hypatia.store import normalize_text


def test_normalize_text_strips_accents_case_and_whitespace():
    assert normalize_text("  ¿Qué   Año Es?  ") == "¿que ano es?"
    assert normalize_text("Río Ceniciento") == normalize_text("rio   ceniciento")


def test_default_deck_general_exists(services):
    assert services.default_deck.name == "General"
    again = services.decks.ensure_default(services.now())
    assert again.id == services.default_deck.id  # idempotent


def test_deck_add_is_idempotent_case_and_accent_insensitive(services):
    a, created_a = services.decks.add("Física", "", services.now())
    b, created_b = services.decks.add("  fisica  ", "otra descripcion", services.now())
    assert created_a is True and created_b is False
    assert a.id == b.id


def test_deck_rename_rejects_clash(services):
    deck1, _ = services.decks.add("Uno", "", services.now())
    deck2, _ = services.decks.add("Dos", "", services.now())
    with pytest.raises(ValueError):
        services.decks.update(deck2.id, {"name": "uno"})  # clashes (accent/case-insensitive)


def test_card_add_or_update_dedupes_on_deck_and_normalized_front(services):
    deck, _ = services.decks.add("Historia", "", services.now())
    now = services.now()
    card1, existing1 = services.cards.add_or_update(deck.id, "¿Cuándo fue la fundación?", "1888", ["historia"], "a.pdf", "", now)
    assert existing1 is False
    card2, existing2 = services.cards.add_or_update(deck.id, "  ¿cuando fue la FUNDACION?  ", "1889 (corregido)", ["historia", "fechas"], "b.pdf", "", now + 1)
    assert existing2 is True
    assert card2["id"] == card1["id"]
    assert card2["back"] == "1889 (corregido)"
    assert card2["source"] == "b.pdf"
    assert set(card2["tags"]) == {"historia", "fechas"}
    # a different deck is a different card even with the same front
    other_deck, _ = services.decks.add("Otro", "", now)
    card3, existing3 = services.cards.add_or_update(other_deck.id, "¿Cuándo fue la fundación?", "1888", [], "", "", now)
    assert existing3 is False and card3["id"] != card1["id"]


def test_card_new_starts_with_default_schedule(services):
    deck, _ = services.decks.add("Bio", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "¿Qué es la fotosíntesis?", "Un proceso.", [], "", "", services.now())
    assert card["ease"] == 2.5
    assert card["interval_days"] == 0
    assert card["state"] == "new"
    assert card["due_at"] <= services.now()  # immediately due


def test_due_queue_orders_lapsed_learning_before_review_before_new(services):
    deck, _ = services.decks.add("Orden", "", services.now())
    new_card, _ = services.cards.add_or_update(deck.id, "Nueva", "x", [], "", "", services.now())

    review_card, _ = services.cards.add_or_update(deck.id, "En repaso", "x", [], "", "", services.now())
    services.cards.apply_review(review_card["id"], Grade.GOOD, services.now(), None)  # new -> learning, due in 1 day

    lapsing_card, _ = services.cards.add_or_update(deck.id, "Se olvidara", "x", [], "", "", services.now())
    services.cards.apply_review(lapsing_card["id"], Grade.GOOD, services.now(), None)  # new -> learning, due in 1 day
    services.clock.advance(days=1)
    services.cards.apply_review(lapsing_card["id"], Grade.GOOD, services.now(), None)  # learning -> review, due in 6 days
    services.clock.advance(days=6)
    services.cards.apply_review(lapsing_card["id"], Grade.AGAIN, services.now(), None)  # review -> lapsed, due in 10 min

    services.clock.advance(seconds=700)  # everything now due
    queue = services.review_queue(deck.id, 10)
    ids = [c["id"] for c in queue]
    states = {c["id"]: c["state"] for c in queue}
    assert states[lapsing_card["id"]] == "lapsed"
    assert ids.index(lapsing_card["id"]) < ids.index(new_card["id"])
    assert ids.index(review_card["id"]) < ids.index(new_card["id"])
    assert ids[-1] == new_card["id"]  # new card comes last


def test_new_per_day_limits_new_cards_in_queue(services):
    base_deck, _ = services.decks.add("Limite", "", services.now())
    deck = services.decks.update(base_deck.id, {"new_per_day": 2})
    for i in range(5):
        services.cards.add_or_update(deck.id, f"Pregunta {i}", "x", [], "", "", services.now())
    queue = services.review_queue(deck.id, 20)
    assert len(queue) == 2
    # a review already counted today lowers the remaining budget
    services.cards.apply_review(queue[0]["id"], Grade.GOOD, services.now(), None)
    queue2 = services.review_queue(deck.id, 20)
    new_in_queue2 = [c for c in queue2 if c["state"] == "new"]
    assert len(new_in_queue2) == 1


def test_suspended_cards_are_never_due(services):
    deck, _ = services.decks.add("Susp", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "Suspendida", "x", [], "", "", services.now())
    services.cards.set_suspended(card["id"], True, services.now())
    queue = services.review_queue(deck.id, 20)
    assert queue == []


def test_apply_review_logs_and_updates_schedule(services):
    deck, _ = services.decks.add("Log", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "Pregunta", "Respuesta", [], "", "", services.now())
    updated = services.cards.apply_review(card["id"], Grade.GOOD, services.now(), 2500)
    assert updated["repetitions"] == 1
    assert updated["times_seen"] == 1
    assert updated["last_reviewed_at"] == services.now()
    with services.db.lock:
        row = services.db.conn.execute("SELECT * FROM reviews WHERE card_id = ?", (card["id"],)).fetchone()
    assert row["grade"] == int(Grade.GOOD)
    assert row["was_new"] == 1
    assert row["elapsed_ms"] == 2500


def test_deck_delete_moves_cards_to_general_by_default(services):
    deck, _ = services.decks.add("Temporal", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "X", "Y", [], "", "", services.now())
    services.remove_deck(deck.id, with_cards=False)
    moved = services.cards.get(card["id"])
    assert moved["deck_id"] == services.default_deck.id


def test_deck_delete_with_cards_removes_them(services):
    deck, _ = services.decks.add("Borrar", "", services.now())
    card, _ = services.cards.add_or_update(deck.id, "X", "Y", [], "", "", services.now())
    services.remove_deck(deck.id, with_cards=True)
    assert services.cards.get(card["id"]) is None
