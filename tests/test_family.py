"""Family features: cards_add keeps source_ref, teacher jobs speak the canonical job events, the agenda answers the contract."""

import json
from datetime import timedelta

import pytest

from hypatia import agent_tools, bank, familyevents
from hypatia.agenda import agenda_items
from hypatia.hoard_link import family
from hypatia.teacher import jobs


@pytest.fixture
def events(monkeypatch):
    sent = []
    monkeypatch.setattr(family, "emit", lambda type_, data=None, **kw: sent.append({"type": type_, "data": data or {}}) or True)
    familyevents._last_progress.clear()
    return sent


# ---------- cards_add and source_ref ----------

def run_cards(services, cards, deck="Lecturas"):
    args = agent_tools.CardsAddArgs(deck=deck, cards=cards)
    return agent_tools.run_cards_add(services, args)


def card(front, back="b", **kw):
    return agent_tools.CardIn(front=front, back=back, **kw)


def test_cards_add_stores_source_ref_with_the_card(services):
    ref = "hoard://links/highlight/0a1b2c"
    out = run_cards(services, [card("Leer es conversar con los muertos", "mi nota\n\n— El arte de leer", tags=["lectura"], source="https://example.com/a", source_ref=ref),
                               card("Sin referencia")])
    assert out["count"] == 2 and out["deck"] == "Lecturas"
    assert out["cards"][0]["source_ref"] == ref and "source_ref" not in out["cards"][1]
    stored = services.store.get("question", out["cards"][0]["id"])
    assert stored["sourceRef"] == ref
    assert stored["prompt"] == "Leer es conversar con los muertos" and stored["origin"] == "alumno"
    assert "sourceRef" not in services.store.get("question", out["cards"][1]["id"])
    assert bank.brief(stored)["sourceRef"] == ref


def test_the_reference_is_not_part_of_the_card(services):
    first = run_cards(services, [card("Misma tarjeta", "respuesta")])
    again = run_cards(services, [card("Misma tarjeta", "respuesta", source_ref="hoard://links/highlight/zz")])
    assert again["cards"][0]["existing"] is True and again["cards"][0]["id"] == first["cards"][0]["id"]
    assert again["cards"][0]["source_ref"] == "hoard://links/highlight/zz", "a duplicate without a reference picks it up"
    assert services.store.get("question", first["cards"][0]["id"])["sourceRef"] == "hoard://links/highlight/zz"
    third = run_cards(services, [card("Misma tarjeta", "respuesta", source_ref="hoard://links/highlight/otra")])
    assert third["cards"][0]["source_ref"] == "hoard://links/highlight/zz", "the first reference stays"


def test_cards_add_over_http_with_source_ref(client):
    body = {"name": "cards_add", "arguments": {"deck": "Lecturas", "cards": [
        {"front": "Anverso", "back": "Reverso", "source_ref": "hoard://links/highlight/abc"}]}}
    r = client.post("/api/agent/call", json=body, headers={"Authorization": f"Bearer {client.services.token}"})
    assert r.status_code == 200, r.text
    result = r.json()
    result = result.get("result", result)
    assert result["cards"][0]["source_ref"] == "hoard://links/highlight/abc"
    tools = client.get("/api/agent/tools").json()["tools"]
    cards = next(t for t in tools if t["name"] == "cards_add")
    assert "source_ref" in json.dumps(cards["inputSchema"])


def test_a_ref_that_is_too_long_is_cut_to_one_short_line(services):
    out = run_cards(services, [card("Larga", source_ref="hoard://x/" + "a" * 400)])
    assert len(services.store.get("question", out["cards"][0]["id"])["sourceRef"]) <= 500
    assert bank.clean_source_ref("a\n b\t c") == "a b c"


# ---------- teacher jobs: canonical events ----------

@pytest.fixture
def job_kinds(monkeypatch):
    """Handlers that finish with each status (the real ones need a model)."""
    def make(status, note=None, boom=False):
        def fn(services, params, ctx):
            ctx.progress(1, 4, "uno")
            ctx.progress(4, 4, "Hecho")
            if boom:
                raise RuntimeError("model exploded")
            return status, {"x": 1}, note
        return fn
    for kind, args in {"t_done": ("done",), "t_nomodel": ("no_model", "Sin modelo local."), "t_nosrc": ("no_sources",),
                       "t_cancel": ("cancelled",)}.items():
        monkeypatch.setitem(jobs.HANDLERS, kind, make(*args))
    monkeypatch.setitem(jobs.HANDLERS, "t_boom", make("done", boom=True))


def run_job(services, kind, params=None):
    job = jobs.create(services, kind, params or {}, submit=False)
    return jobs.run(services, job["id"])


def names(events):
    return [e["type"] for e in events]


def test_a_finished_job_says_queued_started_progress_done(services, events, job_kinds):
    job = run_job(services, "t_done", {"examId": "e1"})
    assert job["status"] == "done"
    assert names(events)[0] == "hypatia.job.queued" and names(events)[1] == "hypatia.job.started"
    assert names(events)[-1] == "hypatia.job.done"
    assert not any(n.startswith("hypatia.teacher_job") for n in names(events)), "only the canonical names"
    done = events[-1]["data"]
    assert done["job_id"] == job["id"] and done["kind"] == "teacher" and done["progress"] == 1.0
    assert done["gpu"] is False and done["error"] == "" and done["job_kind"] == "t_done"
    assert set(done) >= {"job_id", "title", "kind", "progress", "gpu", "eta_s", "url", "error"}
    assert events[0]["data"]["progress"] == 0.0


def test_progress_is_throttled_and_carries_an_eta(services, events, job_kinds, monkeypatch):
    ticks = iter([0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0])
    monkeypatch.setattr(familyevents.time, "monotonic", lambda: next(ticks, 99.0))
    run_job(services, "t_done")
    progress = [e for e in events if e["type"] == "hypatia.job.progress"]
    assert progress, "a progress event reached the bus"
    assert 0 < progress[0]["data"]["progress"] < 1
    assert progress[0]["data"]["eta_s"] is None or progress[0]["data"]["eta_s"] >= 0


def test_progress_events_are_not_sent_more_than_every_three_seconds(services, events, job_kinds):
    run_job(services, "t_done")
    assert len([e for e in events if e["type"] == "hypatia.job.progress"]) == 1, "two quick updates, one event"


def test_no_model_no_sources_and_errors_are_failed_with_the_reason(services, events, job_kinds):
    run_job(services, "t_nomodel")
    failed = [e for e in events if e["type"] == "hypatia.job.failed"][-1]["data"]
    assert failed["error"] == "Sin modelo local." and failed["kind"] == "teacher"

    events.clear()
    run_job(services, "t_nosrc")
    assert events[-1]["type"] == "hypatia.job.failed" and "nothing to work from" in events[-1]["data"]["error"]

    events.clear()
    job = run_job(services, "t_boom")
    assert job["status"] == "error"
    assert events[-1]["type"] == "hypatia.job.failed" and "model exploded" in events[-1]["data"]["error"]

    events.clear()
    run_job(services, "t_cancel")
    assert events[-1]["type"] == "hypatia.job.cancelled"


def test_the_event_title_names_the_exam_and_the_url_opens_it(services, events):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Redes", "createdAt": now, "updatedAt": now})
    from hypatia.teacher.store import teacher_store

    teacher_store(services).put("teacherExam", {"id": "ex1", "subjectId": "s1", "title": "Parcial 1", "header": {}, "items": []})
    services.config.port = 5187
    jobs.create(services, "exam_generate", {"examId": "ex1", "counts": {"TEST": 1}}, submit=False)
    queued = events[0]["data"]
    assert queued["title"] == "Generar preguntas del examen: Parcial 1"
    assert queued["url"] == "http://127.0.0.1:5187/#/teacher/exam/ex1"


def test_a_missing_hub_costs_nothing(services, job_kinds, monkeypatch):
    monkeypatch.setattr(family, "emit", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bus down")))
    assert run_job(services, "t_done")["status"] == "done"


# ---------- the agenda ----------

def mk_subject(services, id_, name, exam=None):
    now = services.now_iso()
    services.store.put("subject", {"id": id_, "name": name, "examDate": exam, "createdAt": now, "updatedAt": now})


def mk_question(services, id_, subject, next_review=None):
    now = services.now_iso()
    services.store.put("question", {"id": id_, "subjectId": subject, "topicId": "t", "type": "DESARROLLO", "prompt": f"p{id_}",
                                    "modelAnswer": "a", "stats": {"seen": 1, "correct": 1, "wrong": 0, **({"nextReviewAt": next_review} if next_review else {})},
                                    "createdAt": now, "updatedAt": now})


def test_agenda_has_exams_deliverables_and_the_cards_due_today(services):
    today = services.now().astimezone().date()
    day = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
    mk_subject(services, "s1", "Redes", exam=day(3))
    mk_subject(services, "s2", "Álgebra", exam=day(40))
    mk_subject(services, "s3", "Sin examen")
    now = services.now_iso()
    services.store.put("deliverable", {"id": "d1", "subjectId": "s1", "name": "Práctica 2", "type": "practica", "dueDate": day(1),
                                       "dueTime": "23:59", "status": "pending", "createdAt": now, "updatedAt": now})
    services.store.put("deliverable", {"id": "d2", "subjectId": "s1", "name": "Hecha", "dueDate": day(1), "status": "done", "createdAt": now, "updatedAt": now})
    for i, nxt in enumerate([services.today(), "2020-01-01", day(9), None]):
        mk_question(services, f"q{i}", "s1", nxt)

    items = agenda_items(services, today, today + timedelta(days=10))
    by_id = {i["id"]: i for i in items}
    assert set(by_id) == {"hypatia:exam:s1", "hypatia:deliverable:d1", f"hypatia:cards:{today.isoformat()}"}, "s2 is out of range, d2 is done"
    exam = by_id["hypatia:exam:s1"]
    assert exam["title"] == "Examen: Redes" and exam["start"] == day(3) and exam["kind"] == "exam" and exam["priority"] == "high"
    d = by_id["hypatia:deliverable:d1"]
    assert d["title"] == "Redes: Práctica 2" and d["start"] == f"{day(1)}T23:59" and d["kind"] == "deadline" and d["priority"] == "high"
    cards = by_id[f"hypatia:cards:{today.isoformat()}"]
    assert cards["title"] == "2 tarjetas para repasar hoy" and cards["all_day"] is True and cards["kind"] == "cards" and cards["start"] == today.isoformat()
    assert [i["start"][:10] for i in items] == sorted(i["start"][:10] for i in items)


def test_no_cards_item_when_nothing_is_due_or_today_is_outside_the_range(services):
    today = services.now().astimezone().date()
    mk_subject(services, "s1", "Redes")
    mk_question(services, "q1", "s1", (today + timedelta(days=5)).isoformat())
    assert agenda_items(services, today, today + timedelta(days=3)) == []
    mk_question(services, "q2", "s1", "2020-01-01")
    assert [i["title"] for i in agenda_items(services, today, today)] == ["1 tarjeta para repasar hoy"]
    assert agenda_items(services, today + timedelta(days=1), today + timedelta(days=3)) == []


def test_teacher_exam_with_a_real_date(services):
    from hypatia.teacher.store import teacher_store

    today = services.now().astimezone().date()
    when = (today + timedelta(days=4)).isoformat()
    mk_subject(services, "s1", "Física")
    store = teacher_store(services)
    store.put("teacherExam", {"id": "ex1", "subjectId": "s1", "title": "Parcial de Física", "header": {"date": when}, "items": []})
    store.put("teacherExam", {"id": "ex2", "subjectId": "s1", "title": "Sin fecha", "header": {"date": "el viernes"}, "items": []})
    store.put("teacherExam", {"id": "ex3", "subjectId": "s1", "title": "Vacío", "header": {"date": ""}, "items": []})
    items = [i for i in agenda_items(services, today, today + timedelta(days=10)) if i["kind"] == "exam"]
    assert [(i["id"], i["title"], i["start"], i["detail"]) for i in items] == [("hypatia:teacher-exam:ex1", "Examen: Parcial de Física", when, "Física")]


def test_the_agenda_route_needs_the_token_and_answers_the_contract(client):
    today = client.services.now().astimezone().date()
    mk_subject(client.services, "s1", "Redes", exam=(today + timedelta(days=2)).isoformat())
    mk_question(client.services, "q1", "s1", "2020-01-01")
    url = f"/api/family/agenda?from={today.isoformat()}&to={(today + timedelta(days=7)).isoformat()}"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.get(url, headers={"Authorization": f"Bearer {client.services.token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["from"] == today.isoformat()
    kinds = {i["kind"] for i in body["items"]}
    assert kinds == {"exam", "cards"}
    assert all(i["id"].startswith("hypatia:") and i["start"] for i in body["items"])
    exam = next(i for i in body["items"] if i["kind"] == "exam")
    assert exam["title"] == "Examen: Redes" and exam["all_day"] is True


def test_manifest_declares_the_agenda():
    from pathlib import Path

    manifest = json.loads((Path(__file__).resolve().parent.parent / "faustus-plugin.json").read_text(encoding="utf-8"))
    assert manifest["x-family"] == {"agenda": True}


def test_a_card_with_a_source_ref_survives_a_sync_round_trip(client):
    from test_merge import backup, question, subject, topic

    q = question("q1")
    q["sourceRef"] = "hoard://links/highlight/abc"
    r = client.post("/api/sync/push", json={"backup": backup(subjects=[subject("s1")], topics=[topic("t1", "s1")], questions=[q]), "deletes": [], "deviceId": "dev-A"})
    assert r.status_code == 200, r.text
    pulled = client.get("/api/sync/pull", params={"since": 0}).json()["backup"]
    assert pulled["questions"][0]["sourceRef"] == "hoard://links/highlight/abc"
