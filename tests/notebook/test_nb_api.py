from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hypatia.api.notebook import router
from hypatia.notebook import worker

from nbfakes import FakeLink, FakeState, make_pdf, PAGE_TEXTS


@pytest.fixture
def client(svc):
    app = FastAPI()
    app.state.services = svc
    app.include_router(router)
    with TestClient(app) as c:
        yield c


def _wait_indexed(client, n, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        srcs = client.get("/api/notebook/sources", params={"subject": "sub1"}).json()["sources"]
        if len(srcs) >= n and all(s["status"] != "pending" for s in srcs):
            return srcs
        time.sleep(0.1)
    raise AssertionError("indexing did not finish")


def test_upload_ask_studio_chats(client, svc, tmp_path):
    pdf = make_pdf(tmp_path / "t.pdf", PAGE_TEXTS)
    r = client.put("/api/sources/upload", params={"subject": "sub1", "filename": "Tema 1- Perceptrón.pdf"},
                   content=pdf.read_bytes())
    assert r.status_code == 200, r.text
    assert r.json()["source"]["origin"] == "upload"
    srcs = _wait_indexed(client, 1)
    assert srcs[0]["status"] == "indexed" and srcs[0]["chunks"] >= 3 and srcs[0]["path"] is None

    r = client.post("/api/notebook/ask", json={"subject": "sub1", "question": "¿Qué es el perceptrón?"})
    body = r.json()
    assert r.status_code == 200 and body["answer"] and body["citations"][0]["page"] == 1

    r = client.post("/api/notebook/search", json={"subject": "sub1", "query": "pooling"})
    assert r.json()["passages"][0]["page"] == 3

    r = client.post("/api/notebook/studio", json={"subject": "sub1", "kind": "podcast"})
    item = r.json()["item"]
    for _ in range(100):
        item = client.get(f"/api/notebook/studio/{item['id']}").json()["item"]
        if item["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert item["status"] == "done"
    audio = client.get(item["audioUrl"])
    assert audio.status_code == 200 and audio.content[:4] == b"RIFF"
    assert client.get("/api/notebook/studio", params={"subject": "sub1"}).json()["items"][0]["id"] == item["id"]

    r = client.post("/api/notebook/tutor", json={"subject": "sub1", "message": "Hola", "topic": "tema 1"})
    assert r.status_code == 200 and r.json()["reply"]
    listed = client.get("/api/notebook/chats", params={"subject": "sub1"}).json()["chats"]
    assert {c["mode"] for c in listed} == {"sources", "tutor"}
    cid = listed[0]["id"]
    assert client.get(f"/api/notebook/chats/{cid}").json()["chat"]["messages"]
    assert client.delete(f"/api/notebook/chats/{cid}").json() == {"deleted": True}
    assert client.get(f"/api/notebook/chats/{cid}").status_code == 404

    assert client.delete(f"/api/notebook/studio/{item['id']}").status_code == 200
    assert client.delete(f"/api/notebook/sources/{srcs[0]['id']}").status_code == 200
    assert client.get("/api/notebook/sources", params={"subject": "sub1"}).json()["sources"] == []


def test_studio_conversions_over_http(client, svc, resources):
    r = client.post("/api/notebook/sources/rescan", json={"subject": "sub1"})
    assert r.json()["subjects"]["sub1"]["queued"] == 2
    _wait_indexed(client, 2)
    item = client.post("/api/notebook/studio", json={"subject": "sub1", "kind": "faq"}).json()["item"]
    for _ in range(100):
        item = client.get(f"/api/notebook/studio/{item['id']}").json()["item"]
        if item["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    r = client.post(f"/api/notebook/studio/{item['id']}/to-questions")
    assert r.json()["added"] == 2
    r = client.post(f"/api/notebook/studio/{item['id']}/to-concepts")
    assert r.status_code == 400


def test_errors_and_degraded(client, svc, fake):
    assert client.get("/api/notebook/sources", params={"subject": "nope"}).status_code == 404
    r = client.put("/api/sources/upload", params={"subject": "sub1", "filename": "x.exe"}, content=b"MZ")
    assert r.status_code == 400
    assert client.get("/api/notebook/studio/none").status_code == 404
    assert client.get("/api/notebook/studio/none/audio").status_code == 404
    r = client.post("/api/notebook/studio", json={"subject": "sub1", "kind": "poema"})
    assert r.status_code == 422
    fake.caps["llm"] = False
    r = client.post("/api/notebook/ask", json={"subject": "sub1", "question": "¿perceptrón?"})
    assert r.status_code == 200


def test_real_services_integration(tmp_path, monkeypatch):
    """Uses the core server's Services and create_app when they are importable."""
    try:
        from hypatia.config import Config
        from hypatia.main import create_app
        from hypatia.services import Services
    except ImportError:
        pytest.skip("core server modules not available")
    monkeypatch.setenv("HYPATIA_NOTEBOOK_AUTOSCAN", "1")
    res = tmp_path / "resources"
    config = Config(data_dir=tmp_path / "data", resources_dir=res)
    services = Services(config)
    state = FakeState()
    monkeypatch.setattr(services, "link", lambda: FakeLink(state))
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Procesamiento del Lenguaje Natural",
                                   "createdAt": now, "updatedAt": now})
    services.store.put("topic", {"id": "tp1", "subjectId": "s1", "title": "Tema 1- Introducción", "order": 1,
                                 "pdfFilename": "Tema 1- Introducción.pdf", "createdAt": now, "updatedAt": now})
    make_pdf(res / "procesamiento-del-lenguaje-natural" / "Temas" / "Tema 1- Introducción.pdf",
             ["La tokenización divide el texto en unidades.", "Los embeddings representan palabras como vectores.",
              "Los modelos de lenguaje predicen la siguiente palabra."])
    app = create_app(config, services)
    with TestClient(app, base_url="http://127.0.0.1:5187") as c:
        deadline = time.time() + 15
        srcs = []
        while time.time() < deadline:
            srcs = c.get("/api/notebook/sources", params={"subject": "s1"}).json().get("sources", [])
            if srcs and all(s["status"] == "indexed" for s in srcs):
                break
            time.sleep(0.1)
        assert srcs and srcs[0]["status"] == "indexed" and srcs[0]["origin"] == "repo"
        r = c.post("/api/notebook/ask", json={"subject": "Procesamiento del Lenguaje Natural",
                                              "question": "¿Qué es la tokenización?", "topic": "1"})
        assert r.status_code == 200, r.text
        assert r.json()["citations"][0]["filename"] == "Tema 1- Introducción.pdf"
        gen = c.post("/api/notebook/studio", json={"subject": "s1", "kind": "glossary"}).json()["item"]
        for _ in range(100):
            gen = c.get(f"/api/notebook/studio/{gen['id']}").json()["item"]
            if gen["status"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert gen["status"] == "done"
        assert c.post(f"/api/notebook/studio/{gen['id']}/to-concepts").json()["added"] == 2
        assert len(services.store.list("keyConcept", "s1")) == 2
    assert worker._worker is None  # lifespan stopped the worker
