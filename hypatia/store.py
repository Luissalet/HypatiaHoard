"""Persistence for decks, cards and the review log."""

from __future__ import annotations

import json
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

from .db import Database
from .scheduler import Grade, grade_card

DEFAULT_DECK_NAME = "General"


def normalize_text(value: str) -> str:
    """Lower-case, strip accents, collapse whitespace — used for dedupe keys."""
    folded = unicodedata.normalize("NFD", value or "")
    folded = "".join(ch for ch in folded if unicodedata.category(ch) != "Mn")
    folded = folded.lower().strip()
    return re.sub(r"\s+", " ", folded)


def clean_tags(tags: list[str] | None) -> list[str]:
    if not tags:
        return []
    seen: list[str] = []
    for tag in tags:
        t = str(tag).strip().lower()
        if t and t not in seen:
            seen.append(t)
    return seen


@dataclass
class Deck:
    id: int
    name: str
    description: str
    new_per_day: int
    created_at: float

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description,
                "new_per_day": self.new_per_day, "created_at": self.created_at}


def _deck(row) -> Deck:
    return Deck(row["id"], row["name"], row["description"], row["new_per_day"], row["created_at"])


CARD_COLUMNS = (
    "id", "deck_id", "front", "back", "tags", "source", "source_url", "suspended", "ease",
    "interval_days", "repetitions", "due_at", "state", "lapses", "last_reviewed_at", "times_seen",
    "created_at", "updated_at",
)


def card_to_dict(row) -> dict:
    return {
        "id": row["id"], "deck_id": row["deck_id"], "front": row["front"], "back": row["back"],
        "tags": json.loads(row["tags"] or "[]"), "source": row["source"], "source_url": row["source_url"],
        "suspended": bool(row["suspended"]), "ease": row["ease"], "interval_days": row["interval_days"],
        "repetitions": row["repetitions"], "due_at": row["due_at"], "state": row["state"],
        "lapses": row["lapses"], "last_reviewed_at": row["last_reviewed_at"], "times_seen": row["times_seen"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


class DeckStore:
    def __init__(self, db: Database):
        self.db = db

    def ensure_default(self, now: float) -> Deck:
        existing = self.by_name(DEFAULT_DECK_NAME)
        if existing:
            return existing
        return self.add(DEFAULT_DECK_NAME, "Mazo por defecto.", now)[0]

    def list(self) -> list[Deck]:
        with self.db.lock:
            return [_deck(r) for r in self.db.conn.execute("SELECT * FROM decks ORDER BY name COLLATE NOCASE")]

    def get(self, deck_id: int) -> Deck | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT * FROM decks WHERE id = ?", (deck_id,)).fetchone()
        return _deck(row) if row else None

    def by_name(self, name: str) -> Deck | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT * FROM decks WHERE normalized_name = ?", (normalize_text(name),)).fetchone()
        return _deck(row) if row else None

    def resolve(self, deck_ref: str | int, now: float) -> tuple[Deck, bool]:
        """Deck by id or by name; a name that doesn't exist yet is created. Returns (deck, created)."""
        if isinstance(deck_ref, int) or (isinstance(deck_ref, str) and deck_ref.strip().isdigit()):
            deck = self.get(int(deck_ref))
            if deck is None:
                raise LookupError(f"Deck {deck_ref} does not exist.")
            return deck, False
        name = str(deck_ref).strip()
        if not name:
            raise ValueError("The deck name cannot be empty.")
        existing = self.by_name(name)
        if existing:
            return existing, False
        return self.add(name, "", now)[0], True

    def add(self, name: str, description: str, now: float, new_per_day: int = 20) -> tuple[Deck, bool]:
        name = name.strip()
        if not name:
            raise ValueError("The deck name cannot be empty.")
        existing = self.by_name(name)
        if existing:
            return existing, False
        with self.db.transaction() as conn:
            cursor = conn.execute(
                "INSERT INTO decks(name, normalized_name, description, new_per_day, created_at) VALUES (?,?,?,?,?)",
                (name, normalize_text(name), description.strip(), new_per_day, now),
            )
            new_id = cursor.lastrowid
        return self.get(new_id), True

    def update(self, deck_id: int, patch: dict) -> Deck | None:
        allowed = {"name", "description", "new_per_day"}
        fields = {k: v for k, v in patch.items() if k in allowed and v is not None}
        if "name" in fields:
            new_name = str(fields["name"]).strip()
            if not new_name:
                raise ValueError("The deck name cannot be empty.")
            clash = self.by_name(new_name)
            if clash and clash.id != deck_id:
                raise ValueError(f"A deck named '{new_name}' already exists.")
            fields["name"] = new_name
        if not fields:
            return self.get(deck_id)
        sets, values = [], []
        for key, value in fields.items():
            sets.append(f"{key} = ?")
            values.append(value)
            if key == "name":
                sets.append("normalized_name = ?")
                values.append(normalize_text(value))
        values.append(deck_id)
        with self.db.transaction() as conn:
            conn.execute(f"UPDATE decks SET {', '.join(sets)} WHERE id = ?", values)
        return self.get(deck_id)

    def remove(self, deck_id: int, with_cards: bool, default_deck_id: int) -> bool:
        with self.db.transaction() as conn:
            if not with_cards and deck_id != default_deck_id:
                conn.execute("UPDATE cards SET deck_id = ? WHERE deck_id = ?", (default_deck_id, deck_id))
            return conn.execute("DELETE FROM decks WHERE id = ?", (deck_id,)).rowcount > 0

    def counts(self) -> dict[int, dict]:
        now = time.time()
        with self.db.lock:
            rows = self.db.conn.execute(
                """SELECT deck_id, COUNT(*) AS cards,
                          SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS new,
                          SUM(CASE WHEN state = 'learning' THEN 1 ELSE 0 END) AS learning,
                          SUM(CASE WHEN state = 'review' THEN 1 ELSE 0 END) AS review,
                          SUM(CASE WHEN state = 'lapsed' THEN 1 ELSE 0 END) AS lapsed,
                          SUM(suspended) AS suspended,
                          SUM(CASE WHEN suspended = 0 AND due_at <= ? THEN 1 ELSE 0 END) AS due
                   FROM cards GROUP BY deck_id""",
                (now,),
            ).fetchall()
        return {r["deck_id"]: dict(r) for r in rows}


class CardStore:
    def __init__(self, db: Database):
        self.db = db

    # ---------- reads ----------
    def get(self, card_id: int) -> dict | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        return card_to_dict(row) if row else None

    def list(self, deck_id: int | None = None, tag: str | None = None, state: str | None = None,
              q: str | None = None, due_before: float | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
        sql = "SELECT * FROM cards WHERE 1=1"
        params: list[Any] = []
        if deck_id is not None:
            sql += " AND deck_id = ?"
            params.append(deck_id)
        if state is not None:
            sql += " AND state = ?"
            params.append(state)
        if due_before is not None:
            sql += " AND suspended = 0 AND due_at <= ?"
            params.append(due_before)
        if q:
            sql += " AND (front LIKE ? OR back LIKE ?)"
            params.extend([f"%{q}%", f"%{q}%"])
        sql += " ORDER BY due_at ASC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with self.db.lock:
            rows = self.db.conn.execute(sql, params).fetchall()
        cards = [card_to_dict(r) for r in rows]
        if tag:
            tag = tag.strip().lower()
            cards = [c for c in cards if tag in c["tags"]]
        return cards

    def count(self, deck_id: int | None = None) -> int:
        sql = "SELECT COUNT(*) FROM cards"
        params: list[Any] = []
        if deck_id is not None:
            sql += " WHERE deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            return self.db.conn.execute(sql, params).fetchone()[0]

    def due_queue(self, deck_id: int | None, limit: int, now: float, new_per_day_by_deck: dict[int, int],
                  new_seen_today_by_deck: dict[int, int]) -> list[dict]:
        """lapsed/learning first (by due_at), then review (by due_at), then new (by created_at),
        capped so at most `new_per_day - already seen today` new cards of each deck appear."""
        sql = "SELECT * FROM cards WHERE suspended = 0 AND due_at <= ?"
        params: list[Any] = [now]
        if deck_id is not None:
            sql += " AND deck_id = ?"
            params.append(deck_id)
        with self.db.lock:
            rows = [card_to_dict(r) for r in self.db.conn.execute(sql, params).fetchall()]
        priority = {"lapsed": 0, "learning": 0, "review": 1, "new": 2}
        rows.sort(key=lambda c: (priority.get(c["state"], 3), c["due_at"] if c["state"] != "new" else c["created_at"]))
        remaining_new = {
            d: max(0, new_per_day_by_deck.get(d, 20) - new_seen_today_by_deck.get(d, 0))
            for d in {c["deck_id"] for c in rows}
        }
        out: list[dict] = []
        for card in rows:
            if len(out) >= limit:
                break
            if card["state"] == "new":
                if remaining_new.get(card["deck_id"], 0) <= 0:
                    continue
                remaining_new[card["deck_id"]] -= 1
            out.append(card)
        return out

    # ---------- writes ----------
    def add_or_update(self, deck_id: int, front: str, back: str, tags: list[str] | None, source: str,
                       source_url: str, now: float) -> tuple[dict, bool]:
        """Idempotent on (deck, normalized front): an existing front updates back/tags/source."""
        norm = normalize_text(front)
        with self.db.transaction() as conn:
            row = conn.execute("SELECT id FROM cards WHERE deck_id = ? AND normalized_front = ?", (deck_id, norm)).fetchone()
            if row:
                conn.execute(
                    "UPDATE cards SET back = ?, tags = ?, source = ?, source_url = ?, updated_at = ? WHERE id = ?",
                    (back, json.dumps(clean_tags(tags)), source, source_url, now, row["id"]),
                )
                return self.get(row["id"]), True
            cursor = conn.execute(
                """INSERT INTO cards(deck_id, front, back, normalized_front, tags, source, source_url, ease,
                   interval_days, repetitions, due_at, state, lapses, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,2.5,0,0,?,'new',0,?,?)""",
                (deck_id, front.strip(), back.strip(), norm, json.dumps(clean_tags(tags)), source.strip(),
                 source_url.strip(), now, now, now),
            )
            new_id = cursor.lastrowid
        return self.get(new_id), False

    def update(self, card_id: int, patch: dict, now: float) -> dict | None:
        allowed = {"front", "back", "tags", "source", "source_url", "deck_id", "suspended"}
        fields = {k: v for k, v in patch.items() if k in allowed and v is not None}
        if "tags" in fields:
            fields["tags"] = json.dumps(clean_tags(fields["tags"]))
        if "suspended" in fields:
            fields["suspended"] = int(bool(fields["suspended"]))
        if not fields:
            return self.get(card_id)
        sets, values = [], []
        for key, value in fields.items():
            sets.append(f"{key} = ?")
            values.append(value)
            if key == "front":
                sets.append("normalized_front = ?")
                values.append(normalize_text(value))
        sets.append("updated_at = ?")
        values.append(now)
        values.append(card_id)
        with self.db.transaction() as conn:
            conn.execute(f"UPDATE cards SET {', '.join(sets)} WHERE id = ?", values)
        return self.get(card_id)

    def set_suspended(self, card_id: int, suspended: bool, now: float) -> dict | None:
        return self.update(card_id, {"suspended": suspended}, now)

    def remove(self, card_id: int) -> bool:
        with self.db.transaction() as conn:
            return conn.execute("DELETE FROM cards WHERE id = ?", (card_id,)).rowcount > 0

    def apply_review(self, card_id: int, grade: Grade, now: float, elapsed_ms: int | None) -> dict:
        with self.db.transaction() as conn:
            row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
            if row is None:
                raise LookupError(f"Card {card_id} does not exist.")
            was_new = row["state"] == "new"
            interval_before = row["interval_days"]
            new_schedule = grade_card(
                ease=row["ease"], interval_days=row["interval_days"], repetitions=row["repetitions"],
                lapses=row["lapses"], state=row["state"], grade=grade, now=now,
            )
            conn.execute(
                """UPDATE cards SET ease = ?, interval_days = ?, repetitions = ?, lapses = ?, state = ?,
                   due_at = ?, last_reviewed_at = ?, times_seen = times_seen + 1, updated_at = ? WHERE id = ?""",
                (new_schedule.ease, new_schedule.interval_days, new_schedule.repetitions, new_schedule.lapses,
                 new_schedule.state, new_schedule.due_at, now, now, card_id),
            )
            conn.execute(
                """INSERT INTO reviews(card_id, deck_id, reviewed_at, grade, interval_before, interval_after,
                   ease_after, elapsed_ms, was_new) VALUES (?,?,?,?,?,?,?,?,?)""",
                (card_id, row["deck_id"], now, int(grade), interval_before, new_schedule.interval_days,
                 new_schedule.ease, elapsed_ms, int(was_new)),
            )
        return self.get(card_id)
