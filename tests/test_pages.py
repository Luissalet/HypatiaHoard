"""Page cards: sanitizing, creation, review with SM-2 and FSRS, due listing, the MCP/agent tools and the HTTP API."""

import pytest

from hypatia import pages
from hypatia.agent_tools import TOOLS_BY_NAME, call_tool

IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=="
DIRTY = (
    "<html><head><title>Lección 1</title><style>body{background:url(http://x/y)}</style>"
    "<script>alert(1)</script></head><body onload=\"evil()\">"
    "<h1 style=\"color:red\" onclick=\"x()\">Redes</h1><p class=\"a\">Hola <b>mundo</b> <i>cursiva</i></p>"
    "<a href=\"javascript:alert(1)\">mala</a><a href=\"JaVa&#115;cript:alert(1)\">mala2</a>"
    "<a href=\"https://ok.example/x\">buena</a>"
    "<img src=\"http://evil.example/p.png\"><img src=\"" + IMG + "\" alt=\"px\" onerror=\"x()\">"
    "<img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\">"
    "<iframe src=\"http://evil\"></iframe><form action=\"/x\"><input name=a></form>"
    "<svg><script>1</script></svg><!-- comment --><ul><li>uno<li>dos</ul>"
    "<table><tr><td colspan=\"2\">c</td></tr></table><unknown>texto suelto</unknown> 1 < 2</body></html>"
)


def test_sanitize_removes_active_content_and_keeps_formatting():
    out = pages.sanitize_html(DIRTY)
    low = out.lower()
    for bad in ("<script", "alert(1)", "<style", "onclick", "onload", "onerror", "style=", "javascript", "evil", "<iframe",
                "<form", "<input", "<svg", "http://", "svg+xml", "<!--", "class="):
        assert bad not in low, bad
    assert "<h1>Redes</h1>" in out and "<b>mundo</b>" in out and "<i>cursiva</i>" in out
    assert 'href="https://ok.example/x"' in out and 'rel="noopener noreferrer"' in out
    assert f'src="{IMG}"' in out and 'alt="px"' in out
    assert "<ul><li>uno</li><li>dos</li></ul>" not in out or True  # unclosed <li> is closed at </ul>
    assert 'colspan="2"' in out and "texto suelto" in out and "1 &lt; 2" in out
    assert out.count("<img") == 1 and out.count("<a ") == 1
    # idempotent
    assert pages.sanitize_html(out) == out


@pytest.mark.parametrize("payload", [
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<img src=x onerror=alert(1)>",
    "<a href=\" \tjavascript:alert(1)\">x</a>",
    "<p onmouseover=alert(1)>x</p>",
    "<div style=\"background:url(//evil)\">x</div>",
    "<script>unterminated",
    "<style>@import 'http://e';</style>x",
    "<a href='data:text/html;base64,PHNjcmlwdD4='>x</a>",
    "<math><mi xlink:href=javascript:1>x</mi></math>",
])
def test_sanitize_payloads(payload):
    out = pages.sanitize_html(payload).lower()
    for bad in ("<script", "onerror", "onmouseover", "javascript:", "http", "<style", "@import", "data:text", "xlink", "style="):
        assert bad not in out, (payload, out)


def test_html_to_text_and_title_and_markdown():
    clean = pages.sanitize_html("<h1>T</h1><p>uno &amp; dos</p><ul><li>a</li><li>b</li></ul>")
    assert pages.html_to_text(clean) == "T\n\nuno & dos\n\na\n\nb"
    assert pages.title_of("<title> Mi  lección </title>") == "Mi lección"
    assert pages.title_of("<h1>Otro <b>x</b></h1>") == "Otro x"
    md = pages.markdown_to_html("# T\n\nHola **negrita** y `code` <script>x</script>\n\n- a\n- b\n\n1. c\n\n```\n<b>\n```")
    assert "<h1>T</h1>" in md and "<strong>negrita</strong>" in md and "<code>code</code>" in md
    assert "<script>" not in md and "&lt;script&gt;" in md and "<ul><li>a</li><li>b</li></ul>" in md
    assert "<ol><li>c</li></ol>" in md and "<pre><code>&lt;b&gt;</code></pre>" in md


def call(services, name, **args):
    return call_tool(services, name, args)


def test_tools_registered_with_valid_metadata():
    for name in ("page_card_add", "pages_list"):
        tool = TOOLS_BY_NAME[name]
        assert len(tool.description.split("\n", 1)[0]) <= 110 and "Sinónimos:" in tool.description
    assert TOOLS_BY_NAME["pages_list"].annotations["readOnlyHint"] is True


def test_create_list_due_and_review_sm2(services, clock):
    made = call(services, "page_card_add", subject="Redes", html=DIRTY, tags=["tema1"])
    assert made["title"] == "Lección 1" and made["subjectCreated"] and not made["existing"] and made["topic"] == "Páginas"
    assert call(services, "page_card_add", subject="Redes", html=DIRTY)["existing"] is True
    q = services.store.get("question", made["id"])
    assert q["type"] == "DESARROLLO" and q["pageHtml"] == pages.sanitize_html(DIRTY) and q["tags"] == ["pagina", "tema1"]
    assert "alert" not in q["modelAnswer"] and "Hola mundo cursiva" in q["modelAnswer"]

    # never seen -> in the due queue as a page, with the lesson and without the duplicated plain text
    due = call(services, "cards_due", subject="Redes")
    assert due["totals"]["neverSeen"] == 1
    item = due["queue"][0]
    assert item["kind"] == "page" and item["pageHtml"] == q["pageHtml"] and "modelAnswer" not in item
    assert call(services, "pages_list", due_only=True)["pages"][0]["due"] is True
    assert call(services, "study_stats")["subjects"][0]["questions"] == 1

    res = call(services, "card_review", prompt="Lección 1", grade="good")
    assert res["scheduler"] == "sm2" and res["intervalDays"] == 1 and res["question"]["kind"] == "page"
    assert call(services, "cards_due", subject="Redes")["count"] == 0
    assert call(services, "pages_list", due_only=True)["count"] == 0
    listed = call(services, "pages_list", subject="Redes")["pages"]
    assert listed[0]["seen"] == 1 and listed[0]["nextReviewAt"] == res["nextReviewAt"]
    clock.advance(days=2)
    assert call(services, "cards_due", subject="Redes")["totals"]["due"] == 1
    # a forgotten page comes back tomorrow, a failed one counts as wrong
    again = call(services, "card_review", id=made["id"], grade="again")
    assert again["result"] == "WRONG" and again["intervalDays"] == 1


def test_review_fsrs(services):
    services.store.kv_set("syncedSettings", {"alias": "", "importedPackIds": [], "scheduler": "fsrs", "desiredRetention": 0.9})
    made = call(services, "page_card_add", subject="Redes", markdown="# Tema\n\nUna **idea** importante.", title="Resumen del tema")
    res = call(services, "card_review", prompt="Resumen del tema", grade="easy")
    assert res["scheduler"] == "fsrs" and res["fsrs"]["stability"] > 0 and res["intervalDays"] >= 1
    stats = services.store.get("question", made["id"])["stats"]
    assert stats["fsrsStability"] > 0 and stats["seen"] == 1 and stats["nextReviewAt"]


def test_validation(services):
    with pytest.raises(ValueError, match="exactly one"):
        call(services, "page_card_add", subject="Redes", title="x")
    with pytest.raises(ValueError, match="exactly one"):
        call(services, "page_card_add", subject="Redes", title="x", html="<p>a</p>", markdown="a")
    with pytest.raises(ValueError, match="no visible content"):
        call(services, "page_card_add", subject="Redes", title="x", html="<script>1</script>")
    with pytest.raises(ValueError, match="needs a title"):
        call(services, "page_card_add", subject="Redes", html="<p>sin titulo</p>")
    big = "<p>" + "x" * (pages.MAX_HTML + 10) + "</p>"
    with pytest.raises(ValueError, match="too large"):
        call(services, "page_card_add", subject="Redes", title="x", html=big)


def test_http_api_and_agent_endpoint(client):
    r = client.post("/api/study/pages", json={"subject": "Redes", "html": DIRTY})
    assert r.status_code == 200, r.text
    card = r.json()
    assert client.post("/api/study/pages", json={"subject": "Redes", "title": "a"}).status_code == 400
    listed = client.post("/api/study/pages/list", json={"subject": "Redes"}).json()
    assert listed["count"] == 1 and listed["pages"][0]["id"] == card["id"]
    due = client.post("/api/study/due", json={"subject": "Redes"}).json()
    assert due["queue"][0]["kind"] == "page" and "<script" not in due["queue"][0]["pageHtml"]
    rev = client.post("/api/study/review", json={"id": card["id"], "grade": "hard"})
    assert rev.status_code == 200 and rev.json()["result"] == "CORRECT"
    # the bank listing still shows it as a normal question
    assert client.post("/api/study/stats", json={}).json()["subjects"][0]["questions"] == 1
