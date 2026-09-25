"""HTTP surface: health, status, OpenAI-compatible proxy, bank, agent call, SPA and resources."""

import json

from fakes import FakeLink

from hypatia import ai


def test_health(client):
    body = client.get("/api/health").json()
    assert body["service"] == "hypatia-hoard" and body["version"] == "2.0.0" and body["dataDirConfigured"] is True
    assert body["hoard_link"]["app"] == "hypatia"


def test_status_models_cached_and_never_failing(client):
    body = client.get("/api/status").json()
    assert body["models"] == {"llm": False, "embeddings": False, "tts": False, "vision": False}
    assert body["service"] == "hypatia-hoard" and body["rev"] == 0
    fake = FakeLink(capabilities=("llm", "tts"))
    client.services.link = lambda: fake
    assert client.get("/api/status").json()["models"]["llm"] is False  # cached for 30 s
    ai.reset_status_cache()
    assert client.get("/api/status").json()["models"] == {"llm": True, "embeddings": False, "tts": True, "vision": False}

    def boom():
        raise RuntimeError("broken config")
    client.services.link = boom
    ai.reset_status_cache()
    assert client.get("/api/status").json()["models"]["llm"] is False


def test_openai_proxy(client):
    r = client.post("/api/ai/v1/chat/completions", json={"messages": [{"role": "user", "content": "hola"}]})
    assert r.status_code == 503 and "error" in r.json()
    fake = FakeLink(chat_handler=lambda messages, **kw: json.dumps({"ok": messages[-1]["content"]}))
    client.services.link = lambda: fake
    r = client.post("/api/ai/v1/chat/completions", json={
        "model": "gpt-4o-mini", "max_tokens": 50, "temperature": 0.2, "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": "s"},
                     {"role": "user", "content": [{"type": "text", "text": "parte"},
                                                  {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw=="}}]}]})
    body = r.json()
    assert r.status_code == 200 and body["object"] == "chat.completion"
    assert json.loads(body["choices"][0]["message"]["content"]) == {"ok": "parte"}
    assert body["usage"]["total_tokens"] == 3 and body["model"] == "fake-llm"
    call = fake.calls[-1]
    assert call["capability"] == "vision" and call["images"] and call["response_format"] == {"type": "json_object"}
    assert call["max_tokens"] == 50


def test_bank_http(client):
    now = client.services.now_iso()
    client.services.store.put("subject", {"id": "s1", "name": "Redes", "createdAt": now, "updatedAt": now})
    r = client.post("/api/bank/questions", json={"subject": "Redes", "questions": [
        {"type": "DESARROLLO", "prompt": "¿Qué es IP?", "modelAnswer": "Protocolo de red."}]})
    assert r.status_code == 200, r.text
    qid = r.json()["questions"][0]["id"]
    assert client.get("/api/bank/subjects").json()["subjects"][0]["questions"] == 1
    assert client.get("/api/bank/subjects/s1/topics").json()["topics"][0]["title"] == "General"
    assert client.get("/api/bank/questions", params={"q": "ip", "subject": "s1"}).json()["count"] == 1
    assert client.patch(f"/api/bank/questions/{qid}", json={"starred": True}).json()["question"]["starred"] is True
    assert client.delete(f"/api/bank/questions/{qid}").status_code == 200
    assert client.delete(f"/api/bank/questions/{qid}").status_code == 404
    assert client.get("/api/bank/questions", params={"type": "NOPE"}).status_code == 400
    assert client.post("/api/study/stats", json={}).json()["subjects"][0]["questions"] == 0


def test_agent_call_needs_token(client):
    body = {"name": "subjects_list", "arguments": {}}
    assert client.post("/api/agent/call", json=body).status_code == 401
    ok = client.post("/api/agent/call", json=body, headers={"Authorization": f"Bearer {client.services.token}"})
    assert ok.status_code == 200 and ok.json() == {"subjects": []}
    missing = client.post("/api/agent/call", json={"name": "topics_list", "arguments": {"subject": "x"}},
                          headers={"Authorization": f"Bearer {client.services.token}"})
    assert missing.status_code == 404 and "error" in missing.json()
    assert client.get("/api/agent/tools").json()["tools"]


def test_token_file_persists(client):
    path = client.services.config.token_path
    assert path.read_text().strip() == client.services.token and len(client.services.token) == 64


def test_spa_and_resources(client):
    assert client.get("/").status_code == 503  # not built yet
    dist = client.services.config.dist_dir
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html>Exam Coach</html>")
    (dist / "assets").mkdir()
    (dist / "assets" / "app.js").write_text("console.log(1)")
    assert "Exam Coach" in client.get("/").text
    assert "Exam Coach" in client.get("/subject/abc").text  # SPA fallback
    assert client.get("/assets/app.js").text == "console.log(1)"
    # A chunk of an older build (still referenced by a cached page) is a 404, never index.html
    missing = client.get("/assets/Notebook-old.js")
    assert missing.status_code == 404 and "Exam Coach" not in missing.text
    assert client.get("/icon-512.png").status_code == 404
    assert client.get("/api/nope").status_code == 404
    res = client.services.config.resources_dir / "redes" / "Temas"
    res.mkdir(parents=True)
    (res / "index.json").write_text('["Tema1.pdf"]')
    assert client.get("/resources/redes/Temas/index.json").json() == ["Tema1.pdf"]
    assert client.head("/resources/redes/Temas/index.json").status_code == 200  # listen mode probes PDFs with HEAD
    assert client.head("/resources/redes/Temas/nope.pdf").status_code == 404
    token = client.services.token
    for sneaky in ("/resources/redes/../../data/mcp-token", "/resources/..%2F..%2Fdata%2Fmcp-token",
                   "/resources/%2e%2e/%2e%2e/data/mcp-token", "/..%2Fdata%2Fmcp-token"):
        r = client.get(sneaky)
        assert token not in r.text and r.status_code in (200, 404), sneaky


def test_resource_index_built_from_the_folder(client):
    """Packages installed with `import-package` bring files but no index.json: the server lists the folder."""
    base = client.services.config.resources_dir / "vision-artificial"
    (base / "Temas").mkdir(parents=True)
    for name in ("Tema10.pdf", "Tema2.pdf", "notas.txt"):
        (base / "Temas" / name).write_bytes(b"%PDF")
    (base / "Examenes" / "2024").mkdir(parents=True)
    (base / "Examenes" / "Final.pdf").write_bytes(b"%PDF")
    (base / "Examenes" / "2024" / "Junio.pdf").write_bytes(b"%PDF")
    assert client.get("/resources/vision-artificial/Temas/index.json").json() == ["Tema2.pdf", "Tema10.pdf"]
    assert client.get("/resources/vision-artificial/Examenes/index.json").json() == {
        "files": [{"name": "Final.pdf", "path": "Final.pdf", "type": "pdf"}],
        "subcategories": [{"name": "2024", "files": [{"name": "Junio.pdf", "path": "2024/Junio.pdf", "type": "pdf"}]}],
    }
    # A hand-written index.json wins; missing folders and other names stay 404.
    (base / "Temas" / "index.json").write_text('[{"topicTitle": "Uno", "pdf": "Tema2.pdf"}]')
    assert client.get("/resources/vision-artificial/Temas/index.json").json() == [{"topicTitle": "Uno", "pdf": "Tema2.pdf"}]
    assert client.get("/resources/vision-artificial/Resumenes/index.json").status_code == 404
    assert client.get("/resources/vision-artificial/extra_info.json").status_code == 404
    assert client.get("/resources/Temas/index.json").status_code == 404


def test_resource_upload_keeps_topic_pdfs_on_the_server(client):
    """A PDF attached to a topic in the app goes to resources/<slug>/Temas, visible from every device."""
    base = client.services.config.resources_dir / "vision-artificial" / "Temas"
    base.mkdir(parents=True)
    (base / "Tema1.pdf").write_bytes(b"%PDF old")  # from import-package
    r = client.put("/api/resources/upload", params={"subject": "Visión Artificial", "filename": "Tema 2.pdf"},
                   content=b"%PDF-1.4 new")
    assert r.status_code == 200 and r.json()["path"] == "resources/vision-artificial/Temas/Tema 2.pdf"
    assert (base / "Tema 2.pdf").read_bytes() == b"%PDF-1.4 new"
    assert client.head("/resources/vision-artificial/Temas/Tema%202.pdf").status_code == 200
    # No index.json yet: the listing comes from the folder, and none is written.
    assert client.get("/resources/vision-artificial/Temas/index.json").json() == ["Tema1.pdf", "Tema 2.pdf"]
    assert not (base / "index.json").exists()
    # A package's hand-written index.json gets the new PDF appended, without a topic title
    # (a title would make the app re-attach it to the topic after the user removes it).
    (base / "index.json").write_text('[{"topicTitle": "Uno", "pdf": "Tema1.pdf"}]')
    client.put("/api/resources/upload", params={"subject": "Visión Artificial", "filename": "Tema3.pdf"}, content=b"%PDF 3")
    client.put("/api/resources/upload", params={"subject": "Visión Artificial", "filename": "Tema3.pdf"}, content=b"%PDF 3b")
    assert client.get("/resources/vision-artificial/Temas/index.json").json() == [
        {"topicTitle": "Uno", "pdf": "Tema1.pdf"}, {"topicTitle": "", "pdf": "Tema3.pdf"}]
    assert (base / "Tema3.pdf").read_bytes() == b"%PDF 3b"


def test_resource_upload_rejects_bad_names(client):
    for params in ({"subject": "VA", "filename": "../../data/mcp-token"}, {"subject": "VA", "filename": ".hidden"},
                   {"subject": "VA", "filename": "index.json"}, {"subject": "VA", "filename": "a.pdf", "category": "../x"},
                   {"subject": "!!!", "filename": "a.pdf"}):
        r = client.put("/api/resources/upload", params=params, content=b"x")
        if params["filename"].startswith("../"):
            # the basename is kept: it lands inside the subject folder, never outside
            assert r.status_code == 200 and r.json()["path"] == "resources/va/Temas/mcp-token"
        else:
            assert r.status_code == 400, params
    assert client.services.config.token_path.read_text().strip() == client.services.token
