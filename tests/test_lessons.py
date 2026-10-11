"""Guided lessons from a document: sections, concepts (model and rules), interleaved questions, mastery per concept."""

import json

import pytest

from fakes import FakeLink
from hypatia import lessons
from hypatia.agent_tools import TOOLS_BY_NAME, call_tool

DOC = """# Redes de computadores

Una red de computadores es un conjunto de equipos conectados que comparten recursos y se comunican entre si.
Las redes permiten compartir ficheros, impresoras y acceso a internet entre muchos usuarios a la vez.

## Modelo OSI

El modelo OSI es un modelo de referencia que divide la comunicacion en siete capas independientes.
La **capa de transporte** se encarga de la entrega fiable de los datos entre extremos de la comunicacion.
Cada capa ofrece servicios a la capa superior y usa los de la inferior para cumplir su funcion.

## Direccionamiento IP

Una direccion IP es un identificador numerico que localiza a un equipo dentro de una red.
Mascara de red: valor que separa la parte de red y la parte de equipo de una direccion IP.
"""


def call(services, name, **args):
    return call_tool(services, name, args)


def model_reply(messages, **_):
    system = messages[0]["content"]
    user = messages[1]["content"]
    assert "lección guiada" in system
    if "Modelo OSI" in user:
        return json.dumps({"concepts": [
            {"name": "Capas OSI", "summary": "Siete capas independientes que dividen la comunicacion.",
             "question": {"type": "TEST", "prompt": "¿Cuantas capas tiene el modelo OSI?",
                          "options": [{"id": "a", "text": "Siete"}, {"id": "b", "text": "Cuatro"}], "correctOptionIds": ["a"]}},
            {"name": "Capa de transporte", "summary": "Entrega fiable entre extremos.",
             "question": {"type": "TEST", "prompt": "Mala sin opciones"}},
            "basura",
        ]})
    if "Direccionamiento" in user:
        return "no es JSON"
    return json.dumps({"concepts": [{"name": "Red de computadores", "summary": "Equipos conectados que comparten recursos."}]})


def test_tools_registered():
    for name in ("lesson_from_document", "lesson_get", "concept_mastery", "lesson_delete"):
        tool = TOOLS_BY_NAME[name]
        assert len(tool.description.split("\n", 1)[0]) <= 110 and "Sinónimos:" in tool.description
    assert TOOLS_BY_NAME["concept_mastery"].annotations["readOnlyHint"] is True
    assert TOOLS_BY_NAME["lesson_delete"].annotations["destructiveHint"] is True


def test_split_sections_by_headings_and_fallbacks():
    sections = lessons.split_sections(DOC)
    assert [s["title"] for s in sections] == ["Redes de computadores", "Modelo OSI", "Direccionamiento IP"]
    assert [s["n"] for s in sections] == [1, 2, 3]
    # numbered, word and ALL-CAPS headings
    text = ("1. Introduccion al tema\n" + "Texto de introduccion largo. " * 12 + "\n\nTEMA 2 Resultados\n" + "Mas texto del tema. " * 15
            + "\n\nCONCLUSIONES FINALES\n" + "Cierre del documento con ideas. " * 10)
    titles = [s["title"] for s in lessons.split_sections(text)]
    assert titles[0].startswith("1. Introduccion") and any("Tema 2" in t or "TEMA 2" in t for t in titles) and "Conclusiones Finales" in titles
    # no headings: paragraph blocks; and a hard cap on the count
    plain = "\n\n".join(f"Parrafo numero {i} " + "palabra " * 120 for i in range(30))
    blocks = lessons.split_sections(plain, max_sections=5)
    assert len(blocks) == 5 and all(b["text"] for b in blocks)
    assert lessons.split_sections("Texto corto sin estructura " * 3)[0]["title"] == "Documento"


def test_unmarked_headings_as_a_pdf_gives_them():
    pdf_text = ("Redes de computadores\nUna red de computadores es un conjunto de equipos conectados que comparten recursos.\n"
                "Las redes permiten compartir ficheros, impresoras y acceso a internet entre muchos usuarios.\n"
                "Modelo OSI\nEl modelo OSI es un modelo de referencia que divide la comunicacion en siete capas. La capa de\n"
                "transporte se encarga de la entrega fiable de los datos.\n"
                "Cada capa ofrece servicios\na la capa superior.\n"
                "Direccionamiento IP\nUna direccion IP es un identificador numerico que localiza a un equipo dentro de una red.")
    sections = lessons.split_sections(pdf_text)
    assert [s["title"] for s in sections] == ["Redes de computadores", "Modelo OSI", "Direccionamiento IP"]
    # a wrapped sentence fragment is not a heading
    assert "Cada capa ofrece servicios" in sections[1]["text"]


def test_rules_extract_definitions_bold_and_colon():
    section = lessons.split_sections(DOC)[1]
    names = [c["name"] for c in lessons.heuristic_concepts(section, "es")]
    assert "Modelo OSI" in names and "Capa de transporte" in names
    ip = [c["name"] for c in lessons.heuristic_concepts(lessons.split_sections(DOC)[2], "es")]
    assert "Direccion IP" in ip and "Mascara de red" in ip
    assert lessons.detect_language("The model is a reference of the layers and it is in use") == "en"
    assert lessons.detect_language("El modelo es una referencia de las capas") == "es"


def test_lesson_without_model_degrades_to_rules(services):
    out = call(services, "lesson_from_document", subject="Redes", text=DOC)
    assert out["saved"] and not out["existing"] and out["subjectCreated"] and out["lesson"]["model"] is None
    assert "deterministic rules" in out["note"]
    lesson = out["lesson"]
    assert len(lesson["sections"]) == 3 and len(lesson["concepts"]) >= 5
    assert all(c["questionIds"] and c["section"] in (1, 2, 3) for c in lesson["concepts"])
    q = services.store.get("question", lesson["concepts"][0]["questionIds"][0])
    assert q["type"] == "DESARROLLO" and "leccion" in q["tags"] and q["modelAnswer"]
    # the questions are real cards, in a topic named after the lesson
    topic = services.store.get("topic", lesson["topicId"])
    assert topic["title"] == "Redes de computadores"
    assert call(services, "cards_due", subject="Redes")["totals"]["neverSeen"] == len(lesson["concepts"])
    # idempotent per document
    again = call(services, "lesson_from_document", subject="Redes", text=DOC)
    assert again["existing"] and again["lesson"]["id"] == lesson["id"]
    assert services.store.count("question") == len(lesson["concepts"])


def test_lesson_with_fake_model(services):
    fake = FakeLink(chat_handler=model_reply)
    services.link = lambda: fake
    out = call(services, "lesson_from_document", subject="Redes", text=DOC, title="Redes", as_page_card=True)
    lesson = out["lesson"]
    assert lesson["model"] == "model" and lesson["title"] == "Redes"
    names = [c["name"] for c in lesson["concepts"]]
    # section 2 from the model (the invalid items are dropped; a concept with a bad question gets a rule question),
    # section 3 had unusable JSON -> rules; section 1 from the model
    assert names[:1] == ["Red de computadores"] and "Capas OSI" in names and "Capa de transporte" in names
    assert "Direccion IP" in names and "Mascara de red" in names
    assert "replied nothing usable" in out["note"]
    test_q = services.store.get("question", next(c for c in lesson["concepts"] if c["name"] == "Capas OSI")["questionIds"][0])
    assert test_q["type"] == "TEST" and test_q["correctOptionIds"] == ["a"]
    fallback_q = services.store.get("question", next(c for c in lesson["concepts"] if c["name"] == "Capa de transporte")["questionIds"][0])
    assert fallback_q["type"] == "DESARROLLO"
    # one chat per section, with the lesson prompt; the page card is a reviewable HTML lesson
    assert [c["kind"] for c in fake.calls] == ["chat"] * 3
    assert lesson["pageCardId"] and services.store.get("question", lesson["pageCardId"])["pageHtml"]


def test_use_model_false_and_preview_store_nothing(services):
    fake = FakeLink(chat_handler=model_reply)
    services.link = lambda: fake
    off = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False, save=False)
    assert off["preview"] and not off["saved"] and fake.calls == []
    assert "text" in off["lesson"]["sections"][0] and off["lesson"]["concepts"][0]["question"]["prompt"]
    assert services.store.count("question") == 0 and lessons.list_lessons(services) == []


def test_input_errors(services):
    with pytest.raises(ValueError, match="exactly one"):
        call(services, "lesson_from_document", subject="Redes")
    with pytest.raises(ValueError, match="exactly one"):
        call(services, "lesson_from_document", subject="Redes", text="x" * 100, path="a.pdf")
    with pytest.raises(ValueError, match="too short"):
        call(services, "lesson_from_document", subject="Redes", text="corto")
    with pytest.raises(ValueError, match="No file"):
        call(services, "lesson_from_document", subject="Redes", path="C:/no/existe.pdf")
    with pytest.raises(LookupError):
        call(services, "lesson_get", lesson="inexistente")


def test_read_document_from_file(services, tmp_path):
    md = tmp_path / "apuntes.txt"
    md.write_text(DOC, encoding="utf-8")
    out = call(services, "lesson_from_document", subject="Redes", path=str(md), use_model=False)
    assert out["lesson"]["source"] == "apuntes.txt" and len(out["lesson"]["sections"]) == 3


def test_lesson_get_flow_and_sections(services):
    made = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False)["lesson"]
    listing = call(services, "lesson_get")
    assert listing["count"] == 1 and listing["lessons"][0]["concepts"] == len(made["concepts"])
    flow = call(services, "lesson_get", lesson="redes de comp")
    steps = [s["step"] for s in flow["flow"]]
    assert steps[0] == "read" and "question" in steps and steps.index("question") == 1
    assert all("modelAnswer" not in s["question"] for s in flow["flow"] if s["step"] == "question")
    one = call(services, "lesson_get", lesson=made["id"], section=2, with_answers=True)
    assert one["section"]["title"] == "Modelo OSI" and "siete capas" in one["section"]["text"]
    assert all(s["section"] == 2 for s in one["flow"]) and "modelAnswer" in one["flow"][1]["question"]
    with pytest.raises(LookupError, match="sections 1..3"):
        call(services, "lesson_get", lesson=made["id"], section=9)


def review(services, prompt, grade):
    return call(services, "card_review", prompt=prompt, grade=grade)


def test_mastery_from_review_history(services, clock):
    made = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False)["lesson"]
    fresh = call(services, "concept_mastery", lesson=made["id"])
    assert fresh["mastery"] == 0 and fresh["levels"]["sin ver"] == len(made["concepts"])
    a, b, c = made["concepts"][:3]
    prompt = lambda concept: services.store.get("question", concept["questionIds"][0])["prompt"]  # noqa: E731
    # a: three good answers -> dominated; b: one good -> in progress (confidence 1/3); c: wrong -> weak
    for _ in range(3):
        review(services, prompt(a), "good")
        clock.advance(seconds=60)
    review(services, prompt(b), "good")
    review(services, prompt(c), "again")
    rows = {r["conceptId"]: r for r in call(services, "concept_mastery", lesson=made["id"])["concepts"]}
    assert rows[a["id"]]["level"] == "dominado" and rows[a["id"]]["mastery"] > 0.99 and rows[a["id"]]["evidence"] == "reviews"
    assert rows[b["id"]]["level"] == "en progreso" and 0.3 < rows[b["id"]]["mastery"] < 0.34
    assert rows[c["id"]]["level"] == "débil" and rows[c["id"]]["mastery"] == 0 and rows[c["id"]]["lastResult"] == "WRONG"
    # a failure after a long time hurts more than an old success helps: recency weighting
    clock.advance(days=28)
    review(services, prompt(a), "again")
    after = {r["conceptId"]: r for r in call(services, "concept_mastery", lesson=made["id"])["concepts"]}
    assert after[a["id"]]["mastery"] < 0.5 and after[a["id"]]["level"] == "débil" and after[a["id"]]["dueNow"] is False
    overall = call(services, "concept_mastery", subject="Redes")
    assert overall["count"] == 1 and overall["weakestConcepts"][0]["mastery"] == 0
    assert c["name"] in overall["lessons"][0]["weakest"]
    # the lesson list carries the same mastery, and teaching shows each concept's level
    assert call(services, "lesson_get")["lessons"][0]["mastery"] == call(services, "concept_mastery", lesson=made["id"])["mastery"]
    with pytest.raises(ValueError, match="lesson or a subject"):
        call(services, "concept_mastery")


def test_mastery_falls_back_to_pwa_stats(services):
    made = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False)["lesson"]
    concept = made["concepts"][0]
    q = services.store.get("question", concept["questionIds"][0])
    services.store.put("question", {**q, "stats": {"seen": 4, "correct": 3, "wrong": 1, "lastResult": "CORRECT",
                                                   "lastSeenAt": "2026-09-24T10:00:00.000Z"}})
    row = call(services, "concept_mastery", lesson=made["id"])["concepts"][0]
    assert row["evidence"] == "stats" and row["attempts"] == 4 and row["accuracy"] == 0.75 and row["level"] == "dominado"


def test_delete_lesson_keeps_or_removes_questions(services):
    made = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False)["lesson"]
    n = len(made["concepts"])
    gone = call(services, "lesson_delete", lesson=made["id"])
    assert gone["questionsDeleted"] == 0 and services.store.count("question") == n and lessons.list_lessons(services) == []
    again = call(services, "lesson_from_document", subject="Redes", text=DOC, use_model=False)
    assert not again["existing"] and services.store.count("question") == n  # same cards, deduplicated
    call(services, "lesson_delete", lesson=again["lesson"]["id"], delete_questions=True)
    assert services.store.count("question") == 0


def test_http_api(client):
    r = client.post("/api/study/lessons", json={"subject": "Redes", "text": DOC, "use_model": False})
    assert r.status_code == 200, r.text
    lesson = r.json()["lesson"]
    assert client.post("/api/study/lessons", json={"subject": "Redes"}).status_code == 400
    got = client.post("/api/study/lessons/get", json={"lesson": lesson["id"], "section": 1}).json()
    assert got["section"]["n"] == 1 and got["flow"][0]["step"] == "read"
    assert client.post("/api/study/lessons/get", json={"lesson": "nope"}).status_code == 404
    mastery = client.post("/api/study/lessons/mastery", json={"lesson": lesson["id"]}).json()
    assert mastery["mastery"] == 0 and mastery["concepts"]
    qid = lesson["concepts"][0]["questionIds"][0]
    assert client.post("/api/study/review", json={"id": qid, "grade": "good"}).status_code == 200
    assert client.post("/api/study/lessons/mastery", json={"subject": "Redes"}).json()["count"] == 1
    assert client.post("/api/study/lessons/delete", json={"lesson": lesson["id"]}).json()["ok"] is True
