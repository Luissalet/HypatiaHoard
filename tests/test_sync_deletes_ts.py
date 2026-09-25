"""hoardSyncCore.serverDeletes (TypeScript, run with node): deleting one local copy of a question the
server had deduplicated must not delete the server record another local copy still maps to."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

NODE_SCRIPT = """
import { serverDeletes } from './hoardSyncCore.ts';
const { queue, idMap, live } = JSON.parse(process.argv[2]);
const alive = new Set(live);
const out = await serverDeletes(queue, idMap, async (kind, id) => alive.has(kind + ':' + id));
console.log(JSON.stringify(out));
"""


def run_ts(payload: dict) -> list:
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "esbuild").is_dir():
        pytest.skip("node or esbuild missing")
    return json.loads(_run(node, payload))


def _run(node: str, payload: dict) -> str:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "hoardSyncCore.ts").write_text((ROOT / "src" / "data" / "hoardSyncCore.ts").read_text(encoding="utf-8"),
                                               encoding="utf-8")
        (work / "entry.ts").write_text(NODE_SCRIPT, encoding="utf-8")
        bundle = work / "entry.mjs"
        build = ("require('esbuild').buildSync({entryPoints: [process.argv[1]], bundle: true, platform: 'node', "
                 "format: 'esm', outfile: process.argv[2], logLevel: 'error'})")
        subprocess.run([node, "-e", build, str(work / "entry.ts"), str(bundle)], check=True, cwd=ROOT)
        done = subprocess.run([node, str(bundle), json.dumps(payload)], check=True, capture_output=True, text=True,
                              encoding="utf-8")
        return done.stdout


T = "2026-09-25T10:00:00.000Z"


def test_deleting_a_local_duplicate_keeps_the_shared_server_record():
    # q6 came from the server; dup1 is a local duplicate the server deduped onto q6.
    id_map = {"question": {"dup1": "q6"}}
    # The user removes the duplicate: q6 is still here locally -> nothing to delete on the server.
    assert run_ts({"queue": [{"kind": "question", "id": "dup1", "deletedAt": T}], "idMap": id_map,
                   "live": ["question:q6"]}) == []
    # "Eliminar duplicadas" kept the duplicate and removed q6 itself: same answer.
    assert run_ts({"queue": [{"kind": "question", "id": "q6", "deletedAt": T}], "idMap": id_map,
                   "live": ["question:dup1"]}) == []
    # Both copies deleted: the server record goes, once per queued delete, under its server id.
    both = run_ts({"queue": [{"kind": "question", "id": "dup1", "deletedAt": T}, {"kind": "question", "id": "q6", "deletedAt": T}],
                   "idMap": id_map, "live": []})
    assert both == [{"kind": "question", "id": "q6", "deletedAt": T}] * 2
    # An ordinary delete is untouched.
    assert run_ts({"queue": [{"kind": "topic", "id": "t1", "deletedAt": T}], "idMap": id_map, "live": ["question:q6"]}) == [
        {"kind": "topic", "id": "t1", "deletedAt": T}]
