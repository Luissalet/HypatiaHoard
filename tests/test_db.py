"""The database is the family's shared SQLite wrapper with Hypatia's schema on top."""
import sqlite3
import threading

import pytest

from hypatia import db as hypatia_db
from hypatia.db import Database


def test_a_database_made_before_the_shared_wrapper_keeps_its_data(tmp_path):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(hypatia_db.SCHEMA)
    old.execute("INSERT INTO kv(key, value) VALUES('k', 'v')")
    old.commit()
    old.close()
    db = Database(path)
    try:
        assert db.conn.execute("SELECT value FROM kv WHERE key='k'").fetchone()["value"] == "v"
        assert db.schema_version == 1
    finally:
        db.close()
    reopened = Database(path)  # and opening it again changes nothing
    try:
        assert reopened.schema_version == 1
    finally:
        reopened.close()


def test_nested_transactions_roll_back_only_the_inner_part_that_failed(tmp_path):
    db = Database(tmp_path / "t.db")
    try:
        with db.tx() as conn:
            conn.execute("INSERT INTO kv(key, value) VALUES('outer', '1')")
            with pytest.raises(ValueError):
                with db.tx() as inner:
                    inner.execute("INSERT INTO kv(key, value) VALUES('inner', '1')")
                    raise ValueError("inner failed, caller carries on")
        keys = {r["key"] for r in db.conn.execute("SELECT key FROM kv")}
        assert keys == {"outer"}
    finally:
        db.close()


def test_a_busy_database_does_not_leave_the_lock_held(tmp_path):
    """A second process holding the write lock made `tx()` fail with 'database is locked' and keep the
    thread lock forever; now every other thread keeps working."""
    path = tmp_path / "b.db"
    db = Database(path)
    blocker = sqlite3.connect(path, isolation_level=None)
    blocker.execute("BEGIN IMMEDIATE")
    db.conn.execute("PRAGMA busy_timeout = 50")
    try:
        with pytest.raises(sqlite3.OperationalError):
            with db.tx():
                pass
        done = threading.Event()

        def other():
            with db.lock:
                done.set()

        t = threading.Thread(target=other)
        t.start()
        t.join(2)
        assert done.is_set()
    finally:
        blocker.execute("ROLLBACK")
        blocker.close()
        db.close()
