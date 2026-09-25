"""`python -m hypatia migrate-hypatia <old hypatia-hoard.db>`: the old flashcard
app's decks and cards become subjects and DESARROLLO questions (topic "Tarjetas"),
keeping their spaced-repetition state. Idempotent by contentHash."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import bank
from .services import Services, js_iso

TOPIC_TITLE = "Tarjetas"


def _iso(epoch: float | None) -> str | None:
    return js_iso(datetime.fromtimestamp(epoch, tz=timezone.utc)) if epoch else None


def _date(epoch: float | None) -> str | None:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d") if epoch else None


def _stats(card: sqlite3.Row, reviews: list[sqlite3.Row]) -> dict[str, Any]:
    stats: dict[str, Any] = {"seen": len(reviews), "correct": sum(1 for r in reviews if r["grade"] >= 1),
                             "wrong": sum(1 for r in reviews if r["grade"] == 0)}
    if not reviews and not card["times_seen"]:
        return stats
    stats["seen"] = max(stats["seen"], card["times_seen"] or 0)
    last = reviews[-1] if reviews else None
    last_at = card["last_reviewed_at"] or (last["reviewed_at"] if last else None)
    if last_at:
        stats["lastSeenAt"] = _iso(last_at)
    if last is not None:
        stats["lastResult"] = "CORRECT" if last["grade"] >= 1 else "WRONG"
    stats.update({"easeFactor": card["ease"], "interval": card["interval_days"], "repetitions": card["repetitions"],
                  "nextReviewAt": _date(card["due_at"])})
    return stats


def migrate(services: Services, old_db: Path) -> dict[str, Any]:
    if not Path(old_db).is_file():
        raise FileNotFoundError(f"No such file: {old_db}")
    old = sqlite3.connect(f"file:{Path(old_db).as_posix()}?mode=ro", uri=True)
    old.row_factory = sqlite3.Row
    report: dict[str, Any] = {"subjects": [], "added": 0, "existing": 0}
    try:
        reviews_by_card: dict[int, list[sqlite3.Row]] = {}
        for r in old.execute("SELECT * FROM reviews ORDER BY reviewed_at, id"):
            reviews_by_card.setdefault(r["card_id"], []).append(r)
        for deck in old.execute("SELECT * FROM decks ORDER BY id").fetchall():
            cards = old.execute("SELECT * FROM cards WHERE deck_id=? ORDER BY id", (deck["id"],)).fetchall()
            if not cards:
                continue
            subject, created = bank.ensure_subject(services, deck["name"])
            topic = bank.ensure_topic(services, subject["id"], TOPIC_TITLE)
            added = existing = 0
            for card in cards:
                tags = json.loads(card["tags"] or "[]")
                data: dict[str, Any] = {"type": "DESARROLLO", "prompt": card["front"], "modelAnswer": card["back"],
                                        "origin": "alumno"}
                if tags:
                    data["tags"] = tags
                if (card["source"] or "").strip():
                    data["explanation"] = f"Fuente: {card['source'].strip()}"
                question, was_there = bank.add_question(services, subject, topic, data)
                if was_there:
                    existing += 1
                    continue
                question = {**question, "stats": _stats(card, reviews_by_card.get(card["id"], [])),
                            "createdAt": _iso(card["created_at"]) or question["createdAt"]}
                services.store.put("question", question)
                added += 1
            report["subjects"].append({"deck": deck["name"], "subject": subject["name"], "created": created,
                                       "added": added, "existing": existing})
            report["added"] += added
            report["existing"] += existing
    finally:
        old.close()
    return report
