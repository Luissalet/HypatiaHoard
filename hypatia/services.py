"""Wiring of database, stores, scheduler, search and stats. Owns the clock."""

from __future__ import annotations

import logging
import secrets
import time
from typing import Callable

from . import __version__
from .config import Config
from .db import Database
from .scheduler import parse_grade
from .search import Search
from .stats import Stats
from .store import CardStore, DeckStore

log = logging.getLogger("hypatia")


def write_token(config: Config) -> str:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    config.token_path.write_text(token, encoding="utf-8")
    try:
        config.token_path.chmod(0o600)
    except OSError:
        pass
    return token


class Services:
    """Everything the API and the agent tools call through. `clock` is
    injectable (tests pass a fixed function) so nothing depends on wall time.
    """

    def __init__(self, config: Config, clock: Callable[[], float] | None = None):
        self.config = config
        self.clock = clock or time.time
        self.started_at = self.clock()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        self.token = write_token(config)
        self.db = Database(config.db_path)
        self.decks = DeckStore(self.db)
        self.cards = CardStore(self.db)
        self.search = Search(self.db)
        self.stats = Stats(self.db)
        self.default_deck = self.decks.ensure_default(self.clock())

    def now(self) -> float:
        return self.clock()

    def stop(self) -> None:
        self.db.close()

    # ---------- decks ----------
    def add_deck(self, name: str, description: str, new_per_day: int = 20):
        return self.decks.add(name, description, self.now(), new_per_day)

    def remove_deck(self, deck_id: int, with_cards: bool) -> bool:
        default = self.decks.by_name("General")
        default_id = default.id if default else deck_id
        if deck_id == default_id and not with_cards:
            raise ValueError("The default deck cannot be deleted; delete its cards first with ?with_cards=1.")
        return self.decks.remove(deck_id, with_cards, default_id)

    # ---------- review queue ----------
    def review_queue(self, deck_id: int | None, limit: int) -> list[dict]:
        now = self.now()
        deck_limits = {d.id: d.new_per_day for d in self.decks.list()}
        seen_today = self.stats.new_seen_today_by_deck(now)
        return self.cards.due_queue(deck_id, limit, now, deck_limits, seen_today)

    def review_card(self, card_id: int, grade_value, elapsed_ms: int | None) -> dict:
        grade = parse_grade(grade_value)
        card = self.cards.apply_review(card_id, grade, self.now(), elapsed_ms)
        deck_id = card["deck_id"]
        next_up = self.cards.due_queue(deck_id, 1, self.now(),
                                        {deck_id: self.decks.get(deck_id).new_per_day},
                                        self.stats.new_seen_today_by_deck(self.now()))
        return {"card": card, "next": next_up[0] if next_up else None}

    def status(self) -> dict:
        counts = self.decks.counts()
        totals = {"cards": 0, "new": 0, "learning": 0, "review": 0, "lapsed": 0, "suspended": 0, "due": 0}
        for c in counts.values():
            for key in totals:
                totals[key] += c.get(key) or 0
        return {"service": "hypatia-hoard", "version": __version__, "data_dir": str(self.config.data_dir),
                "decks": len(self.decks.list()), "totals": totals, "started_at": self.started_at}
