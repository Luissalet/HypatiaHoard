"""FTS5 search: diacritics-insensitive, prefix match, filters."""

from fixtures import SAMPLE_CARDS


def seed(services):
    deck, _ = services.decks.add("Valdeniebla", "", services.now())
    for row in SAMPLE_CARDS:
        services.cards.add_or_update(deck.id, row["front"], row["back"], row["tags"], row["source"], "", services.now())
    return deck


def test_search_matches_accent_insensitive_and_prefix(services):
    seed(services)
    hits = services.search.search("fundacion")  # no accent, whole word of an accented term
    assert any("fundación" in h["front"].lower() for h in hits)
    prefix_hits = services.search.search("fotosint")
    assert prefix_hits == []  # nothing about photosynthesis in the fixture
    telescope_hits = services.search.search("telesco")  # prefix of "telescopio"
    assert any("telescopio" in h["back"].lower() for h in telescope_hits)


def test_search_filters_by_deck_tag_and_state(services):
    deck = seed(services)
    other_deck, _ = services.decks.add("Otro mazo", "", services.now())
    services.cards.add_or_update(other_deck.id, "¿Capital de Valdeniebla en otro mazo?", "Otra respuesta", ["geografia"], "", "", services.now())

    only_this_deck = services.search.search("Valdeniebla", deck_id=deck.id)
    assert all(h["deck_id"] == deck.id for h in only_this_deck)

    by_tag = services.search.search("Valdeniebla", tag="literatura")
    assert len(by_tag) == 1 and "literatura" in by_tag[0]["tags"]

    by_state = services.search.search("Valdeniebla", state="new")
    assert all(h["state"] == "new" for h in by_state)


def test_search_snippet_has_mark_tags(services):
    seed(services)
    hits = services.search.search("telescopio")
    assert hits and "<mark>" in (hits[0]["back_snippet"] or hits[0]["front_snippet"])


def test_search_empty_query_returns_nothing(services):
    seed(services)
    assert services.search.search("   ") == []
