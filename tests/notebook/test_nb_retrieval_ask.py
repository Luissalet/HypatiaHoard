from __future__ import annotations

from hypatia.notebook import ask, chats, retrieval, sources


def test_search_returns_cited_passages_with_pages(indexed):
    found = retrieval.search(indexed, "sub1", "¿Qué es la retropropagación de gradientes?")
    top = found["passages"][0]
    assert top["n"] == 1 and top["filename"] == "Tema 1- Perceptrón.pdf" and top["page"] == 2
    assert "retropropagación" in top["text"].lower()
    assert top["snippet"]


def test_search_accent_insensitive_and_morphology(indexed):
    found = retrieval.search(indexed, "sub1", "perceptron neuronales")
    assert found["passages"] and found["passages"][0]["page"] == 1


def test_topic_filter_by_pdf_filename(indexed):
    found = retrieval.search(indexed, "sub1", "convolucionales imágenes", topic="t1")
    assert {p["filename"] for p in found["passages"]} == {"Tema 1- Perceptrón.pdf"}
    # topic without a matching source falls back to the whole subject with a note
    found = retrieval.search(indexed, "sub1", "convolucionales", topic="tema 2")
    assert found["note"] and "Ninguna fuente" in found["note"]
    assert any(p["filename"] == "resumen.md" for p in found["passages"])


def test_source_ids_filter_and_no_hits(indexed):
    md = next(s for s in sources.list_sources(indexed, "sub1") if s["filename"] == "resumen.md")
    found = retrieval.search(indexed, "sub1", "perceptrón convolucionales", source_ids=[md["id"]])
    assert {p["sourceId"] for p in found["passages"]} == {md["id"]}
    none = retrieval.search(indexed, "sub1", "zzzz qqqq")
    assert none["passages"] == [] and none["note"]


def test_apply_citations_drops_invented_numbers():
    passages = [{"n": 1, "sourceId": "s", "filename": "a.pdf", "title": "A", "page": 3, "text": "uno"},
                {"n": 2, "sourceId": "s", "filename": "a.pdf", "title": "A", "page": 4, "text": "dos"}]
    text, cites = retrieval.apply_citations("Hola [1]. Mundo [2, 7]. Falso [9]. Rango [1-2]. Año [2023].", passages)
    assert text == "Hola [1]. Mundo [2]. Falso. Rango [1][2]. Año [2023]."
    assert [c["n"] for c in cites] == [1, 2] and cites[0]["page"] == 3


def test_vector_rerank_used_when_embeddings(svc, resources, fake):
    fake.caps["embeddings"] = True
    counts = sources.scan_subject(svc, svc.store.get("subject", "sub1"))
    for sid in counts["pending"]:
        sources.index_source(svc, sid)
    found = retrieval.search(svc, "sub1", "filtros compartidos para imágenes convolucionales")
    assert found["reranked"] is True
    assert found["passages"][0]["page"] == 3 or found["passages"][0]["filename"] == "resumen.md"


def test_ask_with_model_maps_citations_and_persists(indexed, fake):
    out = ask.ask(indexed, "Redes Neuronales y Aprendizaje Profundo", "¿Qué es el perceptrón y el descenso de gradiente?")
    assert out["model"] == "fake-llm"
    assert "[42]" not in out["answer"] and "[99]" not in out["answer"]
    assert "[1]" in out["answer"] and "[2]" in out["answer"]
    assert [c["n"] for c in out["citations"]] == [1, 2]
    assert all(c["filename"] and c["snippet"] for c in out["citations"])
    chat = chats.get_chat(indexed, out["chatId"])
    assert chat["mode"] == "sources" and [m["role"] for m in chat["messages"]] == ["user", "assistant"]
    assert chat["messages"][1]["citations"][0]["n"] == 1
    # a follow-up reuses the chat and sends history
    out2 = ask.ask(indexed, "sub1", "¿Y cómo se entrena?", chat_id=out["chatId"])
    assert out2["chatId"] == out["chatId"]
    assert fake.calls[-1]["n_messages"] == 4
    assert chats.list_chats(indexed, "sub1")[0]["id"] == out["chatId"]


def test_ask_without_model_returns_passages(indexed, fake):
    fake.caps["llm"] = False
    out = ask.ask(indexed, "sub1", "¿Qué es el perceptrón?")
    assert out["answer"] is None and out["passages"] and out["note"]
    assert out["passages"][0]["text"] and out["passages"][0]["n"] == 1


def test_ask_without_sources_does_not_call_model(svc, fake):
    out = ask.ask(svc, "sub1", "¿Qué es el perceptrón?")
    assert out["answer"] and out["citations"] == [] and not fake.calls
