"""FTS5 search over cards: front, back, tags, source. Diacritics-insensitive,
prefix match on the last term (as the user types), filterable by deck/tag/state.
"""

from __future__ import annotations

import json
import re

from .db import Database

TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)


def _fts_query(q: str) -> str:
    """Turn free text into an FTS5 MATCH expression: every term is a prefix match, AND'ed."""
    terms = TOKEN_RE.findall(q)
    if not terms:
        return '""'
    return " AND ".join(f'{t}*' for t in terms)


class Search:
    def __init__(self, db: Database):
        self.db = db

    def search(self, q: str, deck_id: int | None = None, tag: str | None = None,
               state: str | None = None, limit: int = 20) -> list[dict]:
        q = (q or "").strip()
        if not q:
            return []
        sql = """
            SELECT c.*, snippet(cards_fts, 0, '<mark>', '</mark>', '…', 10) AS front_snippet,
                   snippet(cards_fts, 1, '<mark>', '</mark>', '…', 12) AS back_snippet,
                   bm25(cards_fts) AS rank
            FROM cards_fts JOIN cards c ON c.id = cards_fts.rowid
            WHERE cards_fts MATCH ?
        """
        params: list = [_fts_query(q)]
        if deck_id is not None:
            sql += " AND c.deck_id = ?"
            params.append(deck_id)
        if state is not None:
            sql += " AND c.state = ?"
            params.append(state)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit * 3 if tag else limit)  # over-fetch a bit when filtering by tag in Python
        with self.db.lock:
            try:
                rows = self.db.conn.execute(sql, params).fetchall()
            except Exception:
                return []
        out = []
        for row in rows:
            tags = json.loads(row["tags"] or "[]")
            if tag and tag.strip().lower() not in tags:
                continue
            out.append({
                "id": row["id"], "deck_id": row["deck_id"], "front": row["front"], "back": row["back"],
                "front_snippet": row["front_snippet"], "back_snippet": row["back_snippet"],
                "tags": tags, "source": row["source"], "state": row["state"], "suspended": bool(row["suspended"]),
            })
            if len(out) >= limit:
                break
        return out
