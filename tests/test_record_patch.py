"""Native field updates preserve concurrent edits and the existing sync contract."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from hypatia import bank, records, sync
from hypatia.agent_tools import call_tool
from hypatia.hashing import compute_concept_hash, compute_content_hash


def seed(svc):
    now = svc.now_iso()
    svc.store.put("subject", {"id": "s", "name": "Networks", "examDate": "2026-11-01", "createdAt": now})
    svc.store.put("topic", {"id": "t", "subjectId": "s", "title": "TCP", "order": 0})
    svc.store.put("question", {"id": "q", "subjectId": "s", "topicId": "t", "type": "DESARROLLO",
                              "prompt": "Explain TCP", "modelAnswer": "Old answer", "notes": "Keep notes",
                              "stats": {"seen": 3}, "sourceRef": "hoard://links/article/example", "createdAt": now})


def test_stale_question_snapshot_does_not_overwrite_tool_edit(services):
    seed(services)
    stale = services.store.get("question", "q")
    bank.update_question(services, stale, {"modelAnswer": "Agent answer"})
    result = bank.update_question(services, stale, {"prompt": "User prompt"})
    assert result["modelAnswer"] == "Agent answer"
    assert result["prompt"] == "User prompt"
    assert result["stats"] == {"seen": 3}


def test_mcp_patch_and_http_save_preserve_each_others_fields(client):
    seed(client.services)
    before = client.get("/api/bank/records/question/q").json()["record"]
    auth = {"Authorization": f"Bearer {client.services.token}"}
    remote = client.post("/api/agent/call", headers=auth, json={"name": "record_patch", "arguments": {
        "kind": "question", "id": "q", "patch": {"modelAnswer": "Agent answer"}}})
    assert remote.status_code == 200
    response = client.patch("/api/bank/records/question/q", json={"prompt": "User prompt"})
    assert response.status_code == 200
    result = response.json()["record"]
    assert result["modelAnswer"] == "Agent answer" and result["prompt"] == "User prompt"
    assert result["createdAt"] == before["createdAt"]
    assert result["stats"] == before["stats"] and result["sourceRef"] == before["sourceRef"]
    assert result["contentHash"] == compute_content_hash(result)
    assert client.get("/api/bank/questions", params={"q": "User prompt"}).json()["count"] == 1
    pulled = sync.pull(client.services.store, 0, client.services.now_iso())["backup"]["questions"]
    assert pulled == [result]
    assert call_tool(client.services, "record_get", {"kind": "question", "id": "q"})["record"] == result


def test_simultaneous_disjoint_patches_keep_both_fields(services):
    seed(services)
    barrier = Barrier(2)

    def edit(patch):
        barrier.wait(timeout=5)
        return records.patch_record(services, "subject", "s", patch)

    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(edit, {"name": "User name"}), pool.submit(edit, {"examDate": "2026-12-12"})]
        for future in futures:
            future.result(timeout=5)
    result = records.get_record(services, "subject", "s")
    assert result["name"] == "User name" and result["examDate"] == "2026-12-12"


def test_optional_clear_noop_and_no_resurrection(services):
    seed(services)
    rev = services.store.current_rev()
    same = records.patch_record(services, "subject", "s", {"name": "Networks"})
    assert services.store.current_rev() == rev and "updatedAt" not in same
    assert "examDate" not in records.patch_record(services, "subject", "s", {"examDate": None})
    services.store.delete("question", "q")
    with pytest.raises(LookupError):
        bank.update_question(services, {"id": "q"}, {"prompt": "Cannot resurrect"})
    with pytest.raises(LookupError):
        records.patch_record(services, "question", "q", {"prompt": "Cannot resurrect"})
    assert services.store.tombstone("question", "q") is not None


@pytest.mark.parametrize("patch", [{"id": "other"}, {"createdAt": None}, {"contentHash": "fake"},
                                  {"prompt": None}, {"prompt": 123}, {"options": "bad"},
                                  {"modelAnswer": []}, {"correctOptionIds": [{}]},
                                  {"blanks": [{"id": "b", "accepted": [1]}]}])
def test_invalid_patch_is_atomic(client, patch):
    seed(client.services)
    before = records.get_record(client.services, "question", "q")
    rev = client.services.store.current_rev()
    assert client.patch("/api/bank/records/question/q", json=patch).status_code == 400
    assert records.get_record(client.services, "question", "q") == before
    assert client.services.store.current_rev() == rev


def test_missing_new_and_unknown_kind_do_not_create(client):
    assert client.get("/api/bank/records/subject/new").status_code == 404
    assert client.patch("/api/bank/records/subject/new", json={"name": "Draft"}).status_code == 404
    assert client.get("/api/bank/records/unknown/x").status_code == 400
    assert client.services.store.current_rev() == 0


def test_concept_hash_updates_and_retains_extra_fields(services):
    services.store.put("keyConcept", {"id": "c", "category": "formula", "title": "Area", "content": "a*b",
                                     "custom": {"source": "notes"}})
    result = records.patch_record(services, "keyConcept", "c", {"content": "b*h"})
    assert result["contentHash"] == compute_concept_hash("formula", "Area", "b*h")
    assert result["custom"] == {"source": "notes"}


@pytest.mark.parametrize("kind", ["session", "pdfAnchor", "exam", "deliverable", "gradingConfig", "installedPackage"])
def test_native_table_fields_roundtrip_without_loss(services, kind):
    services.store.put(kind, {"id": "x", "subjectId": "s", "custom": {"version": 2}, "notes": "before"})
    result = call_tool(services, "record_patch", {"kind": kind, "id": "x", "patch": {"notes": "after"}})
    assert result["record"]["custom"] == {"version": 2} and result["record"]["notes"] == "after"


def test_teacher_patch_keeps_separate_sync_channel(services):
    from hypatia.teacher.store import TeacherStore
    store = TeacherStore(services)
    store.put("teacherExam", {"id": "teacher-x", "title": "Initial", "header": {"course": "QA"}})
    result = call_tool(services, "record_patch", {"kind": "teacherExam", "id": "teacher-x", "patch": {"title": "Revised"}})
    assert result["record"]["header"] == {"course": "QA"}
    assert call_tool(services, "record_get", {"kind": "teacherExam", "id": "teacher-x"}) == result
    assert store.changed_since(0)[0]["data"] == result["record"]
    assert services.store.count("exam") == 0
    assert sync.pull(services.store, 0, services.now_iso())["backup"]["exams"] == []
