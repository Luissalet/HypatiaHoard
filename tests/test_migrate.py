"""migrate-hypatia: an old Hypatia's Hoard database becomes subjects/DESARROLLO questions."""

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from hypatia.__main__ import main
from hypatia.migrate_hypatia import migrate

OLD_DB_PY = Path("/home/claude/w/hy/hypatia/db.py")
DAY = 86400
T = 1_790_000_000.0  # 2026-09-21


def _old_schema() -> str:
    if OLD_DB_PY.is_file():
        spec = importlib.util.spec_from_file_location("old_hypatia_db", OLD_DB_PY)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.MIGRATIONS[0]
    pytest.skip("the old Hypatia repo is not available")


@pytest.fixture
def old_db(tmp_path):
    path = tmp_path / "old" / "hypatia-hoard.db"
    path.parent.mkdir()
    conn = sqlite3.connect(path)
    conn.executescript(_old_schema())
    conn.execute("INSERT INTO decks(id, name, normalized_name, created_at) VALUES (1, 'Biología', 'biologia', ?)", (T,))
    conn.execute("INSERT INTO decks(id, name, normalized_name, created_at) VALUES (2, 'Vacío', 'vacio', ?)", (T,))
    cards = [
        (1, "¿Qué es la mitosis?", "División celular.", '["celula"]', "libro p. 4", 2.36, 6, 2, T + 6 * DAY, 2, T),
        (2, "¿Qué es el ADN?", "Ácido desoxirribonucleico.", "[]", "", 2.5, 0, 0, T, 0, None),
    ]
    for cid, front, back, tags, source, ease, interval, reps, due, seen, last in cards:
        conn.execute("INSERT INTO cards(id, deck_id, front, back, normalized_front, tags, source, ease, interval_days, repetitions,"
                     " due_at, times_seen, last_reviewed_at, created_at, updated_at) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (cid, front, back, front.lower(), tags, source, ease, interval, reps, due, seen, last, T - DAY, T))
    for at, grade in ((T - DAY, 0), (T, 2)):
        conn.execute("INSERT INTO reviews(card_id, deck_id, reviewed_at, grade, interval_before, interval_after, ease_after)"
                     " VALUES (1, 1, ?, ?, 0, 1, 2.5)", (at, grade))
    conn.commit()
    conn.close()
    return path


def test_migrate_decks_cards_and_sm2_state(services, old_db):
    now = services.now_iso()
    services.store.put("subject", {"id": "bio", "name": "BIOLOGÍA", "createdAt": now, "updatedAt": now})
    report = migrate(services, old_db)
    assert report["added"] == 2 and report["subjects"][0]["subject"] == "BIOLOGÍA"  # reused by slug
    assert len(report["subjects"]) == 1  # empty deck skipped
    topics = services.store.list("topic", "bio")
    assert [t["title"] for t in topics] == ["Tarjetas"]
    qs = {q["prompt"]: q for q in services.store.list("question", "bio")}
    mitosis = qs["¿Qué es la mitosis?"]
    assert mitosis["type"] == "DESARROLLO" and mitosis["modelAnswer"] == "División celular." and mitosis["origin"] == "alumno"
    assert mitosis["tags"] == ["celula"] and mitosis["explanation"] == "Fuente: libro p. 4"
    assert mitosis["stats"] == {"seen": 2, "correct": 1, "wrong": 1, "lastSeenAt": "2026-09-21T14:13:20.000Z",
                                "lastResult": "CORRECT", "easeFactor": 2.36, "interval": 6, "repetitions": 2,
                                "nextReviewAt": "2026-09-27"}
    assert qs["¿Qué es el ADN?"]["stats"] == {"seen": 0, "correct": 0, "wrong": 0}
    again = migrate(services, old_db)
    assert again["added"] == 0 and again["existing"] == 2


def test_cli_migrate(tmp_path, old_db, monkeypatch, capsys):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "cli-data"))
    assert main(["migrate-hypatia", str(old_db)]) == 0
    out = capsys.readouterr().out
    assert json.loads(out[: out.rindex("}") + 1])["added"] == 2
    assert main(["migrate-hypatia"]) == 2
