"""Wiring of database, stores, scheduler, search and stats. Owns the clock."""

from __future__ import annotations

import logging
import secrets
import time
from typing import Any, Callable

from . import __version__
from .backend import load_link_config
from .config import Config
from .db import Database
from .hoard_link import ChatResult, Link
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

    def __init__(self, config: Config, clock: Callable[[], float] | None = None,
                 link_chat: Callable[..., ChatResult] | None = None, scribe_client: Any = None):
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
        self._link: Link | None = None
        # Tests inject a fake `link_chat(messages, **kwargs) -> ChatResult`
        # (raising Unavailable/BackendError as needed) instead of a real
        # Hoard Link, so cards_suggest can be tested fully offline.
        self._link_chat_override = link_chat
        # Tests inject a fake ScribeClient (e.g. pointed at an ASGI transport)
        # instead of one that resolves Scribe's real sibling folder/port.
        self._scribe_client_override = scribe_client

    def now(self) -> float:
        return self.clock()

    def make_scribe_client(self):
        if self._scribe_client_override is not None:
            return self._scribe_client_override
        from .scribe_client import ScribeClient

        return ScribeClient()

    @property
    def link(self) -> Link:
        """Hoard Link, built lazily (only `cards_suggest` needs it): a Link
        the app never used never opens an event-loop thread or an HTTP
        client, which keeps every other test and request unaffected."""
        if self._link is None:
            self._link = Link(load_link_config(self.config.data_dir))
        return self._link

    def link_chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> ChatResult:
        if self._link_chat_override is not None:
            return self._link_chat_override(messages, **kwargs)
        return self.link.sync.chat(messages, **kwargs)

    def stop(self) -> None:
        if self._link is not None:
            self._link.sync.close()
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
