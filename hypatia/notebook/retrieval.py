"""Retrieval over indexed chunks (FTS5 bm25 + optional cosine rerank) and citations."""

from __future__ import annotations

import re
from typing import Any, Optional

from ..hashing import slugify
from ..hoard_link.docs import textsearch, vecmath
from ..hoard_link.docs.vecmath import pack_vec, unpack_vec  # noqa: F401 - the stored vector format
from . import llm
from .schema import row, rows

FTS_CANDIDATES = 40
DEFAULT_K = 8
VECTOR_BLOCK = 4000  # vectors read and scored at a time: memory stays flat however big the notebook grows
SNIPPET_CHARS = 280


# ---------------------------------------------------------------- scope

def _topic_matches(topic: dict[str, Any], src: dict[str, Any]) -> bool:
    fname = (src.get("filename") or "").lower()
    pdf = (topic.get("pdfFilename") or "").lower()
    if pdf and (fname == pdf or fname == pdf.rsplit("/", 1)[-1]):
        return True
    t = slugify(topic.get("title") or "")
    if not t:
        return False
    for cand in (src.get("title") or "", fname.rsplit(".", 1)[0]):
        s = slugify(cand)
        if s and (s == t or (len(t) >= 8 and (s.startswith(t) or t.startswith(s) and len(s) >= 8))):
            return True
    return False


def resolve_scope(services: Any, subject_id: str, topic: Optional[str] = None,
                  source_ids: Optional[list[str]] = None) -> dict[str, Any]:
    """{sourceIds, topic, note}: the indexed sources a request looks at."""
    srcs = rows(services, "SELECT id, filename, title, status FROM sources WHERE subject_id=?", (subject_id,))
    note = None
    topic_obj = None
    if source_ids:
        wanted = set(source_ids)
        srcs = [s for s in srcs if s["id"] in wanted]
    if topic:
        topic_obj = services.resolve_topic(subject_id, topic)
        matched = [s for s in srcs if _topic_matches(topic_obj, s)]
        if matched:
            srcs = matched
        else:
            note = (f"Ninguna fuente está asociada al tema «{topic_obj.get('title')}»; "
                    "se busca en todas las fuentes de la asignatura.")
    indexed = [s["id"] for s in srcs if s["status"] == "indexed"]
    return {"sourceIds": indexed, "topic": topic_obj, "note": note, "total": len(srcs)}


# ---------------------------------------------------------------- search

def fts_query(text: str) -> Optional[str]:
    """Any of the content words as prefixes (the widest net; bm25 ranks the rest), or None."""
    return textsearch.fts_query(text, mode="or", max_terms=16) or None


def _marks(ids: list[Any]) -> str:
    return ",".join("?" * len(ids))


def _fts(services: Any, query: str, source_ids: list[str], limit: int) -> dict[int, float]:
    q = fts_query(query)
    if not q or not source_ids:
        return {}
    sql = (f"SELECT c.id AS id, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid"
           f" WHERE chunks_fts MATCH ? AND c.source_id IN ({_marks(source_ids)}) ORDER BY score LIMIT ?")
    try:
        found = rows(services, sql, [q, *source_ids, limit])
    except Exception:  # noqa: BLE001 - malformed query: no lexical hits
        return {}
    return {r["id"]: -float(r["score"]) for r in found}


def _vectors(services: Any, query: str, source_ids: list[str], candidates: set[int]) -> dict[int, float]:
    """Cosine scores of the best chunks in scope (every stored vector is scored, in blocks) plus the lexical
    candidates. Empty when nothing is embedded or the stored vectors come from another model than the query's."""
    if not source_ids:
        return {}
    have = row(services, f"SELECT v.model AS model, COUNT(*) AS n FROM chunk_vecs v JOIN chunks c ON c.id=v.chunk_id"
                         f" WHERE c.source_id IN ({_marks(source_ids)}) GROUP BY v.model ORDER BY n DESC LIMIT 1",
               source_ids)
    if not have or not have["n"]:
        return {}
    try:
        model, vecs = llm.embed(services, [[query]], kind="query")
    except llm.NoModel:
        return {}
    if not vecs or not vecs[0] or not vecs[0][0]:
        return {}
    if model and have["model"] and model != have["model"]:
        return {}
    qv = vecs[0][0]
    sql = (f"SELECT v.chunk_id AS id, v.vec AS vec FROM chunk_vecs v JOIN chunks c ON c.id=v.chunk_id"
           f" WHERE c.source_id IN ({_marks(source_ids)}) AND v.model=? AND v.chunk_id>? ORDER BY v.chunk_id LIMIT ?")
    best: dict[int, float] = {}
    after = 0
    while True:
        block = rows(services, sql, [*source_ids, have["model"], after, VECTOR_BLOCK])
        if not block:
            break
        after = block[-1]["id"]
        usable = [r for r in block if len(r["vec"]) == 4 * len(qv)]
        if usable:
            matrix = [unpack_vec(r["vec"]) for r in usable]
            for i, score in vecmath.topk(matrix, qv, FTS_CANDIDATES):
                best[usable[i]["id"]] = score
            best = dict(sorted(best.items(), key=lambda kv: kv[1], reverse=True)[:FTS_CANDIDATES])
        if len(block) < VECTOR_BLOCK:
            break
    # the lexical candidates get a score too, even when they are not among the closest vectors
    missing = [cid for cid in candidates if cid not in best]
    for start in range(0, len(missing), 500):
        part = missing[start:start + 500]
        for r in rows(services, f"SELECT chunk_id AS id, vec FROM chunk_vecs WHERE model=? AND chunk_id IN ({_marks(part)})",
                      [have["model"], *part]):
            if len(r["vec"]) == 4 * len(qv):
                best[r["id"]] = vecmath.cosine(unpack_vec(r["vec"]), qv)
    return best


def _minmax(d: dict[int, float]) -> dict[int, float]:
    if not d:
        return {}
    lo, hi = min(d.values()), max(d.values())
    if hi - lo < 1e-12:
        return {k: 1.0 for k in d}
    return {k: (v - lo) / (hi - lo) for k, v in d.items()}


def snippet(text: str, n: int = SNIPPET_CHARS) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def load_passages(services: Any, chunk_ids: list[int]) -> list[dict[str, Any]]:
    """Passages for chunk ids, numbered 1..n in the given order."""
    if not chunk_ids:
        return []
    found = rows(services, f"SELECT c.id, c.source_id, c.page, c.heading, c.text, s.filename, s.title"
                           f" FROM chunks c JOIN sources s ON s.id=c.source_id WHERE c.id IN ({_marks(chunk_ids)})",
                 chunk_ids)
    by_id = {r["id"]: r for r in found}
    out = []
    for cid in chunk_ids:
        r = by_id.get(cid)
        if not r:
            continue
        out.append({
            "n": len(out) + 1, "chunkId": r["id"], "sourceId": r["source_id"], "filename": r["filename"],
            "title": r["title"], "page": r["page"], "heading": r["heading"], "text": r["text"],
            "snippet": snippet(r["text"]),
        })
    return out


def search(services: Any, subject_id: str, query: str, *, topic: Optional[str] = None,
           source_ids: Optional[list[str]] = None, k: int = DEFAULT_K) -> dict[str, Any]:
    """{passages, note, scope}: best chunks for a query within a subject scope."""
    scope = resolve_scope(services, subject_id, topic, source_ids)
    ids = scope["sourceIds"]
    lex = _fts(services, query, ids, FTS_CANDIDATES)
    vec = _vectors(services, query, ids, set(lex))
    if vec:
        a, b = _minmax(lex), _minmax(vec)
        blended = {cid: 0.5 * a.get(cid, 0.0) + 0.5 * b.get(cid, 0.0) for cid in set(a) | set(b)}
    else:
        blended = lex
    best = [cid for cid, _ in sorted(blended.items(), key=lambda kv: kv[1], reverse=True)[: max(1, k)]]
    passages = load_passages(services, best)
    for p in passages:
        p["score"] = round(blended.get(p["chunkId"], 0.0), 4)
    note = scope["note"]
    if not ids:
        note = "No hay fuentes indexadas para esta asignatura/tema todavía (usa rescan o sube archivos)."
    elif not passages:
        note = (note + " " if note else "") + "Ningún pasaje de las fuentes coincide con la consulta."
    return {"passages": passages, "note": note, "scope": scope, "reranked": bool(vec)}


def material(services: Any, subject_id: str, *, topic: Optional[str] = None,
             source_ids: Optional[list[str]] = None) -> dict[str, Any]:
    """Every chunk in scope, in document order (for studio generation)."""
    scope = resolve_scope(services, subject_id, topic, source_ids)
    ids = scope["sourceIds"]
    if not ids:
        return {"passages": [], "scope": scope}
    found = rows(services, f"SELECT c.id FROM chunks c JOIN sources s ON s.id=c.source_id"
                           f" WHERE c.source_id IN ({_marks(ids)}) ORDER BY s.filename, c.ord", ids)
    return {"passages": load_passages(services, [r["id"] for r in found]), "scope": scope}


# ---------------------------------------------------------------- citations

def format_passages(passages: list[dict[str, Any]], max_chars: Optional[int] = None) -> str:
    parts = []
    for p in passages:
        where = p["filename"] + (f", p. {p['page']}" if p.get("page") else "")
        if p.get("heading"):
            where += f", «{p['heading']}»"
        text = p["text"] if not max_chars else p["text"][:max_chars]
        parts.append(f"[{p['n']}] ({where})\n{text}")
    return "\n\n".join(parts)


_CITE_RE = re.compile(r"\[(\s*\d{1,3}(?:\s*(?:[,;]|-|–|y)\s*\d{1,3})*\s*)\](?!\()")


def _expand(body: str) -> list[int]:
    nums: list[int] = []
    for part in re.split(r"\s*(?:[,;]|y)\s*", body.strip()):
        m = re.match(r"^(\d+)\s*[-–]\s*(\d+)$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if 0 < b - a <= 10:
                nums.extend(range(a, b + 1))
            else:
                nums.extend([a, b])
        elif part.isdigit():
            nums.append(int(part))
    return nums


def apply_citations(text: str, passages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Normalize `[n]` markers, drop numbers not in `passages`, return (text, citations)."""
    valid = {p["n"]: p for p in passages}
    used: list[int] = []

    def sub(m: re.Match[str]) -> str:
        nums = [n for n in _expand(m.group(1)) if n in valid]
        for n in nums:
            if n not in used:
                used.append(n)
        return "".join(f"[{n}]" for n in dict.fromkeys(nums))

    cleaned = _CITE_RE.sub(sub, text or "")
    cleaned = re.sub(r"[ \t]+([.,;:])", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip(), [citation(valid[n]) for n in sorted(used)]


def citation(p: dict[str, Any]) -> dict[str, Any]:
    return {"n": p["n"], "sourceId": p["sourceId"], "filename": p["filename"], "title": p.get("title"),
            "page": p.get("page"), "snippet": p.get("snippet") or snippet(p.get("text") or "")}


def strip_markers(text: str) -> str:
    return re.sub(r"\s*" + _CITE_RE.pattern, "", text or "").strip()


def public_passage(p: dict[str, Any]) -> dict[str, Any]:
    out = citation(p)
    out["text"] = p.get("text")
    out["heading"] = p.get("heading")
    return out
