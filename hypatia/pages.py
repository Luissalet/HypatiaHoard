"""Page cards: an HTML lesson that enters the spaced-repetition schedule and is reviewed whole.

A page card is an ordinary DESARROLLO question (so the due queue, SM-2/FSRS, sync, stats and the
PWA all keep working) with two extras: `pageHtml` (sanitized HTML, the lesson itself) and the tag
`pagina`. The prompt is the page title and `modelAnswer` is its plain text (search, dedupe).

Sanitizing is an allow-list tokenizer (no DOM): scripts, styles, frames, forms, event handlers,
inline styles, remote images and javascript: links never survive. Images are kept only as
`data:image/(png|jpeg|gif|webp)` URIs. The TypeScript twin is src/utils/sanitizeHtml.ts.
"""

from __future__ import annotations

import html as _html
import re
from typing import Any

from . import bank

PAGE_TAG = "pagina"
MAX_HTML = 1_500_000          # sanitized size, data: images included
MAX_TEXT = 16_000             # modelAnswer cap

ALLOWED = frozenset(
    "p br hr h1 h2 h3 h4 h5 h6 ul ol li strong b em i u s sub sup code pre blockquote table thead tbody tfoot "
    "tr th td caption colgroup col div span a img figure figcaption dl dt dd mark small abbr details summary "
    "section article header footer main nav aside kbd cite q del ins center".split())
VOID = frozenset({"br", "hr", "img", "col"})
DROP_WITH_CONTENT = frozenset(
    "script style iframe frame frameset object embed applet noscript template svg math head title textarea "
    "select option button form canvas audio video map xmp noembed noframes".split())
GLOBAL_ATTRS = ("title", "lang", "dir")
DATA_IMG = re.compile(r"^data:image/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$", re.I)
SAFE_HREF = re.compile(r"^(?:https?:|mailto:|#)", re.I)
_TOKEN = re.compile(r"<!--.*?-->|<![^>]*>|<\?.*?\?>|</?[a-zA-Z][^>]*>|<", re.S)
_TAG = re.compile(r"^<(/?)([a-zA-Z][a-zA-Z0-9:-]*)(.*?)(/?)>$", re.S)
_ATTR = re.compile(r"""([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?""")
_CTRL = re.compile(r"[\x00-\x20\x7f-\x9f]+")


def _attr_value(raw: str) -> str:
    return _html.unescape(raw)


def _esc_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_text(text: str) -> str:
    """Stray `<` becomes &lt;; entities and everything else are kept (the text never holds a tag)."""
    return text.replace("<", "&lt;")


def _clean_attrs(tag: str, rest: str) -> str:
    out: list[str] = []
    seen: set[str] = set()
    for m in _ATTR.finditer(rest):
        name = m.group(1).lower()
        if name in seen:
            continue
        raw = m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(4) or ""
        value = _attr_value(raw)
        keep: str | None = None
        if name in GLOBAL_ATTRS:
            keep = value[:300]
        elif tag == "a" and name == "href":
            compact = _CTRL.sub("", value)
            if SAFE_HREF.match(compact):
                keep = compact[:2000]
        elif tag == "img" and name == "src":
            compact = _CTRL.sub("", value)
            if DATA_IMG.match(compact):
                keep = compact
        elif tag == "img" and name == "alt":
            keep = value[:500]
        elif tag == "img" and name in ("width", "height") or tag in ("td", "th") and name in ("colspan", "rowspan"):
            if re.fullmatch(r"\d{1,4}", value.strip()):
                keep = value.strip()
        if keep is not None:
            seen.add(name)
            out.append(f' {name}="{_esc_attr(keep)}"')
    if tag == "img" and not any(a.startswith(" src=") for a in out):
        return ""  # an image without an allowed source is dropped by the caller
    if tag == "a" and any(a.startswith(" href=") for a in out):
        out.append(' target="_blank" rel="noopener noreferrer"')
    return "".join(out)


def sanitize_html(source: str) -> str:
    """Allow-list sanitizer. Returns safe HTML (fragment), possibly empty."""
    source = (source or "").replace("\x00", "")
    out: list[str] = []
    stack: list[str] = []
    pos = 0
    n = len(source)
    skipping: str | None = None
    for m in _TOKEN.finditer(source):
        if m.start() > pos and skipping is None:
            out.append(_esc_text(source[pos:m.start()]))
        pos = m.end()
        token = m.group(0)
        if token == "<":
            if skipping is None:
                out.append("&lt;")
            continue
        if token.startswith(("<!", "<?")):
            continue
        t = _TAG.match(token)
        if not t:
            continue
        closing, name, rest, selfclose = t.group(1) == "/", t.group(2).lower(), t.group(3), t.group(4)
        if skipping is not None:
            if closing and name == skipping:
                skipping = None
            continue
        if name in DROP_WITH_CONTENT:
            if not closing and not selfclose and not rest.rstrip().endswith("/"):
                skipping = name
            continue
        if name not in ALLOWED:
            continue  # unknown tag: unwrapped, its content stays
        if closing:
            if name in stack:
                while stack:
                    top = stack.pop()
                    out.append(f"</{top}>")
                    if top == name:
                        break
            continue
        attrs = _clean_attrs(name, rest)
        if name == "img":
            if attrs:
                out.append(f"<img{attrs}>")
            continue
        if name in VOID:
            out.append(f"<{name}>")
            continue
        out.append(f"<{name}{attrs}>")
        stack.append(name)
    if skipping is None and pos < n:
        out.append(_esc_text(source[pos:]))
    while stack:
        out.append(f"</{stack.pop()}>")
    return "".join(out).strip()


_BLOCK = re.compile(r"</?(?:p|div|br|hr|h[1-6]|li|ul|ol|tr|table|blockquote|pre|section|article|figure|figcaption|dt|dd|details|summary)\b[^>]*>", re.I)


def html_to_text(clean_html: str) -> str:
    """Plain text of already-sanitized HTML (line breaks at block boundaries)."""
    text = _BLOCK.sub("\n", clean_html)
    text = re.sub(r"<[^>]+>", "", text)
    text = _html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r" ?\n ?", "\n", text)).strip()


def title_of(source: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", source or "", re.I | re.S)
    if not m:
        m = re.search(r"<h1[^>]*>(.*?)</h1>", source or "", re.I | re.S)
    if not m:
        return None
    return " ".join(_html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).split())[:200] or None


# ---------- Markdown (notebook output) -> HTML ----------

def _inline(text: str) -> str:
    text = _html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])", r"<em>\1</em>", text)


def markdown_to_html(md: str) -> str:
    """Small, safe Markdown subset: headings, lists, quotes, code fences, bold/italic/code."""
    out: list[str] = []
    para: list[str] = []
    lst: str | None = None
    fence: list[str] | None = None

    def flush_para() -> None:
        if para:
            out.append("<p>" + _inline(" ".join(para)) + "</p>")
            para.clear()

    def close_list() -> None:
        nonlocal lst
        if lst:
            out.append(f"</{lst}>")
            lst = None

    for line in (md or "").splitlines():
        if fence is not None:
            if line.strip().startswith("```"):
                out.append("<pre><code>" + _html.escape("\n".join(fence), quote=False) + "</code></pre>")
                fence = None
            else:
                fence.append(line)
            continue
        s = line.strip()
        if s.startswith("```"):
            flush_para(); close_list(); fence = []
            continue
        if not s:
            flush_para(); close_list()
            continue
        h = re.match(r"^(#{1,6})\s+(.*)$", s)
        b = re.match(r"^[-*+]\s+(.*)$", s)
        o = re.match(r"^\d+[.)]\s+(.*)$", s)
        if h:
            flush_para(); close_list()
            out.append(f"<h{len(h.group(1))}>{_inline(h.group(2))}</h{len(h.group(1))}>")
        elif b or o:
            flush_para()
            kind = "ul" if b else "ol"
            if lst != kind:
                close_list(); out.append(f"<{kind}>"); lst = kind
            out.append("<li>" + _inline((b or o).group(1)) + "</li>")
        elif s.startswith(">"):
            flush_para(); close_list()
            out.append("<blockquote>" + _inline(s.lstrip("> ")) + "</blockquote>")
        elif re.fullmatch(r"[-*_]{3,}", s):
            flush_para(); close_list(); out.append("<hr>")
        else:
            close_list(); para.append(s)
    if fence is not None:
        out.append("<pre><code>" + _html.escape("\n".join(fence), quote=False) + "</code></pre>")
    flush_para(); close_list()
    return "".join(out)


# ---------- the card ----------

def is_page(question: dict) -> bool:
    return bool(question.get("pageHtml"))


def build(title: str, html: str) -> tuple[str, str, str]:
    """(title, sanitized html, plain text) or ValueError."""
    clean = sanitize_html(html)
    text = html_to_text(clean)
    if not text and "<img" not in clean:
        raise ValueError("The page has no visible content after sanitizing.")
    if len(clean) > MAX_HTML:
        raise ValueError(f"The page is too large ({len(clean)} characters after sanitizing; the limit is {MAX_HTML}).")
    title = " ".join((title or title_of(html) or "").split())[:300]
    if not title:
        raise ValueError("A page card needs a title.")
    return title, clean, text


def add_page(services, subject: dict, topic: dict, title: str, html: str, tags: list[str] | None = None,
             source_ref: str | None = None) -> tuple[dict, bool]:
    """Create a page card in `subject`/`topic` (dedupe by content hash like any question)."""
    title, clean, text = build(title, html)
    all_tags = list(dict.fromkeys([PAGE_TAG, *(tags or [])]))
    data: dict[str, Any] = {"type": "DESARROLLO", "prompt": title, "modelAnswer": text[:MAX_TEXT] or title,
                            "pageHtml": clean, "origin": "alumno", "tags": all_tags}
    return bank.add_question(services, subject, topic, data, source_ref=source_ref)


def list_pages(services, subject_id: str | None, due_only: bool = False, limit: int = 50) -> list[dict]:
    today = services.today()
    rows = []
    for q in services.store.list("question", subject_id):
        if not is_page(q):
            continue
        stats = q.get("stats") or {}
        due = (not stats.get("seen")) or bool(stats.get("nextReviewAt") and stats["nextReviewAt"] <= today)
        if due_only and not due:
            continue
        rows.append({"id": q["id"], "title": q.get("prompt"), "subjectId": q.get("subjectId"), "topicId": q.get("topicId"),
                     "chars": len(q.get("modelAnswer") or ""), "seen": stats.get("seen") or 0,
                     "nextReviewAt": stats.get("nextReviewAt"), "due": due, "tags": q.get("tags") or []})
    rows.sort(key=lambda r: (not r["due"], r["nextReviewAt"] or "", r["title"] or ""))
    return rows[:limit]
