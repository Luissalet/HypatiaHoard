"""Native record reads and field patches over the same revisioned study store."""

from __future__ import annotations

from typing import Any

from . import bank
from .hashing import compute_concept_hash, compute_content_hash
from .store import KINDS
from .teacher.store import TeacherStore, KINDS as TEACHER_KINDS

DERIVED_FIELDS = {"id", "createdAt", "updatedAt", "contentHash"}


def _store(services, kind: str):
    if kind in KINDS:
        return services.store
    if kind in TEACHER_KINDS:
        return TeacherStore(services)
    raise ValueError(f"Unknown record kind {kind!r}.")


def get_record(services, kind: str, id: str) -> dict[str, Any]:
    record = _store(services, kind).get(kind, id)
    if record is None:
        raise LookupError(f"{kind} {id} does not exist.")
    return record


def _validate(kind: str, record: dict) -> None:
    # Check content shapes before the existing validators and hash functions use them.
    text_fields = {"subject": ("name",), "topic": ("title",),
                   "question": ("prompt",), "keyConcept": ("title", "content")}.get(kind, ())
    for key in text_fields:
        if not isinstance(record.get(key), str) or not record[key].strip():
            raise ValueError(f"A {kind} needs a non-empty {key}.")
    if kind == "question":
        for key in ("modelAnswer", "clozeText", "explanation", "numericAnswer", "pageHtml", "notes", "sourceRef"):
            if key in record and not isinstance(record[key], str):
                raise ValueError(f"{key} must be text.")
        for key in ("options", "blanks"):
            if key in record and (not isinstance(record[key], list) or
                                  any(not isinstance(item, dict) for item in record[key])):
                raise ValueError(f"{key} must be a list of objects.")
        for option in record.get("options") or []:
            if not isinstance(option.get("id"), str) or not isinstance(option.get("text"), str):
                raise ValueError("Options need text ids and text values.")
        for key in ("correctOptionIds", "tags", "keywords", "topicIds"):
            if key in record and (not isinstance(record[key], list) or
                                  any(not isinstance(item, str) for item in record[key])):
                raise ValueError(f"{key} must be a list of strings.")
        if "starred" in record and not isinstance(record["starred"], bool):
            raise ValueError("starred must be a boolean.")
        if "difficulty" in record and (type(record["difficulty"]) is not int or not 1 <= record["difficulty"] <= 5):
            raise ValueError("difficulty must be an integer from 1 to 5.")
        for blank in record.get("blanks") or []:
            if not isinstance(blank.get("id"), str) or not isinstance(blank.get("accepted"), list) or \
                    any(not isinstance(item, str) for item in blank["accepted"]):
                raise ValueError("Blanks need a text id and a list of accepted answers.")
        bank.validate_question(record)
        record["contentHash"] = compute_content_hash(record)
    elif kind == "keyConcept":
        if record.get("category") not in bank.CONCEPT_CATEGORIES:
            raise ValueError("Unknown key concept category.")
        record["contentHash"] = compute_concept_hash(record["category"], record["title"], record["content"])


def _merge_fields(current: dict, patch: dict) -> dict:
    result = dict(current)
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge_fields(result[key], value)
        else:
            result[key] = value
    return result


def patch_record(services, kind: str, id: str, patch: dict[str, Any], merge_objects: bool = False) -> dict[str, Any]:
    """Apply supplied top-level fields to the latest row; null removes an optional field.

    Nested values and arrays replace their whole field. Identity, timestamps and
    hashes belong to the store. The transaction also covers validation and FTS.
    """
    if DERIVED_FIELDS.intersection(patch):
        raise ValueError("Patch content fields only; id, createdAt, updatedAt and contentHash are derived.")
    store = _store(services, kind)
    with services.db.tx():
        current = store.get(kind, id)
        if current is None:
            raise LookupError(f"{kind} {id} does not exist.")
        if merge_objects:
            updated = _merge_fields(current, patch)
        else:
            updated = dict(current)
            for key, value in patch.items():
                if value is None:
                    updated.pop(key, None)
                else:
                    updated[key] = value
        if updated == current:
            return current
        _validate(kind, updated)
        updated["updatedAt"] = services.now_iso()
        store.put(kind, updated)
        return store.get(kind, id)
