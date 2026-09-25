"""Server-side port of `mergeBackup` (src/data/gistSync.ts) with the record store
as the "local" side. Same rules, same order, same counters:

  subjects (dedup by slug) -> topics (dedup by subject::title slug) ->
  questions (dedup by recomputed contentHash, stats merged, notes/starred kept) ->
  sessions -> pdfAnchors -> keyConcepts -> exams -> deliverables ->
  gradingConfigs -> questionImages -> installedPackages -> syncedSettings.

JavaScript details that matter and are mirrored here:
- `a > b` on ISO strings is False when either side is missing;
- a property set to `undefined` disappears from the stored JSON (`UNDEF`);
- `Map.set` keeps the LAST local record for a duplicate key (Dexie returns
  records in primary-key order, so: highest id wins);
- `[...].filter(Boolean).sort().pop()` picks the greatest string in UTF-16 order.

One addition the Gist sync never needed: tombstones. A pushed record whose id
was deleted on the server is skipped unless it was edited after the deletion.
"""

from __future__ import annotations

import base64
import re
from typing import Any

from .hashing import compute_content_hash, js_sort_key, slugify
from .store import RecordStore

UNDEF: Any = object()  # JavaScript `undefined`


def js_gt(a: Any, b: Any) -> bool:
    """`a > b` for the ISO strings the PWA compares (False if either is missing)."""
    if isinstance(a, str) and isinstance(b, str):
        return js_sort_key(a) > js_sort_key(b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return a > b
    return False


def js_latest(*values: Any) -> Any:
    """`[a, b].filter(Boolean).sort().pop() ?? undefined`."""
    present = [v for v in values if isinstance(v, str) and v]
    return max(present, key=js_sort_key) if present else UNDEF


def with_fields(base: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """`{...base, k: v}`: a field whose value is UNDEF is removed, like JSON.stringify does."""
    out = dict(base)
    for key, value in fields.items():
        if value is UNDEF:
            out.pop(key, None)
        else:
            out[key] = value
    return out


def _mapped(id_map: dict[str, str], value: Any) -> Any:
    """`map.get(v) ?? v` (UNDEF stays UNDEF)."""
    if isinstance(value, str) and value in id_map:
        return id_map[value]
    return value


def _num(value: Any) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


class Counter:
    def __init__(self) -> None:
        self.added = self.updated = self.skipped = 0


def merge_stats(local: dict[str, Any] | None, remote: dict[str, Any] | None) -> dict[str, Any]:
    """`mergeStats`: most progress wins; returns `local` itself when nothing changes."""
    local = local if isinstance(local, dict) else {}
    remote = remote if isinstance(remote, dict) else {}
    seen = max(_num(local.get("seen")), _num(remote.get("seen")))
    correct = max(_num(local.get("correct")), _num(remote.get("correct")))
    wrong = max(_num(local.get("wrong")), _num(remote.get("wrong")))
    last_seen = js_latest(local.get("lastSeenAt"), remote.get("lastSeenAt"))
    local_reps = local.get("repetitions") if local.get("repetitions") is not None else 0
    remote_reps = remote.get("repetitions") if remote.get("repetitions") is not None else 0
    srs_source = remote if js_gt(remote_reps, local_reps) else local
    if (seen == _num(local.get("seen")) and correct == _num(local.get("correct"))
            and wrong == _num(local.get("wrong")) and last_seen == local.get("lastSeenAt", UNDEF)):
        return local
    last_result = remote.get("lastResult", UNDEF) if last_seen == remote.get("lastSeenAt", UNDEF) else local.get("lastResult", UNDEF)
    return with_fields(srs_source, seen=seen, correct=correct, wrong=wrong, lastSeenAt=last_seen, lastResult=last_result)


def _record_time(kind: str, record: dict[str, Any]) -> Any:
    """The timestamp that says when a record was last edited (None: unknown)."""
    if isinstance(record.get("updatedAt"), str):
        return record["updatedAt"]
    if kind == "session":
        times = [record.get("createdAt"), record.get("finishedAt")]
        times += [a.get("answeredAt") for a in record.get("answers") or [] if isinstance(a, dict)]
        latest = js_latest(*times)
        return None if latest is UNDEF else latest
    if kind == "installedPackage":
        return record.get("installedAt")
    return None


class Merger:
    def __init__(self, store: RecordStore, now_iso):
        self.store = store
        self.now_iso = now_iso
        self.count = Counter()
        self.subject_map: dict[str, str] = {}
        self.topic_map: dict[str, str] = {}
        self.question_map: dict[str, str] = {}

    # ---------- helpers ----------
    def _blocked(self, kind: str, record: dict[str, Any], record_id: Any = None) -> bool:
        rid = record.get("id") if record_id is None else record_id
        if not isinstance(rid, str):
            return True
        tomb = self.store.tombstone(kind, rid)
        if tomb is None:
            return False
        return not js_gt(_record_time(kind, record), tomb["deletedAt"])

    def _local(self, kind: str) -> list[dict]:
        return self.store.list(kind)  # ordered by id, like Dexie's toArray()

    # ---------- 1. subjects ----------
    def subjects(self, remote_subjects: list[dict]) -> None:
        c = self.count
        local_subjects = self._local("subject")
        by_slug: dict[str, dict] = {}
        by_id: dict[str, dict] = {}
        for s in local_subjects:
            by_slug[slugify(s.get("name") or "")] = s
            by_id[s["id"]] = s
        for remote in remote_subjects:
            if self._blocked("subject", remote):
                c.skipped += 1
                continue
            slug = slugify(remote.get("name") or "")
            local_by_id = by_id.get(remote["id"])
            local_by_slug = by_slug.get(slug)
            if local_by_id:
                self.subject_map[remote["id"]] = remote["id"]
                if js_gt(remote.get("updatedAt"), local_by_id.get("updatedAt")):
                    self.store.put("subject", with_fields(remote, examDate=local_by_id.get("examDate", UNDEF),
                                                          allowsNotes=local_by_id.get("allowsNotes", UNDEF)))
                    c.updated += 1
                else:
                    c.skipped += 1
            elif local_by_slug:
                self.subject_map[remote["id"]] = local_by_slug["id"]
                if js_gt(remote.get("updatedAt"), local_by_slug.get("updatedAt")):
                    self.store.put("subject", with_fields(remote, id=local_by_slug["id"],
                                                          examDate=local_by_slug.get("examDate", UNDEF),
                                                          allowsNotes=local_by_slug.get("allowsNotes", UNDEF)))
                    c.updated += 1
                else:
                    c.skipped += 1
            else:
                self.store.put("subject", remote)
                self.subject_map[remote["id"]] = remote["id"]
                by_slug[slug] = remote
                by_id[remote["id"]] = remote
                c.added += 1
        for s in local_subjects:
            self.subject_map.setdefault(s["id"], s["id"])

    # ---------- 2. topics ----------
    def topics(self, remote_topics: list[dict]) -> None:
        c = self.count
        local_topics = self._local("topic")
        subject_name = {s["id"]: s.get("name") for s in self._local("subject")}
        by_key: dict[str, dict] = {}
        by_id: dict[str, dict] = {}
        for t in local_topics:
            name = subject_name.get(t.get("subjectId"))
            if name:
                by_key[f"{slugify(name)}::{slugify(t.get('title') or '')}"] = t
            by_id[t["id"]] = t
        for remote in remote_topics:
            local_subject_id = _mapped(self.subject_map, remote.get("subjectId", UNDEF))
            name = subject_name.get(local_subject_id) if isinstance(local_subject_id, str) else None
            if not name or self._blocked("topic", remote):
                c.skipped += 1
                continue
            key = f"{slugify(name)}::{slugify(remote.get('title') or '')}"
            local_by_id = by_id.get(remote["id"])
            local_by_key = by_key.get(key)
            if local_by_id:
                self.topic_map[remote["id"]] = remote["id"]
                if js_gt(remote.get("updatedAt"), local_by_id.get("updatedAt")):
                    self.store.put("topic", with_fields(remote, subjectId=local_subject_id))
                    c.updated += 1
                else:
                    c.skipped += 1
            elif local_by_key:
                self.topic_map[remote["id"]] = local_by_key["id"]
                if js_gt(remote.get("updatedAt"), local_by_key.get("updatedAt")):
                    self.store.put("topic", with_fields(remote, id=local_by_key["id"], subjectId=local_subject_id))
                    c.updated += 1
                else:
                    c.skipped += 1
            else:
                remapped = with_fields(remote, subjectId=local_subject_id)
                self.store.put("topic", remapped)
                self.topic_map[remote["id"]] = remote["id"]
                by_key[key] = remapped
                by_id[remote["id"]] = remapped
                c.added += 1
        for t in local_topics:
            self.topic_map.setdefault(t["id"], t["id"])

    # ---------- 3. questions ----------
    def questions(self, remote_questions: list[dict]) -> None:
        c = self.count
        by_id: dict[str, dict] = {}
        by_hash: dict[str, dict] = {}
        for q in self._local("question"):
            by_id[q["id"]] = q
            if q.get("contentHash"):
                by_hash[q["contentHash"]] = q
        for remote in remote_questions:
            if self._blocked("question", remote):
                c.skipped += 1
                continue
            topic_ids = remote.get("topicIds")
            content_hash = compute_content_hash(remote)
            remapped = with_fields(
                remote,
                subjectId=_mapped(self.subject_map, remote.get("subjectId", UNDEF)),
                topicId=_mapped(self.topic_map, remote.get("topicId", UNDEF)),
                topicIds=[_mapped(self.topic_map, t) for t in topic_ids] if isinstance(topic_ids, list) else UNDEF,
                contentHash=content_hash,
            )
            local_by_id = by_id.get(remote["id"])
            if local_by_id:
                self.question_map[remote["id"]] = local_by_id["id"]
                if js_gt(remote.get("updatedAt"), local_by_id.get("updatedAt")):
                    self.store.put("question", with_fields(
                        remapped, notes=local_by_id.get("notes", UNDEF), starred=local_by_id.get("starred", UNDEF),
                        stats=merge_stats(local_by_id.get("stats"), remote.get("stats"))))
                    c.updated += 1
                else:
                    self._merge_stats_into(local_by_id, remote)
                continue
            local_by_hash = by_hash.get(content_hash)
            if local_by_hash:
                self.question_map[remote["id"]] = local_by_hash["id"]
                self._merge_stats_into(local_by_hash, remote)
            else:
                self.question_map[remote["id"]] = remote["id"]
                self.store.put("question", remapped)
                by_hash[content_hash] = remapped
                by_id[remote["id"]] = remapped
                c.added += 1

    def _merge_stats_into(self, local: dict, remote: dict) -> None:
        local_stats = local.get("stats")
        merged = merge_stats(local_stats, remote.get("stats"))
        # Unchanged: mergeStats handed back the local object (an empty one if local had none).
        if merged is local_stats or (not isinstance(local_stats, dict) and not merged):
            self.count.skipped += 1
            return
        current = self.store.get("question", local["id"]) or local
        self.store.put("question", with_fields(current, stats=merged))
        self.count.updated += 1

    # ---------- 4. sessions ----------
    def sessions(self, remote_sessions: list[dict]) -> None:
        c = self.count
        for remote in remote_sessions:
            if self._blocked("session", remote):
                c.skipped += 1
                continue
            topic_id = remote.get("topicId", UNDEF)
            remapped = with_fields(
                remote,
                subjectId=_mapped(self.subject_map, remote.get("subjectId", UNDEF)),
                topicId=_mapped(self.topic_map, topic_id) if topic_id not in (UNDEF, None, "") else topic_id,
                questionIds=[_mapped(self.question_map, q) for q in remote.get("questionIds") or []],
                answers=[with_fields(a, questionId=_mapped(self.question_map, a.get("questionId", UNDEF)))
                         for a in remote.get("answers") or [] if isinstance(a, dict)],
            )
            if remote.get("subjectIds"):
                remapped["subjectIds"] = [_mapped(self.subject_map, s) for s in remote["subjectIds"]]
            if remote.get("topicIds"):
                remapped["topicIds"] = [_mapped(self.topic_map, t) for t in remote["topicIds"]]
            local = self.store.get("session", remote["id"])
            if local is None:
                self.store.put("session", remapped)
                c.added += 1
            elif remote.get("finishedAt") and not local.get("finishedAt"):
                self.store.put("session", remapped)
                c.updated += 1
            elif len(remote.get("answers") or []) > len(local.get("answers") or []):
                self.store.put("session", remapped)
                c.updated += 1
            else:
                new_ids = remapped["questionIds"]
                old_ids = local.get("questionIds") or []
                if any(i >= len(new_ids) or qid != new_ids[i] for i, qid in enumerate(old_ids)):
                    self.store.put("session", with_fields(local, questionIds=new_ids, answers=remapped["answers"]))
                    c.updated += 1
                else:
                    c.skipped += 1

    # ---------- 5/7/8. generic tables ----------
    def table(self, kind: str, remote_records: list[dict], timestamp_field: str | None) -> None:
        c = self.count
        for remote in remote_records:
            if self._blocked(kind, remote):
                c.skipped += 1
                continue
            remapped = with_fields(remote, subjectId=_mapped(self.subject_map, remote.get("subjectId", UNDEF)))
            local = self.store.get(kind, remote["id"])
            if local is None:
                self.store.put(kind, remapped)
                c.added += 1
            elif timestamp_field:
                local_ts, remote_ts = local.get(timestamp_field), remapped.get(timestamp_field)
                if remote_ts and local_ts and js_gt(remote_ts, local_ts):
                    self.store.put(kind, remapped)
                    c.updated += 1
                else:
                    c.skipped += 1
            else:
                c.skipped += 1

    # ---------- 6. key concepts ----------
    def key_concepts(self, remote_concepts: list[dict]) -> None:
        c = self.count
        by_id: dict[str, dict] = {}
        by_hash: dict[str, dict] = {}
        for kc in self._local("keyConcept"):
            by_id[kc["id"]] = kc
            if kc.get("contentHash"):
                by_hash[kc["contentHash"]] = kc
        for remote in remote_concepts:
            if self._blocked("keyConcept", remote):
                c.skipped += 1
                continue
            topic_id = remote.get("topicId")
            remapped = with_fields(
                remote,
                subjectId=_mapped(self.subject_map, remote.get("subjectId", UNDEF)),
                topicId=_mapped(self.topic_map, topic_id) if topic_id else UNDEF,
            )
            local_by_id = by_id.get(remote["id"])
            if local_by_id:
                if js_gt(remote.get("updatedAt"), local_by_id.get("updatedAt")):
                    self.store.put("keyConcept", remapped)
                    c.updated += 1
                else:
                    c.skipped += 1
            elif remote.get("contentHash") and remote["contentHash"] in by_hash:
                c.skipped += 1
            else:
                self.store.put("keyConcept", remapped)
                if remote.get("contentHash"):
                    by_hash[remote["contentHash"]] = remapped
                by_id[remote["id"]] = remapped
                c.added += 1

    # ---------- 9. grading configs ----------
    def grading_configs(self, remote_configs: list[dict]) -> None:
        c = self.count
        for remote in remote_configs:
            local_id = _mapped(self.subject_map, remote.get("id"))
            if not isinstance(local_id, str) or self._blocked("gradingConfig", remote, local_id):
                c.skipped += 1
                continue
            remapped = with_fields(remote, id=local_id)
            local = self.store.get("gradingConfig", local_id)
            if local is None:
                self.store.put("gradingConfig", remapped)
                c.added += 1
            elif remote.get("examGrade") is not None and local.get("examGrade") is None:
                self.store.put("gradingConfig", remapped)
                c.added += 1
            else:
                c.skipped += 1

    # ---------- 10. images ----------
    def images(self, remote_images: dict[str, Any]) -> None:
        c = self.count
        stems = self.store.image_stems()
        for filename, entry in (remote_images or {}).items():
            stem = re.sub(r"\.[^.]+$", "", filename)
            if stem in stems or not isinstance(entry, dict):
                c.skipped += 1
                continue
            try:
                data = base64.b64decode(entry.get("base64") or "", validate=False)
            except (ValueError, TypeError):
                c.skipped += 1
                continue
            self.store.put_image(filename, entry.get("mimeType") or "application/octet-stream", data)
            stems.add(stem)
            c.added += 1

    # ---------- 11. installed packages ----------
    def installed_packages(self, packages: list[dict]) -> None:
        c = self.count
        for pkg in packages:
            if self._blocked("installedPackage", pkg):
                c.skipped += 1
                continue
            if self.store.get("installedPackage", pkg["id"]) is None:
                self.store.put("installedPackage", with_fields(pkg, subjectId=_mapped(self.subject_map, pkg.get("subjectId", UNDEF))))
                c.added += 1
            else:
                c.skipped += 1

    # ---------- 12. synced settings ----------
    def synced_settings(self, remote: dict[str, Any] | None) -> None:
        if not isinstance(remote, dict):
            return
        local = self.store.kv_get("syncedSettings") or {}
        self.store.kv_set("syncedSettings", merge_synced_settings(local, remote))


def merge_synced_settings(local: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
    pack_ids: list[Any] = []
    for pid in list(local.get("importedPackIds") or []) + list(remote.get("importedPackIds") or []):
        if pid not in pack_ids:
            pack_ids.append(pid)
    history: dict[Any, Any] = {}
    for entry in list(local.get("importHistory") or []) + list(remote.get("importHistory") or []):
        if isinstance(entry, dict) and entry.get("packId") not in history:
            history[entry.get("packId")] = entry
    return with_fields(
        local,
        alias=local.get("alias") or remote.get("alias", UNDEF),
        importedPackIds=pack_ids,
        studyStreak=max(_num(local.get("studyStreak")), _num(remote.get("studyStreak"))),
        lastStudyDate=js_latest(local.get("lastStudyDate"), remote.get("lastStudyDate")),
        subjectGoals={**(remote.get("subjectGoals") or {}), **(local.get("subjectGoals") or {})},
        globalBankSyncedAt=js_latest(local.get("globalBankSyncedAt"), remote.get("globalBankSyncedAt")),
        importHistory=list(history.values()),
        marketplacePasswords={**(remote.get("marketplacePasswords") or {}), **(local.get("marketplacePasswords") or {})},
    )


def _records(backup: dict[str, Any], key: str) -> list[dict]:
    value = backup.get(key)
    return [r for r in value if isinstance(r, dict) and isinstance(r.get("id"), str)] if isinstance(value, list) else []


def merge_backup(store: RecordStore, backup: dict[str, Any], now_iso) -> dict[str, Any]:
    """Apply a pushed FullBackup to the store, atomically. Returns counters and the
    remote->server id map (only entries where the ids differ)."""
    if not isinstance(backup, dict) or backup.get("kind") != "full-backup":
        raise ValueError("The backup is not a full-backup.")
    m = Merger(store, now_iso)
    with store.db.tx():
        m.subjects(_records(backup, "subjects"))
        m.topics(_records(backup, "topics"))
        m.questions(_records(backup, "questions"))
        m.sessions(_records(backup, "sessions"))
        m.table("pdfAnchor", _records(backup, "pdfAnchors"), None)
        m.key_concepts(_records(backup, "keyConcepts"))
        m.table("exam", _records(backup, "exams"), "updatedAt")
        m.table("deliverable", _records(backup, "deliverables"), "updatedAt")
        m.grading_configs(_records(backup, "gradingConfigs"))
        m.images(backup.get("questionImages") if isinstance(backup.get("questionImages"), dict) else {})
        if isinstance(backup.get("installedPackages"), list):
            m.installed_packages(_records(backup, "installedPackages"))
        m.synced_settings(backup.get("syncedSettings"))
    return {
        "added": m.count.added,
        "updated": m.count.updated,
        "skipped": m.count.skipped,
        "idMap": {
            "subjects": {k: v for k, v in m.subject_map.items() if k != v},
            "topics": {k: v for k, v in m.topic_map.items() if k != v},
            "questions": {k: v for k, v in m.question_map.items() if k != v},
        },
    }
