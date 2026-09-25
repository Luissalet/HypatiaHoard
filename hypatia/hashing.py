"""Exact ports of src/domain/normalize.ts, src/domain/hashing.ts and
computeConceptHash (src/data/repos.ts). Hashes must match the PWA byte for byte:
they drive deduplication in sync."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any

# JavaScript's WhiteSpace + LineTerminator set (what `\s` and trim() use).
_JS_WS = "\t\n\u000b\u000c\r    -     　﻿"
_JS_WS_RUN = re.compile(f"[{_JS_WS}]+")
_JS_TRIM = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")
_COMBINING = re.compile("[̀-ͯ]")
_SLUG_DROP = re.compile(f"[^a-z0-9{_JS_WS}-]")
_DASHES = re.compile("-+")


def js_trim(text: str) -> str:
    return _JS_TRIM.sub("", text)


def normalize_text(text: str, remove_diacritics: bool = True) -> str:
    s = _JS_WS_RUN.sub(" ", js_trim(text).lower())
    if remove_diacritics:
        s = _COMBINING.sub("", unicodedata.normalize("NFD", s))
    return s


def slugify(text: str) -> str:
    s = _COMBINING.sub("", unicodedata.normalize("NFD", text)).lower()
    s = js_trim(_SLUG_DROP.sub("", s))
    return _DASHES.sub("-", _JS_WS_RUN.sub("-", s))


def js_sort_key(text: str) -> bytes:
    """Array.prototype.sort() default order: by UTF-16 code units."""
    return text.encode("utf-16-be")


def js_sorted(items: list[str]) -> list[str]:
    return sorted(items, key=js_sort_key)


def _sha(raw: str) -> str:
    # JS TextEncoder replaces lone surrogates with U+FFFD; mirror that.
    return "sha256:" + hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()


def compute_content_hash(q: dict[str, Any]) -> str:
    qtype = q.get("type")
    parts = ["" if qtype is None else str(qtype), normalize_text(q.get("prompt") or "")]
    if qtype == "TEST":
        options = q.get("options") or []
        parts.append("|".join(js_sorted([normalize_text(o.get("text") or "", True) for o in options])))
        correct = set(q.get("correctOptionIds") or [])
        parts.append("|".join(js_sorted([normalize_text(o.get("text") or "", True) for o in options if o.get("id") in correct])))
    elif qtype in ("DESARROLLO", "PRACTICO"):
        parts.append(normalize_text(q.get("modelAnswer") or ""))
    elif qtype == "COMPLETAR":
        parts.append(normalize_text(q.get("clozeText") or ""))
        blanks = q.get("blanks") or []
        parts.append("|".join(",".join(js_sorted([normalize_text(a, True) for a in (b.get("accepted") or [])])) for b in blanks))
    return _sha("::".join(parts))


def compute_concept_hash(category: str, title: str, content: str) -> str:
    return _sha("::".join([category, normalize_text(title), normalize_text(content)]))
