"""src/utils/sanitizeHtml.ts + src/data/pageCards.ts (run with node): the TypeScript sanitizer is a twin of
hypatia/pages.py, so both must produce the same output for the same input."""

import json

from hypatia import pages
from test_pages import DIRTY, IMG
from test_teacher_ts import run_ts

SAMPLES = [
    DIRTY,
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<img src=x onerror=alert(1)>",
    "<a href=\" \tjavascript:alert(1)\">x</a>",
    "<p onmouseover=alert(1)>x</p><div style=\"background:url(//evil)\">y</div>",
    "<script>unterminated",
    "<style>@import 'http://e';</style>x",
    "<a href='data:text/html;base64,PHNjcmlwdD4='>x</a>",
    "<math><mi xlink:href=javascript:1>x</mi></math>",
    "<h2 title=\"a &amp; b\">T</h2><p>1 < 2 &amp; 3 &gt; 2</p><br/><hr><p>sin cerrar",
    f"<figure><img src='{IMG}' width=20 height=x><figcaption>fig</figcaption></figure>",
    "<table><tr><th colspan=2>h</th></tr><tr><td rowspan='3'>c</td></tr></table></td></p>",
]


def test_ts_sanitizer_matches_python_and_blocks_payloads():
    out = run_ts("""
import { sanitizeHtml, htmlToText, htmlTitle } from '@ROOT@/src/utils/sanitizeHtml';
import { buildPageCardData } from '@ROOT@/src/data/pageCards';
const samples = %s;
const cleaned = samples.map((s) => sanitizeHtml(s));
let card = null, err = null, none = null;
try { card = buildPageCardData('s1', 't1', '', samples[0]); } catch (e) { err = String(e); }
try { buildPageCardData('s1', 't1', 'x', '<script>1</script>'); } catch (e) { none = String(e.message); }
console.log(JSON.stringify({ cleaned, again: cleaned.map((c) => sanitizeHtml(c)), text: htmlToText(cleaned[9]),
  title: htmlTitle('<title> Mi  lección </title>'), card, err, none }));
""" % json.dumps(SAMPLES))
    assert out["cleaned"] == [pages.sanitize_html(s) for s in SAMPLES]
    assert out["again"] == out["cleaned"]  # idempotent
    joined = " ".join(out["cleaned"]).lower()
    for bad in ("<script", "onerror", "onmouseover", "javascript:", "http://", "<style", "@import", "data:text", "xlink", "style="):
        assert bad not in joined, bad
    assert out["text"] == pages.html_to_text(pages.sanitize_html(SAMPLES[9]))
    assert out["title"] == "Mi lección"
    card = out["card"]
    assert card["type"] == "DESARROLLO" and card["prompt"] == "Lección 1" and card["tags"] == ["pagina"]
    assert card["pageHtml"] == pages.sanitize_html(DIRTY) and "Hola mundo cursiva" in card["modelAnswer"]
    assert "no tiene contenido visible" in out["none"]
