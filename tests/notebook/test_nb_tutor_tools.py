from __future__ import annotations

import json

from pydantic import BaseModel

from hypatia.notebook import NOTEBOOK_TOOLS, chats, tutor
from hypatia.tooling import Tool

EXPECTED_TOOLS = {"notebook_sources", "source_add", "notebook_search", "notebook_ask", "studio_generate",
                  "studio_get", "studio_list", "tutor_turn"}


def _questions(svc):
    base = {"subjectId": "sub1", "topicId": "t1", "type": "DESARROLLO", "createdAt": "x", "updatedAt": "x"}
    svc.store.put("question", {**base, "id": "q-good", "prompt": "Bien sabida", "modelAnswer": "a",
                               "stats": {"seen": 5, "correct": 5, "wrong": 0, "lastResult": "CORRECT"}})
    svc.store.put("question", {**base, "id": "q-bad", "prompt": "¿Qué función aplica el perceptrón?",
                               "modelAnswer": "La función escalón",
                               "stats": {"seen": 4, "correct": 1, "wrong": 3, "lastResult": "WRONG"}})
    svc.store.put("question", {**base, "id": "q-new", "prompt": "Nunca vista", "stats": {"seen": 0, "correct": 0, "wrong": 0}})
    svc.store.put("question", {**base, "id": "q-other", "topicId": "t2", "prompt": "Otro tema",
                               "stats": {"seen": 3, "correct": 0, "wrong": 3, "lastResult": "WRONG"}})


def test_weak_questions_order_and_topic(indexed):
    _questions(indexed)
    weak = tutor.weak_questions(indexed, "sub1", "t1")
    assert [w["id"] for w in weak] == ["q-bad", "q-new", "q-good"]
    assert weak[0]["expected"] == "La función escalón" and weak[0]["accuracy"] == 0.25


def test_tutor_three_fails_then_explains(indexed, fake):
    _questions(indexed)
    fake.tutor_assessments = ["none", "wrong", "wrong", "wrong"]
    t1 = tutor.turn(indexed, "sub1", "Empecemos", topic="tema 1")
    cid = t1["chatId"]
    assert t1["reply"].startswith("¿Qué hace el perceptrón?") and "[88]" not in t1["reply"]
    assert t1["citations"] and t1["citations"][0]["n"] == 1
    first_user = fake.calls[0]["user"]
    assert "¿Qué función aplica el perceptrón?" in first_user and "Respuesta esperada (interna)" in first_user
    t2 = tutor.turn(indexed, "sub1", "No sé", chat_id=cid)
    assert t2["state"]["attempts"] == 1 and not t2["explained"]
    t3 = tutor.turn(indexed, "sub1", "¿Suma?", chat_id=cid)
    assert t3["state"]["attempts"] == 2
    t4 = tutor.turn(indexed, "sub1", "Ni idea", chat_id=cid)
    assert t4["explained"] is True and t4["state"]["attempts"] == 0
    assert "combina entradas ponderadas [1]" in t4["reply"]
    assert any("ha fallado" in c["system"] for c in fake.calls)
    chat = chats.get_chat(indexed, cid)
    assert chat["mode"] == "tutor" and len(chat["messages"]) == 8 and chat["topicId"] == "t1"


def test_tutor_correct_resets_attempts(indexed, fake):
    fake.tutor_assessments = ["wrong", "correct"]
    a = tutor.turn(indexed, "sub1", "respuesta mala")
    assert a["state"]["attempts"] == 1
    b = tutor.turn(indexed, "sub1", "respuesta buena", chat_id=a["chatId"])
    assert b["state"]["attempts"] == 0


def test_tutor_without_model(indexed, fake):
    _questions(indexed)
    fake.caps["llm"] = False
    out = tutor.turn(indexed, "sub1", "Empecemos", topic="t1")
    assert out["reply"] is None and out["passages"] and out["weak"][0]["id"] == "q-bad" and out["note"]


def test_tool_catalog_shape():
    assert {t.name for t in NOTEBOOK_TOOLS} == EXPECTED_TOOLS
    for t in NOTEBOOK_TOOLS:
        assert isinstance(t, Tool)
        first = t.description.splitlines()[0]
        assert len(first) <= 110, (t.name, len(first))
        assert t.description.splitlines()[-1].startswith("Sinónimos:"), t.name
        assert issubclass(t.input_model, BaseModel)
        json.dumps(t.input_model.model_json_schema())
        assert set(t.annotations) >= {"readOnlyHint", "destructiveHint", "idempotentHint"}
    ro = {t.name for t in NOTEBOOK_TOOLS if t.annotations["readOnlyHint"]}
    assert ro == {"notebook_sources", "notebook_search", "studio_get", "studio_list"}


def _tool(name):
    return next(t for t in NOTEBOOK_TOOLS if t.name == name)


def _call(svc, name, **args):
    t = _tool(name)
    return t.run(svc, t.input_model(**args))


def test_tools_end_to_end_with_model(svc, resources, fake, tmp_path):
    from hypatia.notebook import sources

    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    for sid in counts["pending"]:
        sources.index_source(svc, sid)
    (tmp_path / "extra").mkdir()
    (tmp_path / "extra" / "atencion.md").write_text("# Atención\n\nLa atención pondera tokens.", encoding="utf-8")
    added = _call(svc, "source_add", subject="sub1", path=str(tmp_path / "extra"), wait_s=10)
    assert added["sources"][0]["status"] == "indexed"
    listed = _call(svc, "notebook_sources", subject="Redes Neuronales y Aprendizaje Profundo")
    assert listed["indexed"] == 3
    found = _call(svc, "notebook_search", subject="sub1", query="atención tokens")
    assert found["passages"][0]["filename"] == "atencion.md" and found["passages"][0]["text"]
    ans = _call(svc, "notebook_ask", subject="sub1", question="¿Qué es el perceptrón?")
    assert ans["answer"] and ans["chatId"]
    gen = _call(svc, "studio_generate", subject="sub1", kind="glossary", wait_s=20)
    assert gen["item"]["status"] == "done" and gen["item"]["data"]
    got = _call(svc, "studio_get", id=gen["item"]["id"])
    assert got["item"]["id"] == gen["item"]["id"]
    assert _call(svc, "studio_list", subject="sub1")["items"][0]["kind"] == "glossary"
    turn = _call(svc, "tutor_turn", subject="sub1", message="Hola")
    assert turn["reply"] and turn["chatId"]
    bad = _call(svc, "source_add", subject="sub1", path=str(tmp_path / "no-existe"), wait_s=0)
    assert bad["errors"] and bad["sources"] == []


def test_tools_degrade_without_model(indexed, fake):
    fake.caps["llm"] = False
    ans = _call(indexed, "notebook_ask", subject="sub1", question="¿Qué es el perceptrón?")
    assert ans["answer"] is None and ans["passages"] and ans["note"]
    gen = _call(indexed, "studio_generate", subject="sub1", kind="podcast", wait_s=5)
    assert gen["item"] is None and gen["material"] and gen["note"]
    turn = _call(indexed, "tutor_turn", subject="sub1", message="Hola")
    assert turn["reply"] is None and turn["note"]
    found = _call(indexed, "notebook_search", subject="sub1", query="perceptrón")
    assert found["passages"]
