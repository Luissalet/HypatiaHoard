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
from pathlib import Path
from typing import Any, Iterable, Optional

from ..hashing import slugify
from ..hoard_link import atomic, fam_docs
from ..hoard_link.docs import chunking, readers_lite, textclean, vecmath
from ..hoard_link.docs.chunking import Unit
from . import llm
from .schema import row, rows

SUPPORTED = {".pdf": "pdf", ".md": "md", ".markdown": "md", ".txt": "txt", ".docx": "docx"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
CHUNK_CHARS = 900
CHUNK_OVERLAP = 150
MIN_TAIL = 200
EMBED_BATCH = 32
# Bumped whenever extraction or chunking changes (2: the shared readers, cleaner and chunker): a source indexed
# under an older version is re-extracted by the next rescan, so every chunk follows the same rules.
INDEX_VERSION = 2
SCAN_BLANK_RATIO = 0.5   # a PDF with at least this share of pages without a text layer is read with OCR
BLANK_PAGE_CHARS = 20
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


_NOBODY = frozenset({"hub_down", "app_down", "app_missing", "tool_missing"})


def _is_scan(pages: list[str]) -> bool:
    blank = sum(1 for p in pages if textclean.useful_chars(p) < BLANK_PAGE_CHARS)
    return bool(pages) and blank / len(pages) >= SCAN_BLANK_RATIO


def _ocr_pages(path: Path, pages: list[str]) -> list[str]:
    """A scanned PDF read by Kafka's OCR through the hub (text-layer pages are kept as they are). Without Kafka
    the pages stay as they were and the caller reports that the file has no text."""
    got = fam_docs.extract(str(path), ocr="auto", local_fallback=False)
    if not got.get("ok"):
        if str(got.get("kind") or "") in _NOBODY:
            return pages
        raise SourceError(f"PDF escaneado: no se pudo leer con OCR ({got.get('error') or 'sin respuesta'})")
    out = list(pages)
    for unit in got.get("units") or []:
        n = int(unit.get("number") or 0)
        if unit.get("kind") == "page" and 1 <= n <= len(out) and textclean.useful_chars(unit.get("text")) >= BLANK_PAGE_CHARS:
            out[n - 1] = str(unit["text"])
    return out


def _chunk_dicts(units: list[Unit]) -> list[dict[str, Any]]:
    # min_unit=0: a short section keeps its own heading (the citation shows it) instead of joining its neighbour.
    found = chunking.chunk_units(units, size=CHUNK_CHARS, overlap=CHUNK_OVERLAP, min_unit=0, min_tail=MIN_TAIL)
    return [{"page": c.page, "heading": c.section or None, "text": c.text} for c in found]


def extract_chunks(path: Path, kind: str) -> tuple[int, list[dict[str, Any]]]:
    """(pages, [{page, heading, text}]) for a file. The page is the citation unit of a PDF: chunks never cross it."""
    if kind == "pdf":
        pages = _pdf_pages(path)
        if _is_scan(pages):
            pages = _ocr_pages(path, pages)
        pages = textclean.strip_repeated_lines(pages)
        units = [Unit("page", i, "", textclean.clean_text(page)) for i, page in enumerate(pages, start=1)]
        return len(pages), _chunk_dicts(units)
    if kind == "docx":
        try:
            found = readers_lite.read_docx(path)
        except (ValueError, OSError) as exc:  # damaged file, zip bomb
            raise SourceError(f"DOCX no válido: {exc}") from exc
        return 0, _chunk_dicts([Unit("section", u["number"], (u.get("title") or "")[:200], u["text"]) for u in found])
    # md / txt: sections by markdown headings
    text = textclean.decode_text(path.read_bytes())
    units: list[Unit] = []
    heading: Optional[str] = None
    buf: list[str] = []

    def flush() -> None:
        body = textclean.clean_text("\n".join(buf))
        if body:
            units.append(Unit("section", len(units) + 1, heading or "", body))

    for line in text.splitlines():
        m = re.match(r"^\s{0,3}#{1,6}\s+(.*)$", line) if kind == "md" else None
        if m:
            flush()
            buf = []
            heading = m.group(1).strip()[:200]
        else:
            buf.append(line)
    flush()
    return 0, _chunk_dicts(units)


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


def _stale_index(src: dict[str, Any]) -> bool:
    """Indexed under older extraction/chunking rules (searchable meanwhile; the rescan rebuilds it)."""
    return src.get("status") == "indexed" and (src.get("index_version") or 1) != INDEX_VERSION


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
            if src["status"] == "pending" or _stale_index(src):
                pending.append(src["id"])
    for src in rows(services, "SELECT id, origin, path, status, index_version FROM sources WHERE subject_id=?", (sid,)):
        if src["origin"] in ("repo", "upload", "studio") and src["id"] not in seen and not Path(src["path"]).is_file():
            remove_source_rows(services, src["id"])
            counts["removed"] += 1
        elif src["origin"] == "path" and not Path(src["path"]).exists():
            with services.db.tx() as conn:
                conn.execute("UPDATE sources SET status='error', error=? WHERE id=?",
                             ("Archivo no encontrado", src["id"]))
        elif (src["status"] == "pending" or _stale_index(src)) and src["id"] not in pending:
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
    atomic.write_bytes_atomic(target, data)
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
    if src["status"] == "indexed" and not _stale_index(src):
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
        conn.execute("UPDATE sources SET status='indexed', error=NULL, pages=?, sha256=?, bytes=?, indexed_at=?,"
                     " index_version=? WHERE id=?",
                     (pages or None, digest, path.stat().st_size, services.now_iso(), INDEX_VERSION, source_id))
    if embed:
        embed_source(services, source_id)
    return row(services, "SELECT * FROM sources WHERE id=?", (source_id,)) or {}


_NO_EMBED_TTL_S = 300.0
_no_embed_until: "weakref.WeakKeyDictionary[Any, float]" = weakref.WeakKeyDictionary()


def embed_source(services: Any, source_id: str) -> int:
    """Add vectors for chunks without one, and replace the ones another embedding model made (vectors of two
    models cannot be compared, so a change of model re-embeds). Returns how many; 0 when no model (a miss is
    remembered for a few minutes so a big rescan does not probe the backends per file)."""
    import time

    if _no_embed_until.get(services, 0.0) > time.monotonic():
        return 0
    todo = rows(services, "SELECT c.id, c.text, c.heading FROM chunks c LEFT JOIN chunk_vecs v ON v.chunk_id=c.id"
                          " WHERE c.source_id=? AND v.chunk_id IS NULL ORDER BY c.ord", (source_id,))
    held = {r["model"] or "" for r in rows(
        services, "SELECT DISTINCT v.model AS model FROM chunk_vecs v JOIN chunks c ON c.id=v.chunk_id"
                  " WHERE c.source_id=?", (source_id,))}
    if held:
        current = llm.embedding_model(services)
        if current and held - {current}:
            todo += rows(services, "SELECT c.id, c.text, c.heading FROM chunks c JOIN chunk_vecs v ON v.chunk_id=c.id"
                                   " WHERE c.source_id=? AND COALESCE(v.model,'')<>? ORDER BY c.ord", (source_id, current))
    if not todo:
        return 0
    batches = [todo[i:i + EMBED_BATCH] for i in range(0, len(todo), EMBED_BATCH)]
    try:
        model, vectors = llm.embed(services, [[(c["heading"] + "\n" if c["heading"] else "") + c["text"]
                                              for c in b] for b in batches], kind="document")
    except llm.NoModel:
        _no_embed_until[services] = time.monotonic() + _NO_EMBED_TTL_S
        return 0
    _no_embed_until.pop(services, None)
    done = 0
    with services.db.tx() as conn:
        for batch, vecs in zip(batches, vectors):
            for c, v in zip(batch, vecs or []):
                if not v:
                    continue
                conn.execute("INSERT OR REPLACE INTO chunk_vecs(chunk_id, model, dim, vec) VALUES(?,?,?,?)",
                             (c["id"], model or "", len(v), vecmath.pack_vec(v)))
                done += 1
    return done


def sources_missing_vectors(services: Any, subject_id: str, current_model: Optional[str] = None) -> list[str]:
    """Indexed sources with chunks that have no vector, or (given the model that embeds now) whose vectors were
    made by another model."""
    found = {r["id"] for r in rows(
        services, "SELECT DISTINCT c.source_id AS id FROM chunks c JOIN sources s ON s.id=c.source_id"
                  " LEFT JOIN chunk_vecs v ON v.chunk_id=c.id WHERE s.subject_id=? AND s.status='indexed'"
                  " AND v.chunk_id IS NULL", (subject_id,))}
    if current_model:
        found |= {r["id"] for r in rows(
            services, "SELECT DISTINCT c.source_id AS id FROM chunks c JOIN sources s ON s.id=c.source_id"
                      " JOIN chunk_vecs v ON v.chunk_id=c.id WHERE s.subject_id=? AND s.status='indexed'"
                      " AND COALESCE(v.model,'')<>?", (subject_id, current_model))}
    return sorted(found)


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
