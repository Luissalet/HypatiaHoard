"""SQLite connection (WAL, FTS5) and ordered schema migrations."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

MIN_SQLITE = (3, 35, 0)

MIGRATIONS: list[str] = [
    # 1: decks, cards, reviews log, FTS over cards
    """
    CREATE TABLE decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      new_per_day INTEGER NOT NULL DEFAULT 20,
      created_at REAL NOT NULL
    );
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      normalized_front TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      suspended INTEGER NOT NULL DEFAULT 0,
      ease REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      due_at REAL NOT NULL,
      state TEXT NOT NULL DEFAULT 'new',
      lapses INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at REAL,
      times_seen INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      UNIQUE(deck_id, normalized_front)
    );
    CREATE INDEX cards_deck ON cards(deck_id);
    CREATE INDEX cards_due ON cards(due_at);
    CREATE INDEX cards_state ON cards(state);
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      deck_id INTEGER NOT NULL,
      reviewed_at REAL NOT NULL,
      grade INTEGER NOT NULL,
      interval_before INTEGER NOT NULL,
      interval_after INTEGER NOT NULL,
      ease_after REAL NOT NULL,
      elapsed_ms INTEGER,
      was_new INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX reviews_card ON reviews(card_id);
    CREATE INDEX reviews_deck_time ON reviews(deck_id, reviewed_at);
    CREATE VIRTUAL TABLE cards_fts USING fts5(
      front, back, tags, source,
      content='cards', content_rowid='id',
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER cards_ai AFTER INSERT ON cards BEGIN
      INSERT INTO cards_fts(rowid, front, back, tags, source) VALUES (new.id, new.front, new.back, new.tags, new.source);
    END;
    CREATE TRIGGER cards_ad AFTER DELETE ON cards BEGIN
      INSERT INTO cards_fts(cards_fts, rowid, front, back, tags, source) VALUES ('delete', old.id, old.front, old.back, old.tags, old.source);
    END;
    CREATE TRIGGER cards_au AFTER UPDATE ON cards BEGIN
      INSERT INTO cards_fts(cards_fts, rowid, front, back, tags, source) VALUES ('delete', old.id, old.front, old.back, old.tags, old.source);
      INSERT INTO cards_fts(rowid, front, back, tags, source) VALUES (new.id, new.front, new.back, new.tags, new.source);
    END;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """,
]


def check_sqlite() -> None:
    version = tuple(int(p) for p in sqlite3.sqlite_version.split("."))
    if version < MIN_SQLITE:
        raise RuntimeError(f"SQLite {sqlite3.sqlite_version} is too old; need {'.'.join(map(str, MIN_SQLITE))}+.")
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
    except sqlite3.OperationalError as error:  # pragma: no cover - depends on the build
        raise RuntimeError("This Python's SQLite has no FTS5 support; Hypatia needs it.") from error
    finally:
        probe.close()


class Database:
    """One connection shared by every thread, guarded by a re-entrant lock.

    The app is the only writer; the MCP bridge never opens this file.
    """

    def __init__(self, path: Path):
        check_sqlite()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.migrate()

    def migrate(self) -> None:
        with self.lock:
            self.conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            row = self.conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
            current = row["v"] or 0
            for index, sql in enumerate(MIGRATIONS, start=1):
                if index <= current:
                    continue
                script = f"BEGIN;\n{sql}\nINSERT INTO schema_version(version) VALUES ({index});\nCOMMIT;"
                try:
                    self.conn.executescript(script)
                except Exception:
                    if self.conn.in_transaction:
                        self.conn.execute("ROLLBACK")
                    raise

    def transaction(self):
        """`with db.transaction():` — BEGIN IMMEDIATE / COMMIT (ROLLBACK on error) under the lock."""
        return _Transaction(self)

    def close(self) -> None:
        with self.lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()


class _Transaction:
    def __init__(self, db: Database):
        self.db = db

    def __enter__(self):
        self.db.lock.acquire()
        self.db.conn.execute("BEGIN IMMEDIATE")
        return self.db.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.db.conn.execute("COMMIT")
            else:
                self.db.conn.execute("ROLLBACK")
        finally:
            self.db.lock.release()
        return False
