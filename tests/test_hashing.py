"""hashing.py must produce exactly the hashes/normalizations of src/domain/*.ts:
dedup in sync depends on it. The parity test runs the real TypeScript with node."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from hypatia.hashing import compute_concept_hash, compute_content_hash, normalize_text, slugify

ROOT = Path(__file__).resolve().parent.parent

TRICKY = [
    "  Hola   Mundo  ", "ÁRBOL ñandú Pingüino", "Ἀθῆναι ΟΔΥΣΣΕΥΣ σοφός", "ΣΊΣΥΦΟΣ", "İstanbul IĞDIR ı",
    "$\\frac{a}{b}$ + \\alpha_{i}^{2}", "tab\tnew\nline\r\nend", "nbsp here and　there",
    "zero​width", "bom﻿inside", "emoji 🎓📚 ok", "Straße ß", "ﬁ ligature", "Ǆ dz", "é combining",
    "Ångström Å", "ÇA ça", "¿Qué? ¡Sí!", "", "   ", "a b c", "x\u0085y", "file\x1cSep",
    "ﾃｽﾄ halfwidth", "Ⅻ roman", "Ａ fullwidth", "😀 vs ｚ order", "UPPER lower MiXeD", "123-456 -- --x",
    "Ingeniería del Software II", "  --lead-and-trail--  ", "a_b c.d/e", "Ōsaka Ūtopia", "Ελληνικά ΆΈΉ",
]


def _questions():
    qs = []
    for i, s in enumerate(TRICKY):
        qs.append({"type": "TEST", "prompt": s, "options": [{"id": "a", "text": s + " A"}, {"id": "b", "text": "😀" + s},
                   {"id": "c", "text": "ｚ" + s}], "correctOptionIds": ["c", "b"]})
        qs.append({"type": "DESARROLLO", "prompt": "P" + s, "modelAnswer": s})
        qs.append({"type": "PRACTICO", "prompt": s, "modelAnswer": None})
        qs.append({"type": "COMPLETAR", "prompt": s, "clozeText": s + " {{b1}}",
                   "blanks": [{"id": "b1", "accepted": [s, "ÉL", "😀"]}, {"id": "b2", "accepted": []}]})
    qs.append({"type": "TEST", "prompt": "no options"})
    return qs


NODE_SCRIPT = """
import { normalizeText, slugify } from './normalize.ts';
import { computeContentHash } from './hashing.ts';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
async function conceptHash(category, title, content) {
  const raw = [category, normalizeText(title), normalizeText(content)].join('::');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const input = JSON.parse(process.argv[2]);
const out = { norm: [], normKeep: [], slug: [], hashes: [], concepts: [] };
for (const s of input.strings) { out.norm.push(normalizeText(s)); out.normKeep.push(normalizeText(s, false)); out.slug.push(slugify(s)); }
for (const q of input.questions) out.hashes.push(await computeContentHash(q));
for (const s of input.strings) out.concepts.push(await conceptHash('formula', s, s + ' x'));
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def ts_results(tmp_path_factory):
    node = shutil.which("node")
    esbuild = ROOT / "node_modules" / "esbuild"
    if not node or not esbuild.is_dir():
        pytest.skip("node or esbuild missing")
    work = tmp_path_factory.mktemp("parity")
    domain = ROOT / "src" / "domain"
    for name in ("normalize.ts", "hashing.ts"):
        (work / name).write_text((domain / name).read_text(encoding="utf-8").replace("from './normalize'", "from './normalize.ts'"),
                                 encoding="utf-8")
    (work / "entry.ts").write_text(NODE_SCRIPT, encoding="utf-8")
    bundle = work / "entry.mjs"
    # esbuild's JS API through node: node_modules/.bin/esbuild is a shell shim on Windows.
    build = ("require('esbuild').buildSync({entryPoints: [process.argv[1]], bundle: true, platform: 'node', "
             "format: 'esm', outfile: process.argv[2], logLevel: 'error'})")
    subprocess.run([node, "-e", build, str(work / "entry.ts"), str(bundle)], check=True, cwd=ROOT)
    payload = json.dumps({"strings": TRICKY, "questions": _questions()})
    done = subprocess.run([node, str(bundle), payload], check=True, capture_output=True, text=True, encoding="utf-8")
    return json.loads(done.stdout)


def test_normalize_and_slugify_match_typescript(ts_results):
    assert [normalize_text(s) for s in TRICKY] == ts_results["norm"]
    assert [normalize_text(s, False) for s in TRICKY] == ts_results["normKeep"]
    assert [slugify(s) for s in TRICKY] == ts_results["slug"]


def test_content_hash_matches_typescript(ts_results):
    assert [compute_content_hash(q) for q in _questions()] == ts_results["hashes"]


def test_concept_hash_matches_typescript(ts_results):
    assert [compute_concept_hash("formula", s, s + " x") for s in TRICKY] == ts_results["concepts"]


def test_known_values():
    assert normalize_text("  ÁRBOL   Ñu ") == "arbol nu"
    assert slugify("Ingeniería del Software II") == "ingenieria-del-software-ii"
    same = compute_content_hash({"type": "TEST", "prompt": "¿Qué?", "options": [{"id": "x", "text": "B"}, {"id": "y", "text": "a"}],
                                 "correctOptionIds": ["y"]})
    other_ids = compute_content_hash({"type": "TEST", "prompt": "¿qué?", "options": [{"id": "1", "text": "a"}, {"id": "2", "text": "b"}],
                                      "correctOptionIds": ["1"]})
    assert same == other_ids and same.startswith("sha256:") and len(same) == 71
