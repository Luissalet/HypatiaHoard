"""hypatia/fsrs.py (FSRS-5) and its twin src/domain/fsrs.ts; card_review with the
scheduler chosen in the synced settings."""

import json
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from hypatia import fsrs
from hypatia.agent_tools import call_tool
from hypatia.sm2 import updated_stats

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 2, 10, 0, tzinfo=timezone.utc)


def test_first_review_uses_the_initial_stability_of_each_grade():
    out = {g: fsrs.step({}, g, NOW) for g in fsrs.RATING}
    assert [out[g]["interval"] for g in ("again", "hard", "good", "easy")] == [1, 1, 3, 16]
    assert out["good"]["fsrsStability"] == pytest.approx(3.173)
    assert out["good"]["fsrsDifficulty"] == pytest.approx(5.2824, abs=1e-4)
    assert out["again"]["repetitions"] == 0 and out["easy"]["repetitions"] == 1
    assert out["good"]["nextReviewAt"] == "2026-10-05"


def test_recall_grows_stability_and_a_lapse_shrinks_it():
    first = {**fsrs.step({}, "good", NOW), "seen": 1, "lastSeenAt": "2026-10-02T10:00:00Z"}
    later = datetime(2026, 10, 5, 10, tzinfo=timezone.utc)
    good, again = fsrs.step(first, "good", later), fsrs.step(first, "again", later)
    assert good["fsrsStability"] > first["fsrsStability"] > again["fsrsStability"]
    assert good["interval"] > 3 and again["interval"] == 1
    assert again["fsrsDifficulty"] > first["fsrsDifficulty"] > good["fsrsDifficulty"] - 0.01


def test_lower_retention_means_longer_intervals():
    assert fsrs.preview({}, NOW, 0.8)["good"] > fsrs.preview({}, NOW, 0.9)["good"] > fsrs.preview({}, NOW, 0.95)["good"]
    assert fsrs.clamp_retention(0.5) == 0.7 and fsrs.clamp_retention("x") == 0.9 and fsrs.clamp_retention(1) == 0.97


def test_cards_with_sm2_history_start_from_it():
    old = {"seen": 3, "interval": 15, "easeFactor": 2.6, "repetitions": 3, "lastSeenAt": "2026-09-17T08:00:00Z"}
    out = fsrs.step(old, "good", NOW)
    assert out["interval"] > 15 and out["repetitions"] == 4 and out["easeFactor"] == 2.6
    assert fsrs.difficulty_from_ease(2.5) == pytest.approx(6.2) and fsrs.difficulty_from_ease(1.0) == 10


def test_same_day_review_does_not_jump():
    first = {**fsrs.step({}, "good", NOW), "seen": 1, "lastSeenAt": NOW.isoformat()}
    again_today = fsrs.step(first, "good", NOW)
    assert again_today["interval"] <= 5


def test_updated_stats_keeps_sm2_by_default_and_switches_on_request():
    sm2 = updated_stats({}, "good", NOW, "2026-10-02T10:00:00Z")
    assert "fsrsStability" not in sm2 and sm2["interval"] == 1
    out = updated_stats({}, "good", NOW, "2026-10-02T10:00:00Z", "fsrs", 0.9)
    assert out["fsrsStability"] == pytest.approx(3.173) and out["interval"] == 3 and out["seen"] == 1


def test_settings_of():
    assert fsrs.settings_of(None) == ("sm2", 0.9)
    assert fsrs.settings_of({"scheduler": "fsrs", "desiredRetention": 0.85}) == ("fsrs", 0.85)
    assert fsrs.settings_of({"scheduler": "anki"}) == ("sm2", 0.9)


def test_card_review_follows_the_synced_scheduler(services):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Redes", "createdAt": now, "updatedAt": now})
    added = call_tool(services, "questions_add", {"subject": "redes", "questions": [
        {"type": "DESARROLLO", "prompt": "¿Qué es TCP?", "modelAnswer": "Un protocolo de transporte."},
        {"type": "DESARROLLO", "prompt": "¿Qué es UDP?", "modelAnswer": "Otro protocolo de transporte."}]})
    q1, q2 = (q["id"] for q in added["questions"])
    out = call_tool(services, "card_review", {"id": q1, "prompt": "¿Qué es TCP?", "grade": "easy"})
    assert out["scheduler"] == "sm2" and "fsrs" not in out
    services.store.kv_set("syncedSettings", {"alias": "", "importedPackIds": [], "scheduler": "fsrs",
                                             "desiredRetention": 0.9})
    out = call_tool(services, "card_review", {"id": q2, "prompt": "¿Qué es UDP?", "grade": "easy"})
    assert out["scheduler"] == "fsrs" and out["intervalDays"] == 16
    assert out["fsrs"]["stability"] == pytest.approx(15.6911)
    stored = services.store.get("question", q2)["stats"]
    assert stored["fsrsStability"] == pytest.approx(15.6911) and stored["interval"] == 16
    stats = call_tool(services, "study_stats", {})
    assert stats["scheduler"] == {"name": "fsrs", "desiredRetention": 0.9}


NODE_SCRIPT = """
import { fsrsStep, fsrsPreview } from '%s';
const input = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf-8'));
const out = input.cases.map(([stats, grade, now, ret]) => fsrsStep(stats, grade, new Date(now), ret));
const previews = input.previews.map(([now, ret]) => fsrsPreview(undefined, new Date(now), ret));
console.log(JSON.stringify({ out, previews }));
"""


def _cases():
    seq, cases, stats = [], [], {}
    days = ["2026-10-02T10:00:00Z", "2026-10-02T18:00:00Z", "2026-10-05T09:00:00Z", "2026-10-20T23:30:00Z",
            "2026-12-01T07:00:00Z", "2027-03-15T12:00:00Z"]
    for when, grade in zip(days, ["good", "hard", "good", "again", "easy", "good"]):
        seq.append([dict(stats), grade, when, 0.9])
        nxt = fsrs.step(stats, grade, datetime.fromisoformat(when.replace("Z", "+00:00")), 0.9)
        stats = {**stats, **nxt, "seen": (stats.get("seen") or 0) + 1, "lastSeenAt": when}
    cases.extend(seq)
    cases.append([{"seen": 4, "interval": 21, "easeFactor": 1.7, "repetitions": 4, "lastSeenAt": "2026-09-01T00:00:00Z"},
                  "hard", "2026-10-02T10:00:00Z", 0.85])
    cases.append([{"seen": 2, "interval": 6, "repetitions": 2}, "again", "2026-10-02T10:00:00Z", 0.97])
    cases.append([{}, "easy", "2026-10-02T23:59:59Z", 0.7])
    cases.append([{"fsrsStability": 400.5, "fsrsDifficulty": 1.2, "lastSeenAt": "2025-01-01", "seen": 9}, "good",
                  "2026-10-02T10:00:00Z", None])
    return cases


def test_typescript_twin_matches_python():
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "esbuild").is_dir():
        pytest.skip("node or esbuild missing")
    inp = {"cases": _cases(), "previews": [["2026-10-02T10:00:00Z", r] for r in (0.7, 0.8, 0.9, 0.95, 0.97)]}
    expected = {
        "out": [fsrs.step(s, g, datetime.fromisoformat(w.replace("Z", "+00:00")),
                          fsrs.DEFAULT_RETENTION if r is None else r) for s, g, w, r in inp["cases"]],
        "previews": [fsrs.preview(None, datetime.fromisoformat(w.replace("Z", "+00:00")), r) for w, r in inp["previews"]],
    }
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        entry = work / "entry.ts"
        entry.write_text(NODE_SCRIPT % (ROOT / "src" / "domain" / "fsrs.ts").as_posix().replace("'", "\\'"),
                         encoding="utf-8")
        (work / "input.json").write_text(json.dumps(inp), encoding="utf-8")
        bundle = work / "entry.cjs"
        build = ("require('esbuild').buildSync({entryPoints: [process.argv[1]], bundle: true, platform: 'node', "
                 "format: 'cjs', outfile: process.argv[2], logLevel: 'error'})")
        subprocess.run([node, "-e", build, str(entry), str(bundle)], check=True, cwd=ROOT)
        done = subprocess.run([node, str(bundle), str(work / "input.json")], check=True, capture_output=True,
                              text=True, encoding="utf-8")
    got = json.loads(done.stdout)
    assert got["previews"] == expected["previews"]
    for g, e in zip(got["out"], expected["out"]):
        assert g == {k: (pytest.approx(v) if isinstance(v, float) else v) for k, v in e.items()}


def test_synced_settings_take_the_scheduler_chosen_last():
    from hypatia.merge import merge_synced_settings

    base = {"alias": "", "importedPackIds": []}
    server = {**base, "scheduler": "sm2", "desiredRetention": 0.9, "schedulerSetAt": "2026-10-01T10:00:00.000Z"}
    device = {**base, "scheduler": "fsrs", "desiredRetention": 0.85, "schedulerSetAt": "2026-10-02T10:00:00.000Z"}
    got = merge_synced_settings(server, device)
    assert (got["scheduler"], got["desiredRetention"]) == ("fsrs", 0.85)
    got = merge_synced_settings(device, server)
    assert (got["scheduler"], got["desiredRetention"]) == ("fsrs", 0.85)
    assert merge_synced_settings(base, device)["scheduler"] == "fsrs"
    assert "scheduler" not in merge_synced_settings(base, base)
