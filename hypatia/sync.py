"""Sync protocol with the PWA: state, pull since a revision, push (deletes + merge)."""

from __future__ import annotations

import base64
from typing import Any

from .merge import merge_backup
from .store import KINDS, RecordStore

MAX_DEVICE_IDS = 5


def empty_settings() -> dict[str, Any]:
    return {"alias": "", "importedPackIds": []}


def state(store: RecordStore) -> dict[str, Any]:
    counts = {array: store.count(kind) for kind, array in KINDS.items()}
    return {
        "rev": store.current_rev(),
        "counts": counts,
        "deviceIds": store.kv_get("deviceIds", []) or [],
        "lastPushAt": store.kv_get("lastPushAt"),
    }


def pull(store: RecordStore, since: int, now_iso: str) -> dict[str, Any]:
    """FullBackup with only records changed after `since` (+ tombstones)."""
    with store.db.lock:  # one consistent snapshot
        rev = store.current_rev()
        changed = store.changed_since(since)
        tombstones = store.tombstones_since(since)
        images = store.images_since(since)
        settings = store.kv_get("syncedSettings") or empty_settings()
    backup: dict[str, Any] = {
        "version": 2,
        "kind": "full-backup",
        "exportedAt": now_iso,
        "deviceId": "hypatia-hoard",
    }
    for kind, array in KINDS.items():
        backup[array] = changed.get(kind, [])
    backup["syncedSettings"] = {**empty_settings(), **settings}
    backup["questionImages"] = {name: {"base64": base64.b64encode(data).decode("ascii"), "mimeType": mime}
                                for name, mime, data in images}
    return {"backup": backup, "tombstones": [{"kind": t["kind"], "id": t["id"]} for t in tombstones], "rev": rev}


def push(store: RecordStore, backup: dict[str, Any], deletes: list[dict[str, Any]], device_id: str | None,
         now_iso: str) -> dict[str, Any]:
    """Apply the device's deletions first (tombstones), then merge its backup."""
    with store.db.tx():
        for item in deletes or []:
            kind, rid = item.get("kind"), item.get("id")
            if kind in KINDS and isinstance(rid, str) and rid:
                deleted_at = item.get("deletedAt") if isinstance(item.get("deletedAt"), str) else None
                store.delete(kind, rid, deleted_at or now_iso)
        result = merge_backup(store, backup, lambda: now_iso)
        if device_id:
            devices = [d for d in store.kv_get("deviceIds", []) or [] if d != device_id]
            store.kv_set("deviceIds", ([device_id] + devices)[:MAX_DEVICE_IDS])
        store.kv_set("lastPushAt", now_iso)
    return {"rev": store.current_rev(), **result}
