"""Tolerant reading of TEST options and their correct answers, whatever shape a model
(or an assistant) writes them in, and the strict check a generated TEST draft must
pass before anyone sees it.

Shapes accepted for `options`:
- `[{"id": "a", "text": "..."}]` (the app's own shape; ids kept as given)
- `{"a": "...", "b": "..."}` (a map from label to text; iterating it gave only the labels)
- `["a) ...", "B. ...", "(c) ..."]` or plain `["...", "..."]`
- `[{"a": "..."}, {"b": "..."}]`, `[{"letter": "a", "option": "..."}]`, `[{"label": "A", "value": "..."}]`
- one string with a line per option (`"a) ...\\nb) ..."`)
and for the correct answer: ids, letters (any case), 1-based numbers, the option's
text, `"a, c"`, or per-option flags (`correct`, `isCorrect`, `correcta`).
"""

from __future__ import annotations

import re
from typing import Any

from .hashing import normalize_text

LETTERS = "abcdefghijklmnopqrstuvwxyz"
_LABELED = re.compile(r"^\s*\(?\s*([A-Za-z])\s*[).:\-–]\s*(.*\S)?\s*$", re.S)
_ID_KEYS = ("id", "letter", "letra", "label", "etiqueta", "key", "clave", "opcion_id", "optionId")
_TEXT_KEYS = ("text", "texto", "option", "opcion", "opción", "value", "valor", "content", "contenido", "answer",
              "respuesta", "description", "descripcion")
_FLAG_KEYS = ("correct", "isCorrect", "is_correct", "correcta", "esCorrecta", "es_correcta")
_CORRECT_KEYS = ("correctOptionIds", "correctOptionId", "correct_option_ids", "correct_option", "correctOptions",
                 "correct", "correcta", "correctas", "respuestaCorrecta", "respuesta_correcta", "answer", "respuesta",
                 "solution", "solucion")
_GENERIC = re.compile(r"^(?:opci[oó]n|option|respuesta|answer)?\s*\(?[a-z0-9]\)?\.?$")


def _labeled(text: str) -> tuple[str, str] | None:
    m = _LABELED.match(text or "")
    return (m.group(1).lower(), (m.group(2) or "").strip()) if m else None


def _strip_sequential_labels(items: list[dict]) -> list[dict]:
    """Drop "a) " prefixes when every option carries the next letter (a, b, c…)."""
    parsed = [_labeled(o["text"]) for o in items]
    if items and all(p and p[0] == LETTERS[i] for i, p in enumerate(parsed)):
        return [{**o, "text": p[1], "_label": p[0]} for o, p in zip(items, parsed)]
    return items


def _from_mapping(item: dict) -> tuple[Any, Any, bool]:
    """(id, text, flagged_correct) from one option written as an object."""
    flag = any(item.get(k) is True or str(item.get(k)).lower() in ("true", "sí", "si", "yes") for k in _FLAG_KEYS
               if k in item)
    oid = next((item[k] for k in _ID_KEYS if item.get(k) not in (None, "") and k != "label"), None)
    text = next((item[k] for k in _TEXT_KEYS if isinstance(item.get(k), (str, int, float)) and str(item[k]).strip()), None)
    if text is None and isinstance(item.get("label"), str) and oid is not None:
        text = item["label"]  # {"id": "a", "label": "texto"}
    elif oid is None and item.get("label") not in (None, ""):
        oid = item["label"]
    if text is None and oid is None:
        rest = {k: v for k, v in item.items() if k not in _FLAG_KEYS}
        if len(rest) == 1:  # {"a": "texto"}
            oid, text = next(iter(rest.items()))
    return oid, text, flag


def normalize_options(raw: Any) -> tuple[list[dict[str, str]], dict[str, str], list[str]]:
    """-> (options [{id, text}], map of raw ids/labels -> final id, ids flagged correct)."""
    entries: list[dict] = []
    if isinstance(raw, str):
        lines = [l for l in raw.replace("\r", "").split("\n") if l.strip()]
        raw = lines if len(lines) > 1 else [p for p in re.split(r"\s*[;|]\s*", raw) if p.strip()]
    if isinstance(raw, dict):
        if isinstance(raw.get("options"), (list, dict)):
            return normalize_options(raw["options"])
        for key, value in raw.items():
            flag = False
            if isinstance(value, dict):
                _, text, flag = _from_mapping(value)
            else:
                text = value
            entries.append({"rawId": str(key), "text": "" if text is None else str(text), "flag": flag})
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                oid, text, flag = _from_mapping(item)
                entries.append({"rawId": None if oid is None else str(oid), "text": "" if text is None else str(text),
                                "flag": flag})
            elif item is not None:
                entries.append({"rawId": None, "text": str(item), "flag": False})
    for e in entries:
        e["text"] = re.sub(r"\s+", " ", e["text"]).strip()
    entries = _strip_sequential_labels(entries)
    out: list[dict[str, str]] = []
    given = [e.get("rawId") for e in entries]
    keep_ids = bool(given) and all(given) and len(set(given)) == len(given)
    for i, e in enumerate(entries):
        out.append({"id": e["rawId"] if keep_ids else LETTERS[i] if i < len(LETTERS) else f"o{i + 1}", "text": e["text"]})
    # Aliases by priority: the ids as written, then printed labels, then position (letter, 1-based number).
    id_map: dict[str, str] = {}
    passes = (lambda i, e: e.get("rawId"), lambda i, e: e.get("_label"),
              lambda i, e: LETTERS[i] if i < len(LETTERS) else None, lambda i, e: str(i + 1))
    for alias_of in passes:
        for i, e in enumerate(entries):
            alias = alias_of(i, e)
            if alias:
                id_map.setdefault(str(alias), out[i]["id"])
                id_map.setdefault(str(alias).lower(), out[i]["id"])
    flagged = [out[i]["id"] for i, e in enumerate(entries) if e["flag"]]
    return out, id_map, flagged


def normalize_correct(raw: Any, options: list[dict[str, str]], id_map: dict[str, str], flagged: list[str]) -> list[str]:
    """Correct ids from ids, letters, numbers, texts or flags; [] when nothing matches."""
    ids = [o["id"] for o in options]
    texts = {normalize_text(o["text"]): o["id"] for o in options if o["text"]}
    values: list[Any]
    if raw is None or raw == "" or raw == []:
        values = []
    elif isinstance(raw, list):
        values = raw
    elif isinstance(raw, str) and normalize_text(raw) not in texts:
        values = [p for p in re.split(r"\s*(?:[,;/+|]|\s+y\s+|\s+and\s+)\s*", raw.strip()) if p]
    else:
        values = [raw]
    zero_based = any(isinstance(v, int) and not isinstance(v, bool) and v == 0 for v in values)
    out: list[str] = []
    for v in values:
        found = None
        if isinstance(v, bool):
            continue
        if isinstance(v, int) or (isinstance(v, str) and v.strip().isdigit()):
            n = int(v)
            index = n if zero_based else n - 1
            found = ids[index] if 0 <= index < len(ids) else None
        else:
            s = str(v).strip()
            found = s if s in ids else id_map.get(s) or id_map.get(s.lower())
            if found is None:
                lab = _labeled(s)
                if lab and lab[0] in id_map and (not lab[1] or normalize_text(lab[1]) == normalize_text(
                        next((o["text"] for o in options if o["id"] == id_map[lab[0]]), ""))):
                    found = id_map[lab[0]]
            if found is None:
                found = texts.get(normalize_text(s))
        if found and found not in out:
            out.append(found)
    for f in flagged:
        if f not in out:
            out.append(f)
    return out


def correct_from_item(item: dict, options: list[dict[str, str]], id_map: dict[str, str], flagged: list[str]) -> list[str]:
    for key in _CORRECT_KEYS:
        if item.get(key) not in (None, "", []):
            found = normalize_correct(item[key], options, id_map, [])
            if found:
                return found + [f for f in flagged if f not in found]
    return list(flagged)


def options_from_prompt(prompt: str) -> tuple[str, list[dict[str, str]]] | None:
    """Options written inside the stem ("a) …" lines): (stem without them, options) or None."""
    lines = (prompt or "").replace("\r", "").split("\n")
    found, idx = [], []
    for i, line in enumerate(lines):
        lab = _labeled(line)
        if lab and lab[1] and len(found) < len(LETTERS) and lab[0] == LETTERS[len(found)]:
            found.append({"id": lab[0], "text": lab[1]})
            idx.append(i)
    if len(found) < 2:
        return None
    stem = "\n".join(l for i, l in enumerate(lines) if i not in idx).strip()
    return stem, found


def invalid_test_reason(q: dict, min_options: int = 3) -> str | None:
    """Why a TEST draft cannot be shown (None when it is fine)."""
    options = q.get("options") or []
    if len(options) < min_options:
        return f"menos de {min_options} opciones"
    seen = set()
    for o in options:
        text = (o.get("text") or "").strip()
        label = str(o.get("id") or "").strip()
        norm = normalize_text(text)
        if not text:
            return "opción vacía"
        if norm == normalize_text(label) or _GENERIC.match(norm):
            return "opción sin texto (solo la letra)"
        if norm in seen:
            return "opciones repetidas"
        seen.add(norm)
    ids = [o.get("id") for o in options]
    correct = q.get("correctOptionIds") or []
    if not correct:
        return "sin respuesta correcta marcada"
    if len(set(correct)) != len(correct) or not set(correct) <= set(ids):
        return "respuesta correcta que no es una de las opciones"
    if len(correct) == len(ids):
        return "todas las opciones marcadas como correctas"
    return None
