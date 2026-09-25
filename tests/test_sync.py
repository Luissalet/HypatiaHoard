"""Sync protocol over HTTP: push (deletes + merge) / pull since rev / tombstones / images / state."""

import base64

from test_merge import T0, T1, T2, backup, question, subject, topic


def push(client, b, deletes=(), device="dev-A"):
    r = client.post("/api/sync/push", json={"backup": b, "deletes": list(deletes), "deviceId": device})
    assert r.status_code == 200, r.text
    return r.json()


def test_push_then_pull_round_trip(client):
    b = backup(subjects=[subject("s1", examDate="2027-01-01")], topics=[topic("t1", "s1")],
               questions=[question("q1"), question("q2", prompt="¿UDP?")],
               questionImages={"img.png": {"base64": base64.b64encode(b"\x89PNG").decode(), "mimeType": "image/png"}},
               syncedSettings={"alias": "Luis", "importedPackIds": ["p1"], "studyStreak": 3})
    result = push(client, b)
    assert result["added"] == 5 and result["idMap"] == {"subjects": {}, "topics": {}, "questions": {}}
    everything = client.get("/api/sync/pull", params={"since": 0}).json()
    full = everything["backup"]
    assert full["kind"] == "full-backup" and full["version"] == 2
    assert {q["id"] for q in full["questions"]} == {"q1", "q2"}
    assert full["subjects"][0]["examDate"] == "2027-01-01"
    assert full["syncedSettings"]["alias"] == "Luis" and full["syncedSettings"]["studyStreak"] == 3
    assert base64.b64decode(full["questionImages"]["img.png"]["base64"]) == b"\x89PNG"
    assert everything["rev"] == result["rev"] and everything["tombstones"] == []
    assert client.get("/api/sync/images/img.png").content == b"\x89PNG"
    # Markdown references question-images/<file>: the server answers it too (no 404 before the fallback)
    served = client.get("/question-images/img.png")
    assert served.status_code == 200 and served.content == b"\x89PNG" and served.headers["content-type"] == "image/png"
    assert client.get("/question-images/nope.png").status_code == 404

    rev = everything["rev"]
    nothing = client.get("/api/sync/pull", params={"since": rev}).json()
    assert nothing["backup"]["questions"] == [] and nothing["backup"]["questionImages"] == {}
    assert nothing["backup"]["syncedSettings"]["alias"] == "Luis"  # settings always travel

    push(client, backup(questions=[question("q2", prompt="¿UDP? (editada)", at=T2)]), deletes=[{"kind": "question", "id": "q1", "deletedAt": T1}])
    delta = client.get("/api/sync/pull", params={"since": rev}).json()
    assert [q["id"] for q in delta["backup"]["questions"]] == ["q2"]
    assert delta["tombstones"] == [{"kind": "question", "id": "q1"}]


def test_second_device_with_other_ids_is_deduplicated(client):
    push(client, backup(subjects=[subject("sA", name="Redes")], topics=[topic("tA", "sA")], questions=[question("qA", "sA", "tA")]))
    result = push(client, backup(subjects=[subject("sB", name="REDES")], topics=[topic("tB", "sB")],
                                 questions=[question("qB", "sB", "tB")]), device="dev-B")
    assert result["idMap"] == {"subjects": {"sB": "sA"}, "topics": {"tB": "tA"}, "questions": {"qB": "qA"}}
    state = client.get("/api/sync/state").json()
    assert state["counts"]["questions"] == 1 and state["deviceIds"] == ["dev-B", "dev-A"]
    assert state["lastPushAt"] and state["rev"] >= 3


def test_push_of_deleted_subject_does_not_bring_it_back(client):
    push(client, backup(subjects=[subject("s1")], topics=[topic("t1", "s1")], questions=[question("q1")]))
    client.services.store.delete("subject", "s1")  # cascades with tombstones
    stale = backup(subjects=[subject("s1")], topics=[topic("t1", "s1")], questions=[question("q1")])
    result = push(client, stale, device="dev-old")
    assert result["added"] == 0
    assert client.services.store.count("question") == 0 and client.services.store.count("topic") == 0
    kinds = {t["kind"] for t in client.get("/api/sync/pull", params={"since": 0}).json()["tombstones"]}
    assert kinds == {"subject", "topic", "question"}


def test_delete_of_unknown_id_is_remembered(client):
    push(client, backup(), deletes=[{"kind": "exam", "id": "e-gone", "deletedAt": T1}])
    push(client, backup(exams=[{"id": "e-gone", "subjectId": "s", "name": "x", "questionIds": [], "createdAt": T0, "updatedAt": T0}]))
    assert client.services.store.get("exam", "e-gone") is None


def test_push_rejects_non_backup(client):
    r = client.post("/api/sync/push", json={"backup": {"kind": "nope"}})
    assert r.status_code == 400 and "full-backup" in r.json()["error"]


def test_store_timestamps_are_js_iso(services):
    iso = services.now_iso()
    assert iso == "2026-09-25T10:00:00.123Z"


def test_store_put_of_unchanged_record_keeps_rev(services):
    store = services.store
    q = {"id": "q1", "subjectId": "s1", "prompt": "¿TCP?", "updatedAt": T0}
    first = store.put("question", q)
    assert store.put("question", dict(q)) == first  # same JSON: no new revision
    assert store.current_rev() == first
    assert store.changed_since(first)["question"] == []
    assert store.put("question", {**q, "prompt": "¿UDP?"}) == first + 1


def test_push_of_pulled_backup_is_a_no_op(client):
    push(client, backup(subjects=[subject("s1")], topics=[topic("t1", "s1")],
                        questions=[question("q1"), question("q2", prompt="¿UDP?")]))
    everything = client.get("/api/sync/pull", params={"since": 0}).json()
    rev = everything["rev"]
    result = push(client, everything["backup"], device="dev-B")
    assert result["rev"] == rev and result["added"] == 0 and result["updated"] == 0
    again = client.get("/api/sync/pull", params={"since": rev}).json()
    assert all(again["backup"][k] == [] for k in ("subjects", "topics", "questions"))
    assert again["tombstones"] == [] and again["rev"] == rev
