"""SQLite connection (WAL, FTS5, one shared connection behind an RLock) and the core schema."""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

MIN_SQLITE = (3, 35, 0)

SCHEMA = """
CREATE TABLE IF NOT EXISTS records(
  kind TEXT NOT NULL, id TEXT NOT NULL, subject_id TEXT, content_hash TEXT,
  updated_at TEXT, rev INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS records_subject ON records(kind, subject_id);
CREATE INDEX IF NOT EXISTS records_hash ON records(kind, content_hash);
CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
CREATE TABLE IF NOT EXISTS tombstones(kind TEXT, id TEXT, rev INTEGER, deleted_at TEXT, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS tombstones_rev ON tombstones(rev);
CREATE TABLE IF NOT EXISTS images(filename TEXT PRIMARY KEY, mime TEXT, data BLOB, rev INTEGER);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, question_id TEXT, grade TEXT, result TEXT, at TEXT, via TEXT);
CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  id UNINDEXED, subject_id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
"""


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

    Autocommit mode (isolation_level=None): single statements commit on their
    own; `tx()` groups several into one BEGIN IMMEDIATE ... COMMIT. `tx()` is
    re-entrant: a nested `tx()` joins the outer transaction.
    """

    def __init__(self, path: Path | str):
        check_sqlite()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.RLock()
        self._depth = 0
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        with self.lock:
            self.conn.executescript(SCHEMA)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.lock:
            if self._depth:
                self._depth += 1
                try:
                    yield self.conn
                finally:
                    self._depth -= 1
                return
            self.conn.execute("BEGIN IMMEDIATE")
            self._depth = 1
            try:
                yield self.conn
            except BaseException:
                self._depth = 0
                self.conn.execute("ROLLBACK")
                raise
            self._depth = 0
            self.conn.execute("COMMIT")

    def close(self) -> None:
        with self.lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()
