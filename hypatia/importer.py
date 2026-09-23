"""Import cards from a JSON list or CSV text; export a deck to JSON."""

from __future__ import annotations

import csv
import io
import json

from .store import CardStore

MAX_IMPORT_ROWS = 5000


def parse_rows(body: str) -> list[dict]:
    """Accept `[{front, back, tags?, source?}]` JSON or CSV text with a
    `front,back,tags,source` header (tags is a comma/semicolon separated cell)."""
    text = body.strip()
    if not text:
        return []
    if text[0] in "[{":
        data = json.loads(text)
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            raise ValueError("Expected a JSON list of cards.")
        rows = []
        for item in data:
            if not isinstance(item, dict) or "front" not in item or "back" not in item:
                raise ValueError("Each card needs at least front and back.")
            tags = item.get("tags") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.replace(";", ",").split(",") if t.strip()]
            rows.append({"front": str(item["front"]), "back": str(item["back"]), "tags": tags,
                         "source": str(item.get("source") or ""), "source_url": str(item.get("source_url") or "")})
        return rows
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "front" not in reader.fieldnames or "back" not in reader.fieldnames:
        raise ValueError("CSV needs a header with at least front,back columns.")
    rows = []
    for row in reader:
        front, back = (row.get("front") or "").strip(), (row.get("back") or "").strip()
        if not front or not back:
            continue
        tags_cell = (row.get("tags") or "").strip()
        tags = [t.strip() for t in tags_cell.replace(";", ",").split(",") if t.strip()]
        rows.append({"front": front, "back": back, "tags": tags, "source": (row.get("source") or "").strip(),
                     "source_url": (row.get("source_url") or "").strip()})
    return rows


def import_cards(cards: CardStore, deck_id: int, rows: list[dict], now: float) -> dict:
    if len(rows) > MAX_IMPORT_ROWS:
        raise ValueError(f"Too many rows: {len(rows)} (max {MAX_IMPORT_ROWS}).")
    created, updated = 0, 0
    results = []
    for row in rows:
        front = (row.get("front") or "").strip()
        back = (row.get("back") or "").strip()
        if not front or not back:
            continue
        card, existing = cards.add_or_update(deck_id, front, back, row.get("tags"), row.get("source") or "",
                                              row.get("source_url") or "", now)
        results.append({"id": card["id"], "existing": existing})
        updated += int(existing)
        created += int(not existing)
    return {"created": created, "updated": updated, "cards": results}


def export_deck(cards: CardStore, deck_id: int) -> list[dict]:
    """Every card of a deck with its scheduling fields, so it can be moved between machines."""
    return cards.list(deck_id=deck_id, limit=1_000_000)
