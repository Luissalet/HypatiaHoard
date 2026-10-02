"""SQLite connection (WAL, FTS5, one shared connection behind an RLock) and the core schema."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .hoard_link import sqlkit

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
        has_fts5 = sqlkit.check_fts5(probe)
    finally:
        probe.close()
    if not has_fts5:  # pragma: no cover - depends on the build
        raise RuntimeError("This Python's SQLite has no FTS5 support; Hypatia needs it.")


class Database(sqlkit.Database):
    """The family's shared SQLite wrapper (one connection, one re-entrant lock, WAL, re-entrant `tx()`) with
    Hypatia's core schema as its first migration (every statement is IF NOT EXISTS, so databases that
    pre-date the version table simply adopt it)."""

    def __init__(self, path: Path | str):
        check_sqlite()
        super().__init__(path, migrations=[SCHEMA])
