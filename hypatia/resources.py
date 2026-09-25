"""resources/<subject slug>/<Temas|Examenes|Resumenes|Practica>/ — the per-subject files the PWA
reads at /resources/ and the notebook indexes.

`index_for` builds the index.json the PWA expects when a folder has none (packages
installed with `import-package` bring the files only). `save_file` is the Hoard
counterpart of Exam Coach's dev-only `POST /api/upload-pdf`: a PDF attached to a topic
in the app lands here, so every device that opens the server can view it."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .hashing import slugify

CATEGORIES = ("Temas", "Examenes", "Resumenes", "Practica")
MAX_BYTES = 200 * 1024 * 1024


def natural_key(name: str) -> list:
    """"Tema2.pdf" before "Tema10.pdf", case-insensitive."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


def _visible(path: Path) -> bool:
    return path.is_file() and not path.name.startswith(".") and path.name != "index.json"


def _topic_pdfs(folder: Path) -> list[str]:
    return sorted((p.name for p in folder.iterdir() if _visible(p) and p.suffix.lower() == ".pdf"), key=natural_key)


def index_for(base: Path, target: Path) -> list | dict | None:
    """The listing for a missing resources/<slug>/<category>/index.json, or None.
    Temas: ["Tema1.pdf", ...]; the others: {files, subcategories} like resourceFromDB.ts."""
    folder = target.parent
    if target.name != "index.json" or folder.name not in CATEGORIES or folder.parent.parent != base:
        return None
    if not folder.is_dir():
        return None
    if folder.name == "Temas":
        return _topic_pdfs(folder)

    def entry(path: Path) -> dict[str, str]:
        return {"name": path.name, "path": path.relative_to(folder).as_posix(), "type": path.suffix.lower().lstrip(".")}

    children = sorted(folder.iterdir(), key=lambda p: natural_key(p.name))
    out: dict[str, Any] = {"files": [entry(p) for p in children if _visible(p)]}
    subcategories = [
        {"name": sub.name, "files": [entry(p) for p in sorted(sub.rglob("*"), key=lambda p: natural_key(p.name)) if _visible(p)]}
        for sub in children if sub.is_dir() and not sub.name.startswith(".")
    ]
    if subcategories:
        out["subcategories"] = subcategories
    return out


def safe_filename(filename: str) -> str:
    name = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or name in (".", "..") or name.startswith(".") or name == "index.json" or any(ord(c) < 32 for c in name):
        raise ValueError("Nombre de archivo no válido")
    return name


def _write_atomic(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".upload-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o644)  # mkstemp makes it owner-only; these are plain files served to the app
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _list_in_index(folder: Path, pdf: str) -> None:
    """A hand-written Temas/index.json (from a package) must list the new PDF too. No topic
    title: the topic already points at it (Topic.pdfFilename syncs), and a title here would make
    the app re-attach the PDF to that topic after the user removes it."""
    idx = folder / "index.json"
    if not idx.is_file():
        return  # the listing is built from the folder
    try:
        raw = json.loads(idx.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return
    if not isinstance(raw, list):
        return
    if any(item == pdf or (isinstance(item, dict) and item.get("pdf") == pdf) for item in raw):
        return
    raw.append(pdf if raw and all(isinstance(item, str) for item in raw) else {"topicTitle": "", "pdf": pdf})
    _write_atomic(idx, json.dumps(raw, ensure_ascii=False, indent=2).encode("utf-8"))


def save_file(resources_dir: Path, subject_name: str, category: str, filename: str, data: bytes) -> dict[str, Any]:
    """Write resources/<slug(subject)>/<category>/<filename> (Temas: also listed in its index.json)."""
    slug = slugify(subject_name)
    if not slug:
        raise ValueError("Asignatura no válida")
    if category not in CATEGORIES:
        raise ValueError(f"Categoría no válida: {category}")
    name = safe_filename(filename)
    if len(data) > MAX_BYTES:
        raise ValueError("El archivo supera 200 MB")
    base = Path(resources_dir).resolve()
    folder = base / slug / category
    folder.mkdir(parents=True, exist_ok=True)
    target = (folder / name).resolve()
    if target.parent != folder.resolve():
        raise ValueError("Nombre de archivo no válido")
    _write_atomic(target, data)
    if category == "Temas":
        _list_in_index(folder, name)
    return {"slug": slug, "path": f"resources/{slug}/{category}/{name}", "bytes": len(data)}
