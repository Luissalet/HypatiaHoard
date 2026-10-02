"""A small PDF writer (no dependency): A4 pages, Helvetica / Helvetica-Bold in
WinAnsi encoding (Spanish accents), wrapped paragraphs and rules. Used by the
`exam_export_pdf` tool. The app prints the same exam with formulas rendered
(src/utils/teacherPdf.ts); here LaTeX stays as its source text."""

from __future__ import annotations

import re
import unicodedata
import zlib
from typing import Any, Optional

from . import core

PAGE_W, PAGE_H = 595.28, 841.89
MARGIN = 56.0
CONTENT_W = PAGE_W - 2 * MARGIN

_HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
         556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
         500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
         556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
         278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
_HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
           556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
           556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584,
           556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
           333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]


def _char_width(ch: str, bold: bool) -> int:
    table = _HELV_B if bold else _HELV
    code = ord(ch)
    if 32 <= code <= 126:
        return table[code - 32]
    base = unicodedata.normalize("NFD", ch)[:1]
    if base and 32 <= ord(base) <= 126:
        return table[ord(base) - 32]
    return 556


def text_width(text: str, size: float, bold: bool = False) -> float:
    return sum(_char_width(c, bold) for c in text) * size / 1000.0


def wrap(text: str, size: float, width: float, bold: bool = False) -> list[str]:
    lines: list[str] = []
    for para in (text or "").split("\n"):
        words = para.split(" ")
        current = ""
        for word in words:
            candidate = word if not current else current + " " + word
            if text_width(candidate, size, bold) <= width:
                current = candidate
                continue
            if current:
                lines.append(current)
            while text_width(word, size, bold) > width and len(word) > 1:  # a very long token
                cut = len(word)
                while cut > 1 and text_width(word[:cut], size, bold) > width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            current = word
        lines.append(current)
    return lines


def _escape(text: str) -> bytes:
    raw = text.encode("cp1252", errors="replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


class PdfDoc:
    def __init__(self, title: str = ""):
        self.title = title
        self.pages: list[list[bytes]] = []
        self.y = 0.0
        self.new_page()

    # ---------- primitives ----------
    def new_page(self) -> None:
        self.pages.append([])
        self.y = PAGE_H - MARGIN

    def _ops(self) -> list[bytes]:
        return self.pages[-1]

    def text_at(self, x: float, y: float, text: str, size: float = 10.5, bold: bool = False,
                gray: float = 0.0) -> None:
        font = b"/F2" if bold else b"/F1"
        self._ops().append(b"BT %s %.2f Tf %.3f g %.2f %.2f Td (" % (font, size, gray, x, y) + _escape(text) + b") Tj ET")

    def rule(self, gray: float = 0.75) -> None:
        self.ensure(8)
        y = self.y - 4
        self._ops().append(b"%.3f G 0.6 w %.2f %.2f m %.2f %.2f l S" % (gray, MARGIN, y, PAGE_W - MARGIN, y))
        self.y -= 10

    def ensure(self, height: float) -> None:
        if self.y - height < MARGIN:
            self.new_page()

    # ---------- flow ----------
    def para(self, text: str, size: float = 10.5, bold: bool = False, indent: float = 0.0, gap: float = 4.0,
             gray: float = 0.0) -> None:
        leading = size * 1.35
        for line in wrap(text, size, CONTENT_W - indent, bold):
            self.ensure(leading)
            self.y -= leading
            if line:
                self.text_at(MARGIN + indent, self.y, line, size, bold, gray)
        self.y -= gap

    def blank_lines(self, n: int) -> None:
        for _ in range(n):
            self.ensure(22)
            self.y -= 22
            self._ops().append(b"0.8 G 0.4 w %.2f %.2f m %.2f %.2f l S" % (MARGIN + 14, self.y, PAGE_W - MARGIN, self.y))
        self.y -= 6

    def spacer(self, h: float) -> None:
        self.y -= h

    # ---------- output ----------
    def render(self) -> bytes:
        objects: list[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)

        catalog = add(b"")  # filled later
        pages_obj = add(b"")
        f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        f2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
        kids = []
        total = len(self.pages)
        for n, ops in enumerate(self.pages, start=1):
            footer = b"BT /F1 8 Tf 0.5 g %.2f %.2f Td (" % (PAGE_W / 2 - 10, MARGIN / 2) + _escape(f"{n} / {total}") + b") Tj ET"
            stream = zlib.compress(b"\n".join(ops + [footer]))
            content = add(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream) + stream + b"\nendstream")
            kids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Contents %d 0 R "
                            b"/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> >>"
                            % (pages_obj, PAGE_W, PAGE_H, content, f1, f2)))
        objects[pages_obj - 1] = (b"<< /Type /Pages /Count %d /Kids [" % len(kids)
                                  + b" ".join(b"%d 0 R" % k for k in kids) + b"] >>")
        objects[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj
        info = add(b"<< /Title (" + _escape(self.title) + b") /Producer (Hypatia's Hoard) >>")
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
        for off in offsets:
            out += b"%010d 00000 n \n" % off
        out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
            len(objects) + 1, catalog, info, xref)
        return bytes(out)


# ---------------------------------------------------------------- exam documents

def plain(md: Optional[str]) -> str:
    """Markdown to printable text (emphasis and code marks removed; LaTeX kept as source)."""
    text = md or ""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[imagen]", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(\*\*|__|`)", "", text)
    text = re.sub(r"(?m)^#{1,6}\s*", "", text)
    return text.strip()


def _num(value: Any) -> str:
    try:
        return f"{float(value or 0):g}".replace(".", ",")
    except (TypeError, ValueError):
        return "0"


def _points(p: Any) -> str:
    try:
        value = float(p)
    except (TypeError, ValueError):
        return ""
    shown = f"{value:g}".replace(".", ",")
    return f"{shown} punto" + ("" if value == 1 else "s")


def _header(doc: PdfDoc, exam: dict, subject_name: str, label: Optional[str], key: bool = False) -> None:
    h = exam.get("header") or {}
    top = " · ".join(x for x in (h.get("centre"), h.get("course"), subject_name) if x)
    if top:
        doc.para(top, 9.5, gray=0.35, gap=2)
    title = exam.get("title") or "Examen"
    if key:
        title = f"Solucionario · {title}"
    doc.para(title + (f" · Versión {label}" if label else ""), 15, bold=True, gap=2)
    meta = []
    if h.get("date"):
        meta.append(f"Fecha: {h['date']}")
    if h.get("durationMin"):
        meta.append(f"Duración: {h['durationMin']} min")
    total = sum(float(i.get("points") or 0) for i in exam.get("items") or [])
    meta.append("Puntuación total: " + _num(total))
    doc.para(" · ".join(meta), 9.5, gray=0.35, gap=4)
    if not key:
        doc.para("Nombre y apellidos: ______________________________________________", 10.5, gap=6)
        if h.get("instructions"):
            doc.para(plain(h["instructions"]), 9.5, gap=4)
    doc.rule()


def _cloze(text: str) -> str:
    return re.sub(r"\{\{[^}]+\}\}", "__________", text or "")


def exam_pdf(exam: dict, questions: dict[str, dict], subject_name: str, rubrics: dict[str, dict],
             *, versions: Optional[list[str]] = None, with_key: bool = True, with_rubrics: bool = True) -> bytes:
    doc = PdfDoc(exam.get("title") or "Examen")
    points = {i["questionId"]: i.get("points") for i in exam.get("items") or []}
    labels = versions or [v["label"] for v in exam.get("versions") or []] or ["A"]
    many = len(exam.get("versions") or []) > 1
    first = True
    for label in labels:
        if not first:
            doc.new_page()
        first = False
        version = core.find_version(exam, label)
        _header(doc, exam, subject_name, label if many else None)
        for pos, qid in enumerate(version.get("questionOrder") or [], start=1):
            q = questions.get(qid)
            if not q:
                continue
            doc.ensure(60)
            doc.para(f"{pos}. ({_points(points.get(qid))})", 10.5, bold=True, gap=1)
            doc.para(plain(q.get("prompt")), 10.5, indent=14, gap=3)
            if q.get("type") == "TEST":
                order = core.option_order_for(version, q)
                texts = {str(o.get("id")): o.get("text") for o in q.get("options") or []}
                for i, oid in enumerate(order):
                    doc.para(f"{core.LETTERS[i]}) {plain(texts.get(oid))}", 10.5, indent=24, gap=1)
                doc.spacer(6)
            elif q.get("type") == "COMPLETAR":
                doc.para(plain(_cloze(q.get("clozeText"))), 10.5, indent=24, gap=6)
            else:
                doc.blank_lines(8 if q.get("type") == "DESARROLLO" else 10)
    if with_key:
        for label in labels:
            doc.new_page()
            _header(doc, exam, subject_name, label if many else None, key=True)
            for row in core.answer_key(exam, questions, label):
                q = questions.get(row["questionId"]) or {}
                if row["type"] == "TEST":
                    answer = ", ".join(row.get("letters") or [])
                elif row["type"] == "COMPLETAR":
                    answer = " | ".join(" / ".join(v) for v in (row.get("blanks") or {}).values())
                else:
                    answer = plain(row.get("modelAnswer")) or "(sin respuesta modelo)"
                doc.para(f"{row['position']}. ({_points(row.get('points'))}) {plain(q.get('prompt'))[:120]}", 9.5,
                         bold=True, gap=1)
                doc.para(answer, 10, indent=14, gap=5)
    if with_rubrics:
        used = []
        for item in exam.get("items") or []:
            rid = item.get("rubricId")
            if rid and rid in rubrics and rid not in used:
                used.append(rid)
        used += [rid for rid, r in rubrics.items() if not r.get("questionId") and rid not in used]
        if used:
            doc.new_page()
            doc.para(f"Rúbricas · {exam.get('title') or 'Examen'}", 15, bold=True, gap=6)
            base = core.find_version(exam, "A")
            positions = {qid: i for i, qid in enumerate(base.get("questionOrder") or [], start=1)}
            for rid in used:
                r = rubrics[rid]
                where = f"Pregunta {positions.get(r.get('questionId'))} (versión A)" if r.get("questionId") else "Todo el examen"
                doc.ensure(50)
                doc.para(f"{r.get('title') or 'Rúbrica'} · {where}", 11.5, bold=True, gap=3)
                for c in r.get("criteria") or []:
                    doc.para(f"{c.get('name')} (peso {_num(c.get('weight'))})", 10.5, bold=True, indent=8, gap=1)
                    for level in c.get("levels") or []:
                        doc.para(f"{_num(level.get('points'))} — {level.get('descriptor')}", 10, indent=22, gap=1)
                    doc.spacer(4)
    return doc.render()
