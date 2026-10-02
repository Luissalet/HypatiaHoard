"""Question generation from the teacher's indexed sources (citations, drafts, approval,
no-model and no-source states), the /api/teacher endpoints the app uses (sync with
last-write-wins and deletions, jobs, transcription, exported files) and the privacy
rule: student data never reaches the study sync."""

import base64
import json

import pytest

from fakes import FakeLink
from hypatia.agent_tools import call_tool
from hypatia.notebook import init_schema, sources
from hypatia.notebook import worker as nb_worker
from hypatia.teacher.store import teacher_store

MATERIAL = """# Astros ficticios

El astro Velarion gira alrededor de la estrella Nubra cada 40 días inventados. Su superficie es de cristal azul.

## Lunas

Velarion tiene dos lunas, Tilo y Mor, que se eclipsan mutuamente cada primavera ficticia.
"""


def call(services, tool_name, **args):
    return call_tool(services, tool_name, args)


def gen_reply(messages, **kwargs):
    system = " ".join(str(m["content"]) for m in messages if m["role"] == "system")
    if "pasajes numerados" in system:
        return json.dumps([
            {"type": "TEST", "prompt": "¿Alrededor de qué estrella gira Velarion?",
             "options": [{"id": "a", "text": "Nubra"}, {"id": "b", "text": "Tilo"}, {"id": "c", "text": "Mor"},
                         {"id": "d", "text": "Sol"}], "correctOptionIds": ["a"], "difficulty": 2, "cita": [1],
             "citaRespuesta": [1]},
            {"type": "DESARROLLO", "prompt": "Describe las lunas de Velarion.", "modelAnswer": "Tilo y Mor, que se eclipsan.",
             "keywords": ["Tilo", "Mor"], "cita": "[1]", "citaRespuesta": [1]},
            {"type": "TEST", "prompt": "Pregunta sin cita", "options": [{"id": "a", "text": "x"}, {"id": "b", "text": "y"}],
             "correctOptionIds": ["a"]},
            {"type": "TEST", "prompt": "Cita inventada", "options": [{"id": "a", "text": "x"}, {"id": "b", "text": "y"}],
             "correctOptionIds": ["a"], "cita": [99]},
        ])
    return "[]"


@pytest.fixture
def indexed(services):
    with services.db.lock:
        init_schema(services.db.conn)
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Ciencias Inventadas", "createdAt": now, "updatedAt": now})
    services.store.put("subject", {"id": "s2", "name": "Vacía Inventada", "createdAt": now, "updatedAt": now})
    services.store.put("topic", {"id": "t1", "subjectId": "s1", "title": "Astros ficticios", "order": 0,
                                 "createdAt": now, "updatedAt": now})
    folder = services.config.resources_dir / "ciencias-inventadas" / "Temas"
    folder.mkdir(parents=True)
    (folder / "Astros ficticios.md").write_text(MATERIAL, encoding="utf-8")
    fake = FakeLink(chat_handler=gen_reply)
    services.link = lambda: fake
    for sid in sources.scan_subject(services, services.store.get("subject", "s1"))["pending"]:
        sources.index_source(services, sid)
    yield services
    nb_worker.stop_worker()


def test_generated_questions_are_cited_drafts_until_approved(indexed):
    out = call(indexed, "exam_generate", subject="Ciencias", topics=["1"], counts={"TEST": 1, "DESARROLLO": 1},
               source="generate", versions=2, wait_s=20)
    job = out["job"]
    assert job["status"] == "done" and job["result"]["generated"] == 2 and job["result"]["dropped"] == 2
    drafts = out["exam"]["drafts"]
    assert [d["status"] for d in drafts] == ["pending", "pending"] and not out["exam"]["items"]
    cite = drafts[0]["citations"][0]
    assert cite["filename"] == "Astros ficticios.md" and cite["n"] == 1 and "Velarion" in cite["snippet"]
    assert drafts[1]["answerCitations"]
    assert indexed.store.count("question") == 0  # nothing in the bank before approval

    rejected = call(indexed, "exam_drafts_review", exam=out["exam"]["id"], reject=[drafts[1]["id"]])
    assert rejected["rejected"] == [drafts[1]["id"]] and not rejected["added"]
    approved = call(indexed, "exam_drafts_review", exam=out["exam"]["id"], accept="all")
    assert len(approved["added"]) == 1 and len(approved["exam"]["items"]) == 1
    question = indexed.store.get("question", approved["added"][0])
    assert "Fuente: Astros ficticios.md" in question["explanation"] and "profesor" in question["tags"]
    assert question["topicId"] == "t1" and question["origin"] == "test"
    exam = call(indexed, "exam_get", exam=out["exam"]["id"])["exam"]
    assert len(exam["versions"]) == 2 and exam["practiceExamId"]


def test_generation_states_no_model_and_no_sources(indexed):
    empty = call(indexed, "exam_generate", subject="Vacía", counts={"TEST": 2}, source="generate", wait_s=20)
    assert empty["job"]["status"] == "no_sources" and "No hay fuentes" in empty["job"]["note"]
    offline = FakeLink(capabilities=("embeddings",))
    indexed.link = lambda: offline
    res = call(indexed, "exam_generate", subject="Ciencias", counts={"TEST": 1}, source="mixed", wait_s=20)
    assert res["job"]["status"] == "no_model" and "Velarion" in res["job"]["result"]["material"]
    assert not res["exam"]["drafts"]


# ---------------------------------------------------------------- API

def rec(kind, id, updated, data=None, deleted=False):
    return {"kind": kind, "id": id, "updatedAt": updated, "deleted": deleted,
            "data": None if deleted else {"id": id, **(data or {}), "updatedAt": updated}}


def test_teacher_sync_last_write_wins_and_deletions(client):
    push = client.post("/api/teacher/sync/push", json={"records": [
        rec("class", "c1", "2026-09-25T10:00:00.000Z", {"name": "3º C"}),
        rec("student", "st1", "2026-09-25T10:00:00.000Z", {"classId": "c1", "displayName": "Eva Ficticia"}),
        rec("nope", "x", "2026-09-25T10:00:00.000Z", {})]}).json()
    assert push["applied"] == 2
    pulled = client.get("/api/teacher/sync/pull?since=0").json()
    assert {r["id"] for r in pulled["records"]} == {"c1", "st1"} and pulled["rev"] == push["rev"]
    older = client.post("/api/teacher/sync/push", json={"records": [
        rec("class", "c1", "2026-09-24T10:00:00.000Z", {"name": "viejo"})]}).json()
    assert older["applied"] == 0 and older["stale"] == [{"kind": "class", "id": "c1"}]
    newer = client.post("/api/teacher/sync/push", json={"records": [
        rec("class", "c1", "2026-09-26T10:00:00.000Z", {"name": "3º C bis"}),
        rec("student", "st1", "2026-09-26T10:00:00.000Z", deleted=True)]}).json()
    assert newer["applied"] == 2
    since = client.get(f"/api/teacher/sync/pull?since={push['rev']}").json()["records"]
    by_id = {r["id"]: r for r in since}
    assert by_id["c1"]["data"]["name"] == "3º C bis" and by_id["st1"]["deleted"] is True and by_id["st1"]["data"] is None
    state = client.get("/api/teacher/sync/state").json()
    assert state["counts"]["class"] == 1 and state["counts"]["student"] == 0


def test_jobs_endpoint_needs_synced_records(client):
    assert client.post("/api/teacher/jobs", json={"kind": "exam_generate", "params": {"examId": "nope"}}).status_code == 404
    assert client.post("/api/teacher/jobs", json={"kind": "grading_run", "params": {"batchId": "nope"}}).status_code == 404
    assert client.get("/api/teacher/jobs/nope").status_code == 404
    assert client.get("/api/teacher/jobs?active=true").json() == {"jobs": []}


def test_transcribe_with_and_without_vision(client):
    image = base64.b64encode(b"\x89PNG fake image bytes").decode()
    res = client.post("/api/teacher/transcribe", json={"image": image}).json()
    assert res["status"] == "no_model" and res["text"] is None
    fake = FakeLink(chat_handler=lambda messages, **kw: "La respuesta escrita a mano.")
    client.services.link = lambda: fake
    res = client.post("/api/teacher/transcribe", json={"image": "data:image/png;base64," + image}).json()
    assert res["status"] == "ok" and res["text"] == "La respuesta escrita a mano."
    sent = fake.calls[-1]
    assert sent["capability"] == "vision" and sent["images"] == [b"\x89PNG fake image bytes"]


def test_rubric_propose_endpoint_and_files(client):
    res = client.post("/api/teacher/rubrics/propose", json={"question": {"type": "PRACTICO", "prompt": "Calcula",
                                                                         "numericAnswer": "42"}, "points": 2}).json()
    assert res["status"] == "no_model" and res["rubric"]["criteria"][2]["levels"][1]["descriptor"].endswith("(42)")
    assert client.get("/api/teacher/files/..%2F..%2Fmcp-token").status_code == 404
    assert client.get("/api/teacher/files/nada.pdf").status_code == 404
    exports = client.services.config.data_dir / "teacher" / "exports"
    exports.mkdir(parents=True)
    (exports / "notas-x.csv").write_text("Alumno;Nota\n", encoding="utf-8")
    got = client.get("/api/teacher/files/notas-x.csv")
    assert got.status_code == 200 and got.text.startswith("Alumno")


def test_student_data_never_reaches_the_study_sync(client):
    svc = client.services
    now = svc.now_iso()
    svc.store.put("subject", {"id": "s1", "name": "Ciencias Inventadas", "createdAt": now, "updatedAt": now})
    call(svc, "questions_add", subject="s1", questions=[
        {"type": "TEST", "prompt": "¿Uno?", "options": [{"id": "a", "text": "Sí"}, {"id": "b", "text": "No"}],
         "correctOptionIds": ["a"]}])
    call(svc, "teacher_class_create", name="4º D")
    call(svc, "teacher_students_add", **{"class": "4D", "students": ["Zoe Inventadísima"]})
    exam = call(svc, "exam_generate", subject="s1", counts={"TEST": 1}, source="bank")["exam"]
    call(svc, "grading_batch_create", exam=exam["id"], **{"class": "4D"})
    call(svc, "grading_submit_answers", batch=exam["id"], student="Zoe", answers={"1": "a"})
    call(svc, "grading_confirm", batch=exam["id"], student="Zoe")
    call(svc, "class_reinforce", **{"class": "4D", "student": "Zoe"})
    pulled = json.dumps(client.get("/api/sync/pull?since=0").json(), ensure_ascii=False)
    assert "Zoe" not in pulled and "Inventadísima" not in pulled and "4º D" not in pulled
    assert "submission" not in pulled and "studentId" not in pulled
    state = client.get("/api/sync/state").json()
    assert set(state["counts"]) == {"subjects", "topics", "questions", "sessions", "pdfAnchors", "keyConcepts", "exams",
                                    "deliverables", "gradingConfigs", "installedPackages"}
    assert teacher_store(svc).counts()["submission"] == 1
