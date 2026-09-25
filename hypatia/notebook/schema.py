"""Notebook tables (sources, chunks, vectors, studio items, chats) and small DB helpers."""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, origin TEXT NOT NULL, path TEXT NOT NULL,
  filename TEXT NOT NULL, title TEXT, kind TEXT, pages INTEGER, bytes INTEGER, sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT, added_at TEXT, indexed_at TEXT);
CREATE INDEX IF NOT EXISTS sources_subject ON sources(subject_id);
CREATE INDEX IF NOT EXISTS sources_sha ON sources(subject_id, sha256);
CREATE TABLE IF NOT EXISTS source_exclusions(
  subject_id TEXT NOT NULL, path TEXT NOT NULL, excluded_at TEXT, PRIMARY KEY(subject_id, path));
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, ord INTEGER NOT NULL, page INTEGER,
  heading TEXT, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, heading, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS chunk_vecs(
  chunk_id INTEGER PRIMARY KEY, model TEXT, dim INTEGER, vec BLOB);
CREATE TABLE IF NOT EXISTS studio_items(
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, scope TEXT,
  status TEXT NOT NULL, content TEXT, data TEXT, audio_path TEXT, citations TEXT, model TEXT,
  error TEXT, note TEXT, created_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS studio_subject ON studio_items(subject_id, created_at);
CREATE TABLE IF NOT EXISTS chats(
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, mode TEXT NOT NULL, title TEXT, topic_id TEXT,
  state TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS chats_subject ON chats(subject_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
  citations TEXT, meta TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, id);
"""


def init_schema(conn: sqlite3.Connection) -> None:
    """Create the notebook tables (idempotent)."""
    conn.executescript(SCHEMA)
    # Columns added after the first release go here as guarded ALTERs.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(studio_items)").fetchall()}
    if "note" not in cols:  # pragma: no cover - only for pre-release DBs
        conn.execute("ALTER TABLE studio_items ADD COLUMN note TEXT")


def _as_dict(cur: sqlite3.Cursor, row: Any) -> dict[str, Any]:
    names = [d[0] for d in cur.description]
    return dict(zip(names, tuple(row)))


def rows(services: Any, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    with services.db.lock:
        cur = services.db.conn.execute(sql, tuple(params))
        return [_as_dict(cur, r) for r in cur.fetchall()]


def row(services: Any, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    found = rows(services, sql, params)
    return found[0] if found else None
