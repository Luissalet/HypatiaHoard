"""merge.py reproduces mergeBackup (src/data/gistSync.ts) rule by rule, with the
server store as the local side, plus tombstones."""

import base64

import pytest

from hypatia.hashing import compute_content_hash
from hypatia.merge import merge_backup, merge_stats, merge_synced_settings

T0 = "2026-09-01T10:00:00.000Z"
T1 = "2026-09-10T10:00:00.000Z"
T2 = "2026-09-20T10:00:00.000Z"


def backup(**arrays):
    base = {"version": 2, "kind": "full-backup", "exportedAt": T2, "deviceId": "dev-1", "subjects": [], "topics": [],
            "questions": [], "sessions": [], "pdfAnchors": [], "keyConcepts": [], "exams": [], "deliverables": [],
            "gradingConfigs": [], "syncedSettings": {"alias": "", "importedPackIds": []}, "questionImages": {}}
    base.update(arrays)
    return base


def subject(id, name="Redes", at=T0, **kw):
    return {"id": id, "name": name, "createdAt": T0, "updatedAt": at, **kw}


def topic(id, subject_id, title="Tema 1", at=T0, **kw):
    return {"id": id, "subjectId": subject_id, "title": title, "order": 0, "createdAt": T0, "updatedAt": at, **kw}


def question(id, subject_id="s1", topic_id="t1", prompt="¿Qué es TCP?", at=T0, stats=None, **kw):
    q = {"id": id, "subjectId": subject_id, "topicId": topic_id, "type": "DESARROLLO", "prompt": prompt,
         "modelAnswer": "Un protocolo.", "stats": stats or {"seen": 0, "correct": 0, "wrong": 0}, "createdAt": T0, "updatedAt": at}
    q.update(kw)
    return q


@pytest.fixture
def merge(services):
    return lambda b: merge_backup(services.store, b, services.now_iso)


@pytest.fixture
def store(services):
    return services.store


# ---------- subjects ----------

def test_new_subject_added(merge, store):
    r = merge(backup(subjects=[subject("s1")]))
    assert r["added"] == 1 and store.get("subject", "s1")["name"] == "Redes"


def test_same_id_newer_remote_keeps_local_exam_date_and_allows_notes(merge, store):
    store.put("subject", subject("s1", examDate="2027-01-10", allowsNotes=True))
    r = merge(backup(subjects=[subject("s1", name="Redes II", at=T1, examDate="1999-01-01")]))
    got = store.get("subject", "s1")
    assert r["updated"] == 1 and got["name"] == "Redes II" and got["examDate"] == "2027-01-10" and got["allowsNotes"] is True


def test_same_id_local_without_exam_date_drops_remote_one(merge, store):
    store.put("subject", subject("s1"))
    merge(backup(subjects=[subject("s1", at=T1, examDate="2027-02-02")]))
    assert "examDate" not in store.get("subject", "s1")  # {...remote, examDate: undefined}


def test_older_remote_subject_skipped(merge, store):
    store.put("subject", subject("s1", name="Local", at=T1))
    r = merge(backup(subjects=[subject("s1", name="Remote", at=T0)]))
    assert r["skipped"] == 1 and store.get("subject", "s1")["name"] == "Local"


def test_subject_dedup_by_slug_maps_ids_and_children(merge, store):
    store.put("subject", subject("local-s", name="Ingeniería del Software", examDate="2027-01-01"))
    r = merge(backup(subjects=[subject("remote-s", name="ingenieria del  software", at=T1)],
                     topics=[topic("t9", "remote-s")], questions=[question("q9", "remote-s", "t9")]))
    assert r["idMap"]["subjects"] == {"remote-s": "local-s"}
    assert store.get("subject", "remote-s") is None
    got = store.get("subject", "local-s")
    assert got["name"] == "ingenieria del  software" and got["examDate"] == "2027-01-01"
    assert store.get("topic", "t9")["subjectId"] == "local-s"
    assert store.get("question", "q9")["subjectId"] == "local-s"


# ---------- topics ----------

def test_topic_of_unknown_subject_skipped(merge, store):
    r = merge(backup(topics=[topic("t1", "ghost")]))
    assert r["skipped"] == 1 and store.get("topic", "t1") is None


def test_topic_dedup_by_subject_and_title_slug(merge, store):
    store.put("subject", subject("s1"))
    store.put("topic", topic("t-local", "s1", title="Tema 1: Capas"))
    r = merge(backup(subjects=[subject("s1")], topics=[topic("t-remote", "s1", title="tema 1 capas")],
                     questions=[question("q1", "s1", "t-remote", topicIds=["t-remote", "t-other"])]))
    assert r["idMap"]["topics"] == {"t-remote": "t-local"}
    q = store.get("question", "q1")
    assert q["topicId"] == "t-local" and q["topicIds"] == ["t-local", "t-other"]


# ---------- questions ----------

def test_new_question_gets_recomputed_hash_and_no_topic_ids_key(merge, store):
    merge(backup(questions=[question("q1", contentHash="sha256:stale")]))
    q = store.get("question", "q1")
    assert q["contentHash"] == compute_content_hash(q) and "topicIds" not in q


def test_same_id_newer_remote_keeps_notes_starred_and_merges_stats(merge, store):
    store.put("question", question("q1", notes="mi nota", starred=True,
                                   stats={"seen": 5, "correct": 3, "wrong": 2, "lastSeenAt": T1, "repetitions": 3,
                                          "easeFactor": 2.2, "interval": 9, "lastResult": "CORRECT"}))
    remote = question("q1", prompt="¿Qué es TCP? (editada)", at=T2, notes="remote note", starred=False,
                      stats={"seen": 2, "correct": 2, "wrong": 0, "lastSeenAt": T0, "repetitions": 1, "lastResult": "WRONG"})
    r = merge(backup(questions=[remote]))
    q = store.get("question", "q1")
    assert r["updated"] == 1 and q["prompt"].endswith("(editada)")
    assert q["notes"] == "mi nota" and q["starred"] is True
    assert q["stats"]["seen"] == 5 and q["stats"]["repetitions"] == 3 and q["stats"]["lastResult"] == "CORRECT"


def test_same_id_local_without_notes_drops_remote_notes(merge, store):
    store.put("question", question("q1"))
    merge(backup(questions=[question("q1", at=T1, notes="x", starred=True)]))
    q = store.get("question", "q1")
    assert "notes" not in q and "starred" not in q


def test_same_id_older_remote_with_more_progress_only_merges_stats(merge, store):
    store.put("question", question("q1", at=T1, stats={"seen": 1, "correct": 1, "wrong": 0, "lastSeenAt": T0}))
    remote = question("q1", prompt="old text", at=T0, stats={"seen": 4, "correct": 2, "wrong": 2, "lastSeenAt": T2,
                                                              "lastResult": "WRONG", "repetitions": 0})
    r = merge(backup(questions=[remote]))
    q = store.get("question", "q1")
    assert r["updated"] == 1 and q["prompt"] == "¿Qué es TCP?" and q["updatedAt"] == T1
    assert q["stats"] == {"seen": 4, "correct": 2, "wrong": 2, "lastSeenAt": T2, "lastResult": "WRONG"}


def test_same_id_older_remote_same_stats_skipped(merge, store):
    store.put("question", question("q1", at=T1))
    rev = store.current_rev()
    r = merge(backup(questions=[question("q1", at=T0)]))
    assert r["skipped"] == 1 and store.current_rev() == rev


def test_dedupe_by_hash_maps_id_and_merges_stats(merge, store):
    local = question("q-local", stats={"seen": 1, "correct": 0, "wrong": 1, "lastSeenAt": T0})
    local["contentHash"] = compute_content_hash(local)
    store.put("question", local)
    remote = question("q-remote", prompt="  ¿QUÉ es tcp?  ", stats={"seen": 3, "correct": 2, "wrong": 1, "lastSeenAt": T1})
    r = merge(backup(questions=[remote], sessions=[{"id": "ss1", "subjectId": "s1", "mode": "all", "createdAt": T0,
                                                     "questionIds": ["q-remote"], "answers": []}]))
    assert r["idMap"]["questions"] == {"q-remote": "q-local"}
    assert store.get("question", "q-remote") is None
    assert store.get("question", "q-local")["stats"]["seen"] == 3
    assert store.get("session", "ss1")["questionIds"] == ["q-local"]


def test_merge_stats_identity_and_srs_source():
    local = {"seen": 3, "correct": 2, "wrong": 1, "lastSeenAt": T1, "repetitions": 1}
    assert merge_stats(local, {"seen": 1, "correct": 1, "wrong": 0, "repetitions": 9}) is local
    merged = merge_stats(local, {"seen": 4, "correct": 2, "wrong": 2, "lastSeenAt": T0, "repetitions": 2,
                                  "easeFactor": 1.9, "lastResult": "WRONG"})
    assert merged["easeFactor"] == 1.9 and merged["seen"] == 4 and merged["lastSeenAt"] == T1
    assert "lastResult" not in merged  # lastSeenAt is local's, and local had no lastResult


# ---------- sessions ----------

def _session(id, answers=0, finished=None, qids=("q1",)):
    s = {"id": id, "subjectId": "s1", "mode": "all", "createdAt": T0, "questionIds": list(qids),
         "answers": [{"questionId": "q1", "answeredAt": T0, "result": "CORRECT"}] * answers}
    if finished:
        s["finishedAt"] = finished
    return s


def test_sessions_add_finish_more_answers_and_skip(merge, store):
    store.put("session", _session("a", answers=1))
    store.put("session", _session("b", answers=2))
    store.put("session", _session("c", answers=2))
    r = merge(backup(sessions=[_session("new"), _session("a", answers=1, finished=T1), _session("b", answers=3),
                                _session("c", answers=1)]))
    assert (r["added"], r["updated"], r["skipped"]) == (1, 2, 1)
    assert store.get("session", "a")["finishedAt"] == T1 and len(store.get("session", "b")["answers"]) == 3


def test_session_repairs_broken_question_ids(merge, store):
    store.put("session", _session("s", answers=1, qids=("q1", "q2")))
    r = merge(backup(sessions=[_session("s", answers=1, qids=("q1",))]))
    assert r["updated"] == 1 and store.get("session", "s")["questionIds"] == ["q1"]


# ---------- other tables ----------

def test_pdf_anchors_add_only_and_exams_lww(merge, store):
    store.put("pdfAnchor", {"id": "p1", "subjectId": "s1", "pdfId": "x", "page": 1})
    store.put("exam", {"id": "e1", "subjectId": "s1", "name": "Local", "questionIds": [], "createdAt": T0, "updatedAt": T1})
    r = merge(backup(pdfAnchors=[{"id": "p1", "subjectId": "s1", "pdfId": "x", "page": 9}, {"id": "p2", "subjectId": "s1", "pdfId": "y", "page": 2}],
                     exams=[{"id": "e1", "subjectId": "s1", "name": "Remote", "questionIds": [], "createdAt": T0, "updatedAt": T2}],
                     deliverables=[{"id": "d1", "subjectId": "s1", "name": "Práctica", "type": "activity", "status": "pending",
                                    "continuousPoints": 1, "createdAt": T0, "updatedAt": T0}]))
    assert store.get("pdfAnchor", "p1")["page"] == 1 and store.get("pdfAnchor", "p2")
    assert store.get("exam", "e1")["name"] == "Remote" and store.get("deliverable", "d1")
    assert r["added"] == 2 and r["updated"] == 1 and r["skipped"] == 1


def test_key_concepts_hash_dup_skipped_and_lww(merge, store):
    store.put("keyConcept", {"id": "k1", "subjectId": "s1", "category": "formula", "title": "Ley", "content": "V=IR",
                             "order": 0, "contentHash": "sha256:h", "createdAt": T0, "updatedAt": T0})
    r = merge(backup(keyConcepts=[
        {"id": "k2", "subjectId": "s1", "category": "formula", "title": "Ley", "content": "V=IR", "order": 0,
         "contentHash": "sha256:h", "createdAt": T0, "updatedAt": T0},
        {"id": "k1", "subjectId": "s1", "category": "formula", "title": "Ley de Ohm", "content": "V=IR", "order": 0,
         "contentHash": "sha256:h", "topicId": "", "createdAt": T0, "updatedAt": T1},
    ]))
    assert store.get("keyConcept", "k2") is None and r["skipped"] == 1 and r["updated"] == 1
    k1 = store.get("keyConcept", "k1")
    assert k1["title"] == "Ley de Ohm" and "topicId" not in k1


def test_grading_configs_add_or_fill_exam_grade(merge, store):
    store.put("gradingConfig", {"id": "s1", "continuousWeight": 0.4, "maxContinuousPoints": 10, "testContinuousPoints": 0.1})
    r = merge(backup(gradingConfigs=[{"id": "s1", "continuousWeight": 0.3, "maxContinuousPoints": 10,
                                      "testContinuousPoints": 0.1, "examGrade": 7.5},
                                     {"id": "s2", "continuousWeight": 0.5, "maxContinuousPoints": 10, "testContinuousPoints": 0.1}]))
    assert r["added"] == 2 and store.get("gradingConfig", "s1")["examGrade"] == 7.5 and store.get("gradingConfig", "s2")


def test_images_only_new_ones(merge, store):
    store.put_image("abc.png", "image/png", b"old")
    r = merge(backup(questionImages={"abc.jpg": {"base64": base64.b64encode(b"new").decode(), "mimeType": "image/jpeg"},
                                     "def.png": {"base64": base64.b64encode(b"img").decode(), "mimeType": "image/png"}}))
    assert r["added"] == 1 and r["skipped"] == 1 and store.image("def.png") == ("image/png", b"img")


def test_installed_packages_add_if_missing_with_subject_remap(merge, store):
    store.put("subject", subject("local-s", name="Redes"))
    merge(backup(subjects=[subject("remote-s", name="Redes")],
                 installedPackages=[{"id": "redes", "subjectId": "remote-s", "version": "1.0.0", "name": "Redes",
                                     "installedAt": T0, "manifest": {}}]))
    assert store.get("installedPackage", "redes")["subjectId"] == "local-s"


def test_synced_settings_merge():
    local = {"alias": "", "importedPackIds": ["a"], "studyStreak": 2, "lastStudyDate": "2026-09-20",
             "subjectGoals": {"s1": 80}, "marketplacePasswords": {"p": "local"}, "importHistory": [{"packId": "a", "n": 1}]}
    remote = {"alias": "Luis", "importedPackIds": ["b", "a"], "studyStreak": 5, "lastStudyDate": "2026-09-18",
              "subjectGoals": {"s1": 50, "s2": 70}, "marketplacePasswords": {"p": "remote", "q": "r"},
              "importHistory": [{"packId": "a", "n": 2}, {"packId": "b"}], "globalBankSyncedAt": T1}
    got = merge_synced_settings(local, remote)
    assert got["alias"] == "Luis" and got["importedPackIds"] == ["a", "b"] and got["studyStreak"] == 5
    assert got["lastStudyDate"] == "2026-09-20" and got["subjectGoals"] == {"s1": 80, "s2": 70}
    assert got["marketplacePasswords"] == {"p": "local", "q": "r"} and got["globalBankSyncedAt"] == T1
    assert got["importHistory"] == [{"packId": "a", "n": 1}, {"packId": "b"}]


# ---------- tombstones ----------

def test_tombstoned_records_are_not_resurrected_unless_edited_later(merge, store):
    store.put("question", question("q1"))
    store.put("question", question("q2", prompt="otra"))
    store.delete("question", "q1", deleted_at=T1)
    store.delete("question", "q2", deleted_at=T1)
    r = merge(backup(questions=[question("q1", at=T0), question("q2", prompt="otra (editada)", at=T2)]))
    assert store.get("question", "q1") is None and store.get("question", "q2")["prompt"] == "otra (editada)"
    assert r["skipped"] == 1 and r["added"] == 1


def test_bad_backup_rejected(merge):
    with pytest.raises(ValueError):
        merge({"kind": "bank"})
