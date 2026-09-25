"""Notebook sources: discovery, registration, text extraction, chunking and indexing.

Origins:
- ``repo``: ``resources/<subject-slug>/**`` (read in place; deleting only un-indexes and
  remembers the path as excluded).
- ``upload``: files PUT by the PWA, stored at ``data/sources/<subject-id>/<filename>``.
- ``path``: a local file/folder given to the ``source_add`` tool (read in place).
- ``studio``: a generated studio item saved as markdown under ``data/sources``.

The page is the citation unit: chunks (~900 chars, ~150 overlap) never cross pages.
"""

from __future__ import annotations

import hashlib
import json
import re
import weakref
import zipfile
from pathlib import Path
from typing import Any, Iterable, Optional
from xml.etree import ElementTree

from ..hashing import slugify
from . import llm
from .schema import row, rows

SUPPORTED = {".pdf": "pdf", ".md": "md", ".markdown": "md", ".txt": "txt", ".docx": "docx"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
CHUNK_CHARS = 900
CHUNK_OVERLAP = 150
MIN_TAIL = 200
EMBED_BATCH = 32
_SAFE_NAME = re.compile(r"[^\w\-. ()\[\]áéíóúÁÉÍÓÚñÑüÜ]+", re.UNICODE)


class SourceError(ValueError):
    """User-facing problem with a source (bad type, too big, missing file)."""


# ---------------------------------------------------------------- extraction

def file_kind(path: Path | str) -> Optional[str]:
    return SUPPORTED.get(Path(path).suffix.lower())


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _read_text_file(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")  # pragma: no cover


def _pdf_pages(path: Path) -> list[str]:
    from pypdf import PdfReader  # server dependency

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:  # noqa: BLE001
            raise SourceError(f"PDF cifrado: {exc}") from exc
    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 - one broken page must not sink the file
            pages.append("")
    return pages


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_blocks(path: Path) -> list[tuple[Optional[str], str]]:
    """(heading-or-None, paragraph text) for each paragraph of a .docx."""
    try:
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise SourceError(f"DOCX no válido: {exc}") from exc
    root = ElementTree.fromstring(xml)
    out: list[tuple[Optional[str], str]] = []
    for p in root.iter(f"{_W}p"):
        style = p.find(f"{_W}pPr/{_W}pStyle")
        style_val = (style.get(f"{_W}val") or "") if style is not None else ""
        parts: list[str] = []
        for node in p.iter():
            if node.tag == f"{_W}t":
                parts.append(node.text or "")
            elif node.tag == f"{_W}tab":
                parts.append("\t")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        text = "".join(parts).strip()
        if not text:
            continue
        is_heading = bool(re.match(r"(?i)(heading|t[ií]tulo|title)", style_val))
        out.append(("h" if is_heading else None, text))
    return out


def _clean(text: str) -> str:
    text = text.replace("­", "").replace("\x00", "")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # hyphenation across lines
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return _unstack_words(text.strip())


def _unstack_words(text: str) -> str:
    """Some PDF exporters put every word on its own line ("menor\n\nuso\n\ndirecto"):
    join them back into running text, or each chunk wastes most of its tokens on breaks."""
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if len(lines) < 20:
        return text
    single = sum(1 for ln in lines if " " not in ln.strip())
    lengths = sorted(len(ln) for ln in lines)
    if single / len(lines) > 0.6 and lengths[len(lengths) // 2] <= 14:
        return re.sub(r"\s*\n+\s*", " ", text).strip()
    return text


def _line_key(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())


def strip_repeated_lines(pages: list[str]) -> list[str]:
    """Drop header/footer lines: lines identical (digits ignored) on >50 % of pages."""
    if len(pages) < 3:
        return pages
    counts: dict[str, int] = {}
    for page in pages:
        for key in {_line_key(l) for l in page.splitlines() if l.strip() and len(l.strip()) <= 160}:
            counts[key] = counts.get(key, 0) + 1
    repeated = {k for k, c in counts.items() if c > len(pages) / 2}
    if not repeated:
        return pages
    return ["\n".join(l for l in page.splitlines() if _line_key(l) not in repeated) for page in pages]


def split_text(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split into ~size-char windows with ~overlap, cutting at sentence/word boundaries."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    spans: list[tuple[int, int]] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            window = text[start:end]
            for pat in ("\n\n", ". ", ".\n", "? ", "! ", "; ", "\n", " "):
                pos = window.rfind(pat, int(size * 0.6))
                if pos >= 0:
                    end = start + (pos + 1 if pat.strip() else pos)
                    break
        if text[start:end].strip():
            spans.append((start, end))
        if end >= n:
            break
        nxt = max(end - overlap, start + 1)
        sp = text.find(" ", nxt)
        start = sp + 1 if 0 <= sp < end else nxt
    if len(spans) >= 2 and spans[-1][1] - spans[-1][0] < MIN_TAIL:
        last = spans.pop()
        spans[-1] = (spans[-1][0], last[1])
    return [text[a:b].strip() for a, b in spans]


def extract_chunks(path: Path, kind: str) -> tuple[int, list[dict[str, Any]]]:
    """(pages, [{page, heading, text}]) for a file."""
    chunks: list[dict[str, Any]] = []
    if kind == "pdf":
        pages = strip_repeated_lines(_pdf_pages(path))
        for i, page in enumerate(pages, start=1):
            for piece in split_text(_clean(page)):
                chunks.append({"page": i, "heading": None, "text": piece})
        return len(pages), chunks
    if kind == "docx":
        sections: list[tuple[Optional[str], list[str]]] = [(None, [])]
        for flag, text in _docx_blocks(path):
            if flag == "h":
                sections.append((text[:200], []))
            else:
                sections[-1][1].append(text)
        for heading, paras in sections:
            for piece in split_text(_clean("\n".join(paras))):
                chunks.append({"page": None, "heading": heading, "text": piece})
        return 0, chunks
    # md / txt: sections by markdown headings
    text = _read_text_file(path)
    heading: Optional[str] = None
    buf: list[str] = []

    def flush() -> None:
        for piece in split_text(_clean("\n".join(buf))):
            chunks.append({"page": None, "heading": heading, "text": piece})

    for line in text.splitlines():
        m = re.match(r"^\s{0,3}#{1,6}\s+(.*)$", line) if kind == "md" else None
        if m:
            flush()
            buf = []
            heading = m.group(1).strip()[:200]
        else:
            buf.append(line)
    flush()
    return 0, chunks


# ---------------------------------------------------------------- discovery

def subject_dirs(services: Any, subject: dict[str, Any]) -> list[Path]:
    """Resource folders of a subject: slug(name) and installed package ids."""
    base = Path(services.config.resources_dir)
    if not base.is_dir():
        return []
    slugs = {slugify(subject.get("name") or "")}
    try:
        for pkg in services.store.list("installedPackage") or []:
            if pkg.get("subjectId") == subject.get("id") and pkg.get("id"):
                slugs.add(slugify(str(pkg["id"])))
    except Exception:  # noqa: BLE001 - store without that kind
        pass
    slugs.discard("")
    out = []
    for child in sorted(base.iterdir()):
        if child.is_dir() and slugify(child.name) in slugs:
            out.append(child)
    return out


def _index_titles(folder: Path) -> dict[str, str]:
    """pdf filename -> topic title from resources' index.json files, if any."""
    idx = folder / "index.json"
    if not idx.is_file():
        return {}
    try:
        data = json.loads(idx.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    out: dict[str, str] = {}
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("pdf") and item.get("topicTitle"):
                out[str(item["pdf"])] = str(item["topicTitle"])
    return out


def iter_files(root: Path) -> Iterable[Path]:
    if root.is_file():
        if file_kind(root):
            yield root
        return
    for p in sorted(root.rglob("*")):
        if p.is_file() and file_kind(p) and not any(part.startswith(".") for part in p.relative_to(root).parts):
            yield p


def source_id_for(subject_id: str, path: Path) -> str:
    raw = f"{subject_id}\0{Path(path).resolve()}"
    return "src_" + hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:16]


def _excluded(services: Any, subject_id: str) -> set[str]:
    return {r["path"] for r in rows(services, "SELECT path FROM source_exclusions WHERE subject_id=?", (subject_id,))}


def _drop_index(conn: Any, source_id: str) -> None:
    ids = [r[0] for r in conn.execute("SELECT id FROM chunks WHERE source_id=?", (source_id,)).fetchall()]
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        marks = ",".join("?" * len(part))
        conn.execute(f"DELETE FROM chunks_fts WHERE rowid IN ({marks})", part)
        conn.execute(f"DELETE FROM chunk_vecs WHERE chunk_id IN ({marks})", part)
    conn.execute("DELETE FROM chunks WHERE source_id=?", (source_id,))


def register_file(services: Any, subject_id: str, path: Path, origin: str,
                  title: Optional[str] = None) -> tuple[dict[str, Any], str]:
    """Upsert a source row for a file. Returns (source, change) where change is
    'new' | 'changed' | 'unchanged' | 'duplicate'. New/changed sources are 'pending'."""
    path = Path(path).resolve()
    kind = file_kind(path)
    if not kind:
        raise SourceError(f"Tipo de archivo no soportado: {path.name} (PDF, MD, TXT o DOCX)")
    if not path.is_file():
        raise SourceError(f"No existe el archivo: {path}")
    digest = sha256_file(path)
    sid = source_id_for(subject_id, path)
    existing = row(services, "SELECT * FROM sources WHERE id=?", (sid,))
    if existing and existing["sha256"] == digest and existing["status"] != "error":
        return existing, "unchanged"
    dup = row(services, "SELECT * FROM sources WHERE subject_id=? AND sha256=? AND id<>?", (subject_id, digest, sid))
    if dup and not existing:
        return dup, "duplicate"
    now = services.now_iso()
    with services.db.tx() as conn:
        if existing:
            _drop_index(conn, sid)
            conn.execute(
                "UPDATE sources SET sha256=?, bytes=?, status='pending', error=NULL, indexed_at=NULL, pages=NULL,"
                " origin=?, title=COALESCE(?, title) WHERE id=?",
                (digest, path.stat().st_size, origin, title, sid),
            )
        else:
            conn.execute(
                "INSERT INTO sources(id, subject_id, origin, path, filename, title, kind, pages, bytes, sha256,"
                " status, error, added_at, indexed_at) VALUES(?,?,?,?,?,?,?,NULL,?,?,'pending',NULL,?,NULL)",
                (sid, subject_id, origin, str(path), path.name, title or path.stem, kind,
                 path.stat().st_size, digest, now),
            )
    src = row(services, "SELECT * FROM sources WHERE id=?", (sid,))
    assert src is not None
    return src, ("changed" if existing else "new")


def scan_subject(services: Any, subject: dict[str, Any]) -> dict[str, Any]:
    """Discover repo files for one subject, register them and forget vanished ones."""
    sid = subject["id"]
    excluded = _excluded(services, sid)
    seen: set[str] = set()
    counts = {"found": 0, "new": 0, "changed": 0, "unchanged": 0, "duplicate": 0, "removed": 0, "errors": 0}
    pending: list[str] = []
    for folder in subject_dirs(services, subject):
        titles: dict[Path, dict[str, str]] = {}
        for path in iter_files(folder):
            rp = str(path.resolve())
            if rp in excluded:
                continue
            counts["found"] += 1
            if path.parent not in titles:
                titles[path.parent] = _index_titles(path.parent)
            try:
                src, change = register_file(services, sid, path, "repo", titles[path.parent].get(path.name))
            except (SourceError, OSError):
                counts["errors"] += 1
                continue
            counts[change] += 1
            seen.add(src["id"])
            if src["status"] == "pending":
                pending.append(src["id"])
    for src in rows(services, "SELECT id, origin, path, status FROM sources WHERE subject_id=?", (sid,)):
        if src["origin"] in ("repo", "upload", "studio") and src["id"] not in seen and not Path(src["path"]).is_file():
            remove_source_rows(services, src["id"])
            counts["removed"] += 1
        elif src["origin"] == "path" and not Path(src["path"]).exists():
            with services.db.tx() as conn:
                conn.execute("UPDATE sources SET status='error', error=? WHERE id=?",
                             ("Archivo no encontrado", src["id"]))
        elif src["status"] == "pending" and src["id"] not in pending:
            pending.append(src["id"])
    counts["pending"] = pending
    return counts


def remove_source_rows(services: Any, source_id: str) -> None:
    with services.db.tx() as conn:
        _drop_index(conn, source_id)
        conn.execute("DELETE FROM sources WHERE id=?", (source_id,))


def delete_source(services: Any, source_id: str) -> bool:
    src = row(services, "SELECT * FROM sources WHERE id=?", (source_id,))
    if not src:
        return False
    if src["origin"] in ("upload", "studio"):
        p = Path(src["path"])
        data_root = (Path(services.config.data_dir) / "sources").resolve()
        try:
            if p.resolve().is_relative_to(data_root) and p.is_file():
                p.unlink()
        except OSError:
            pass
    else:
        with services.db.tx() as conn:
            conn.execute("INSERT OR REPLACE INTO source_exclusions(subject_id, path, excluded_at) VALUES(?,?,?)",
                         (src["subject_id"], src["path"], services.now_iso()))
    remove_source_rows(services, source_id)
    return True


def safe_filename(name: str) -> str:
    base = Path(str(name).replace("\\", "/")).name.strip()
    base = _SAFE_NAME.sub("_", base).strip(" .")
    if not base:
        raise SourceError("Nombre de archivo vacío")
    return base[:180]


def uploads_dir(services: Any, subject_id: str) -> Path:
    d = Path(services.config.data_dir) / "sources" / safe_filename(subject_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_upload(services: Any, subject_id: str, filename: str, data: bytes) -> tuple[dict[str, Any], str]:
    name = safe_filename(filename)
    if not file_kind(name):
        raise SourceError(f"Tipo de archivo no soportado: {name} (PDF, MD, TXT o DOCX)")
    if len(data) > MAX_UPLOAD_BYTES:
        raise SourceError("El archivo supera 50 MB")
    if not data:
        raise SourceError("El archivo está vacío")
    target = uploads_dir(services, subject_id) / name
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    return register_file(services, subject_id, target, "upload")


def add_paths(services: Any, subject_id: str, path: str) -> dict[str, Any]:
    """Register a local file or folder (read in place) as 'path' sources."""
    root = Path(path).expanduser()
    if not root.exists():
        raise SourceError(f"No existe la ruta: {path}")
    added, errors = [], []
    for p in iter_files(root):
        try:
            src, change = register_file(services, subject_id, p, "path")
            added.append({"id": src["id"], "filename": src["filename"], "status": src["status"], "change": change})
        except (SourceError, OSError) as exc:
            errors.append({"path": str(p), "error": str(exc)})
    if not added and not errors:
        raise SourceError(f"No hay archivos PDF/MD/TXT/DOCX en {path}")
    return {"sources": added, "errors": errors}


# ---------------------------------------------------------------- indexing

def index_source(services: Any, source_id: str, *, embed: bool = True) -> dict[str, Any]:
    """Extract, chunk and index one source (idempotent: an indexed source with the
    same sha256 is left alone). Embeddings are added when a model resolves."""
    src = row(services, "SELECT * FROM sources WHERE id=?", (source_id,))
    if not src:
        return {"id": source_id, "status": "missing"}
    path = Path(src["path"])
    if src["status"] == "indexed":
        try:
            if path.is_file() and sha256_file(path) == src["sha256"]:
                return src
        except OSError:
            pass
    try:
        if not path.is_file():
            raise SourceError("Archivo no encontrado")
        digest = sha256_file(path)
        pages, chunks = extract_chunks(path, src["kind"] or file_kind(path) or "txt")
        if not chunks:
            raise SourceError("No se pudo extraer texto (¿PDF escaneado sin OCR?)")
    except Exception as exc:  # noqa: BLE001 - recorded on the source row
        with services.db.tx() as conn:
            conn.execute("UPDATE sources SET status='error', error=? WHERE id=?", (str(exc)[:500], source_id))
        return row(services, "SELECT * FROM sources WHERE id=?", (source_id,)) or {}
    with services.db.tx() as conn:
        _drop_index(conn, source_id)
        for ord_, ch in enumerate(chunks):
            cur = conn.execute("INSERT INTO chunks(source_id, ord, page, heading, text) VALUES(?,?,?,?,?)",
                               (source_id, ord_, ch["page"], ch["heading"], ch["text"]))
            conn.execute("INSERT INTO chunks_fts(rowid, text, heading) VALUES(?,?,?)",
                         (cur.lastrowid, ch["text"], ch["heading"] or ""))
        conn.execute("UPDATE sources SET status='indexed', error=NULL, pages=?, sha256=?, bytes=?, indexed_at=?"
                     " WHERE id=?", (pages or None, digest, path.stat().st_size, services.now_iso(), source_id))
    if embed:
        embed_source(services, source_id)
    return row(services, "SELECT * FROM sources WHERE id=?", (source_id,)) or {}


_NO_EMBED_TTL_S = 300.0
_no_embed_until: "weakref.WeakKeyDictionary[Any, float]" = weakref.WeakKeyDictionary()


def embed_source(services: Any, source_id: str) -> int:
    """Add vectors for chunks without one. Returns how many; 0 when no model (a miss is
    remembered for a few minutes so a big rescan does not probe the backends per file)."""
    import time

    if _no_embed_until.get(services, 0.0) > time.monotonic():
        return 0
    todo = rows(services, "SELECT c.id, c.text, c.heading FROM chunks c LEFT JOIN chunk_vecs v ON v.chunk_id=c.id"
                          " WHERE c.source_id=? AND v.chunk_id IS NULL ORDER BY c.ord", (source_id,))
    if not todo:
        return 0
    batches = [todo[i:i + EMBED_BATCH] for i in range(0, len(todo), EMBED_BATCH)]
    try:
        model, vectors = llm.embed(services, [[(c["heading"] + "\n" if c["heading"] else "") + c["text"]
                                              for c in b] for b in batches])
    except llm.NoModel:
        _no_embed_until[services] = time.monotonic() + _NO_EMBED_TTL_S
        return 0
    _no_embed_until.pop(services, None)
    from .retrieval import pack_vec

    done = 0
    with services.db.tx() as conn:
        for batch, vecs in zip(batches, vectors):
            for c, v in zip(batch, vecs or []):
                if not v:
                    continue
                conn.execute("INSERT OR REPLACE INTO chunk_vecs(chunk_id, model, dim, vec) VALUES(?,?,?,?)",
                             (c["id"], model or "", len(v), pack_vec(v)))
                done += 1
    return done


def sources_missing_vectors(services: Any, subject_id: str) -> list[str]:
    return [r["id"] for r in rows(
        services, "SELECT DISTINCT c.source_id AS id FROM chunks c JOIN sources s ON s.id=c.source_id"
                  " LEFT JOIN chunk_vecs v ON v.chunk_id=c.id WHERE s.subject_id=? AND s.status='indexed'"
                  " AND v.chunk_id IS NULL", (subject_id,))]


def list_sources(services: Any, subject_id: str) -> list[dict[str, Any]]:
    out = rows(services, "SELECT s.*, (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks,"
                         " (SELECT COUNT(*) FROM chunks c JOIN chunk_vecs v ON v.chunk_id=c.id"
                         "  WHERE c.source_id=s.id) AS vectors"
                         " FROM sources s WHERE s.subject_id=? ORDER BY s.origin, s.path", (subject_id,))
    return [public_source(s) for s in out]


def public_source(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s["id"], "subjectId": s["subject_id"], "origin": s["origin"], "filename": s["filename"],
        "title": s.get("title"), "kind": s.get("kind"), "pages": s.get("pages"), "bytes": s.get("bytes"),
        "status": s["status"], "error": s.get("error"), "chunks": s.get("chunks"), "vectors": s.get("vectors"),
        "addedAt": s.get("added_at"), "indexedAt": s.get("indexed_at"),
        "path": s["path"] if s["origin"] in ("path", "repo") else None,
    }
