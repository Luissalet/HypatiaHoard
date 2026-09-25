"""Study tools through call_tool (the same path as /api/agent/call and MCP)."""

import re

import pytest
from pydantic import BaseModel

from hypatia import agent_tools
from hypatia.agent_tools import TOOLS, call_tool, tool_catalog


def call(services, name, **args):
    return call_tool(services, name, args)


TEST_Q = {"type": "TEST", "prompt": "¿Capa de TCP?", "options": [{"id": "a", "text": "Transporte"}, {"id": "b", "text": "Red"},
                                                                  {"id": "c", "text": "Enlace, física"}],
          "correctOptionIds": ["a"], "explanation": "TCP es de transporte."}
DEV_Q = {"type": "DESARROLLO", "prompt": "Explica el handshake de TCP.", "modelAnswer": "SYN, SYN-ACK, ACK.",
         "keywords": ["SYN", "ACK", "tres pasos"]}
CLOZE_Q = {"type": "COMPLETAR", "prompt": "Completa", "clozeText": "TCP usa {{b1}} y {{b2}}",
           "blanks": [{"id": "b1", "accepted": ["puertos"]}, {"id": "b2", "accepted": ["números de secuencia", "secuencias"]}]}


@pytest.fixture
def bank(services):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Redes de Computadores", "createdAt": now, "updatedAt": now,
                                   "examDate": "2026-10-15"})
    services.store.put("subject", {"id": "s2", "name": "Álgebra", "createdAt": now, "updatedAt": now})
    services.store.put("topic", {"id": "t1", "subjectId": "s1", "title": "Transporte", "order": 0, "createdAt": now, "updatedAt": now})
    services.store.put("topic", {"id": "t2", "subjectId": "s1", "title": "Enlace", "order": 1, "createdAt": now, "updatedAt": now})
    out = call(services, "questions_add", subject="redes", topic="Transporte", questions=[TEST_Q, DEV_Q, CLOZE_Q])
    extra = call(services, "questions_add", subject="redes", topic="2", questions=[{**DEV_Q, "prompt": "¿Qué es Ethernet?"}])
    return [q["id"] for q in out["questions"] + extra["questions"]]


# ---------- catalog ----------

def test_catalog_descriptions_and_schemas():
    names = [t.name for t in TOOLS]
    assert len(names) == len(set(names)) and len(names) <= 30
    for name in ("subjects_list", "cards_due", "card_review", "answer_grade", "exam_mock", "questions_suggest",
                 "cards_add", "decks_list", "deliverables_upcoming", "key_concept_add"):
        assert name in names
    for tool in TOOLS:
        first = tool.description.split("\n", 1)[0]
        assert 0 < len(first) <= 110, (tool.name, len(first))
        assert "\nSinónimos:" in tool.description or "Sinónimos:" in tool.description, tool.name
        assert re.search(r"[áéíóúñ¿]", tool.description), tool.name
        assert issubclass(tool.input_model, BaseModel)
        assert set(tool.annotations) == {"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"}
    for alias in ("cards_add", "decks_list"):
        assert agent_tools.TOOLS_BY_NAME[alias].description.startswith("Alias of")
    for entry in tool_catalog():
        assert entry["inputSchema"]["type"] == "object"


def test_unknown_tool_and_bad_args(services):
    with pytest.raises(KeyError):
        call(services, "nope")
    with pytest.raises(Exception):
        call(services, "questions_add", subject="x", questions=[])


# ---------- bank ----------

def test_subjects_topics_and_search(services, bank):
    subjects = call(services, "subjects_list")["subjects"]
    redes = next(s for s in subjects if s["id"] == "s1")
    assert redes["questions"] == 4 and redes["neverSeen"] == 4
    topics = call(services, "topics_list", subject="Redes")["topics"]
    assert [(t["n"], t["title"], t["questions"]) for t in topics] == [(1, "Transporte", 3), (2, "Enlace", 1)]
    hits = call(services, "questions_search", q="handshake", subject="redes")
    assert hits["count"] == 1 and hits["questions"][0]["modelAnswer"]
    hidden = call(services, "questions_search", q="tcp", with_answers=False)
    assert all("correctOptionIds" not in q and "modelAnswer" not in q for q in hidden["questions"])
    assert call(services, "questions_search", subject="redes", topic="tema 2")["count"] == 1
    assert call(services, "questions_search", subject="redes", type="TEST")["count"] == 1


def test_resolve_subject_errors_list_names(services, bank):
    with pytest.raises(LookupError, match="Álgebra"):
        call(services, "topics_list", subject="química")


def test_questions_add_dedupes_by_hash_and_validates(services, bank):
    again = call(services, "questions_add", subject="s1", questions=[{**TEST_Q, "prompt": "  ¿CAPA de tcp? "}])
    assert again["questions"][0]["existing"] is True
    with pytest.raises(ValueError):
        call(services, "questions_add", subject="s1", questions=[{**TEST_Q, "correctOptionIds": ["z"]}])
    new = call(services, "questions_add", subject="s1", topic="Tema nuevo", questions=[{**DEV_Q, "prompt": "Nuevo"}])
    assert new["topic"] == "Tema nuevo"
    q = services.store.get("question", new["questions"][0]["id"])
    assert q["stats"] == {"seen": 0, "correct": 0, "wrong": 0} and q["contentHash"].startswith("sha256:")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", q["createdAt"])


def test_update_and_delete_question(services, bank):
    qid = bank[1]
    before = services.store.get("question", qid)["contentHash"]
    got = call(services, "question_update", id=qid, modelAnswer="SYN, SYN+ACK y ACK.", starred=True, notes="ojo", topic="Enlace")
    q = got["question"]
    assert q["contentHash"] != before and q["starred"] is True and q["notes"] == "ojo" and q["topicId"] == "t2"
    assert call(services, "question_delete", id=qid)["ok"] is True
    assert services.store.tombstone("question", qid)
    with pytest.raises(LookupError):
        call(services, "question_delete", id=qid)


# ---------- quiz ----------

def test_cards_due_order_and_review(services, bank, clock):
    services.store.put("question", {**services.store.get("question", bank[0]),
                                    "stats": {"seen": 2, "correct": 1, "wrong": 1, "nextReviewAt": "2026-09-20", "lastResult": "WRONG"}})
    queue = call(services, "cards_due", subject="redes", limit=10)
    assert queue["queue"][0]["id"] == bank[0] and queue["totals"] == {"due": 1, "neverSeen": 3, "failed": 0}
    assert queue["queue"][0]["correctOptionIds"] == ["a"]  # answers are for the assistant
    r = call(services, "card_review", id=bank[0], prompt="¿Capa de TCP?", grade="good")
    q = services.store.get("question", bank[0])
    assert r["result"] == "CORRECT" and q["stats"]["seen"] == 3 and q["stats"]["correct"] == 2
    assert q["updatedAt"] == services.now_iso() and q["stats"]["nextReviewAt"] > "2026-09-25"
    settings = services.store.kv_get("syncedSettings")
    assert settings["studyStreak"] == 1 and settings["lastStudyDate"] == "2026-09-25"


def test_card_review_prompt_wins_over_id(services, bank):
    r = call(services, "card_review", id=bank[0], prompt="Explica el handshake de TCP.", grade=0)
    assert r["question"]["id"] == bank[1] and r["result"] == "WRONG"
    assert services.store.get("question", bank[0])["stats"]["seen"] == 0
    r = call(services, "card_review", id="1", front="explica el HANDSHAKE de tcp.", grade="easy")  # ordinal as id
    assert r["question"]["id"] == bank[1]
    with pytest.raises(LookupError):
        call(services, "card_review", prompt="No existe", grade=2)
    with pytest.raises(ValueError):
        call(services, "card_review", grade=2)


def test_answer_grade_test_and_completar(services, bank):
    for answer, verdict in (("a", "correct"), ("A", "correct"), ("Transporte", "correct"), ("1", "correct"),
                            ("b", "wrong"), ("a, b", "wrong"), ("Enlace, física", "wrong")):
        assert call(services, "answer_grade", id=bank[0], answer=answer)["verdict"] == verdict, answer
    ok = call(services, "answer_grade", id=bank[2], answer=["Puertos", "secuencias"])
    assert ok["verdict"] == "correct" and ok["suggestedGrade"] == "good"
    assert call(services, "answer_grade", id=bank[2], answer={"b1": "puertos", "b2": "no"})["verdict"] == "wrong"
    with pytest.raises(ValueError):
        call(services, "answer_grade", id=bank[0], answer="z")


def test_answer_grade_free_text_without_and_with_model(services, bank, link):
    got = call(services, "answer_grade", id=bank[1], answer="Primero SYN y luego ACK")
    assert got["verdict"] == "partial" and got["score"] == 6 and got["suggestedGrade"] == "hard" and got["model"] == "fake-llm"
    assert link.calls[-1]["response_format"] == {"type": "json_object"}


def test_answer_grade_free_text_no_model(services, bank):
    got = call(services, "answer_grade", prompt="Explica el handshake de TCP.", answer="Primero SYN y luego ACK")
    assert got["verdict"] is None and got["matchedKeywords"] == ["SYN", "ACK"] and got["missing"] == ["tres pasos"]
    assert got["modelAnswer"] == "SYN, SYN-ACK, ACK." and "note" in got


def test_weak_topics_and_mock_exam(services, bank):
    q = services.store.get("question", bank[3])  # Enlace
    services.store.put("question", {**q, "stats": {"seen": 3, "correct": 0, "wrong": 3, "lastResult": "WRONG",
                                                   "nextReviewAt": "2026-09-01"}})
    rows = call(services, "weak_topics", subject="redes")["topics"]
    assert rows[0]["topic"] == "Enlace" and rows[0]["accuracy"] == 0 and rows[0]["overdue"] == 1
    exam = call(services, "exam_mock", subject="redes", n=3)
    assert len(exam["questions"]) == 3 and exam["exam"]["name"] == "Simulacro 2026-09-25"
    assert all("modelAnswer" not in x and "correctOptionIds" not in x for x in exam["questions"])
    assert services.store.get("exam", exam["exam"]["id"])["questionIds"] == [x["id"] for x in exam["questions"]]
    unsaved = call(services, "exam_mock", subject="redes", n=50, save=False, types=["TEST"])
    assert len(unsaved["questions"]) == 1 and services.store.get("exam", unsaved["exam"]["id"]) is None


def test_stats_concepts_deliverables(services, bank):
    now = services.now_iso()
    services.store.put("deliverable", {"id": "d1", "subjectId": "s1", "name": "Práctica 2", "type": "activity",
                                       "status": "pending", "dueDate": "2026-10-01", "continuousPoints": 1,
                                       "createdAt": now, "updatedAt": now})
    services.store.put("deliverable", {"id": "d2", "subjectId": "s1", "name": "Hecha", "type": "test", "status": "done",
                                       "dueDate": "2026-10-01", "continuousPoints": 1, "createdAt": now, "updatedAt": now})
    stats = call(services, "study_stats", subject="redes")
    s = stats["subjects"][0]
    assert s["questions"] == 4 and s["daysToExam"] == 20 and [d["id"] for d in s["upcomingDeliverables"]] == ["d1"]
    up = call(services, "deliverables_upcoming", days=10)
    assert up["count"] == 1 and up["deliverables"][0]["daysLeft"] == 6
    added = call(services, "key_concept_add", subject="redes", category="formula", title="Throughput", content="$T = W/RTT$")
    assert added["existing"] is False and added["concept"]["order"] == 0
    assert call(services, "key_concept_add", subject="redes", category="formula", title="throughput", content="$T = W/RTT$")["existing"]
    assert call(services, "key_concepts", subject="redes", q="rtt")["count"] == 1


# ---------- suggest ----------

def test_questions_suggest_without_model_returns_material(services, bank):
    got = call(services, "questions_suggest", source={"kind": "text", "text": "TCP es fiable."}, subject="redes")
    assert got["drafts"] == [] and got["material"] == "TCP es fiable." and "note" in got


def test_questions_suggest_with_model_and_accept(services, bank, link):
    got = call(services, "questions_suggest", source={"kind": "text", "text": "Apuntes de requisitos."}, subject="redes",
               types=["TEST", "DESARROLLO"], n=5)
    assert [d["type"] for d in got["drafts"]] == ["TEST", "DESARROLLO"]  # the invalid third draft is dropped
    saved = call(services, "questions_suggest_accept", subject="redes", topic="Requisitos", drafts=got["drafts"])
    assert saved["added"] == 2
    again = call(services, "questions_suggest_accept", subject="redes", topic="Requisitos", drafts=got["drafts"])
    assert again["added"] == 0 and again["existing"] == 2


def test_questions_suggest_from_sources_needs_indexed_sources(services, bank):
    with pytest.raises(ValueError, match="indexed"):
        call(services, "questions_suggest", source={"kind": "sources"}, subject="redes")


# ---------- compat aliases ----------

def test_cards_add_and_decks_list(services):
    got = call(services, "cards_add", deck="Historia", cards=[{"front": "¿Año?", "back": "1492", "tags": ["h"], "source": "libro p. 3"}])
    assert got["subjectCreated"] is True and got["cards"][0]["existing"] is False
    q = services.store.get("question", got["cards"][0]["id"])
    assert q["type"] == "DESARROLLO" and q["modelAnswer"] == "1492" and q["explanation"] == "Fuente: libro p. 3"
    assert call(services, "cards_add", deck="historia", cards=[{"front": "¿Año?", "back": "1492"}])["subjectCreated"] is False
    decks = call(services, "decks_list")["decks"]
    assert decks[0]["name"] == "Historia" and decks[0]["cards"] == 1
    assert call(services, "cards_due", deck="Historia")["count"] == 1


def test_questions_suggest_from_indexed_sources(services, bank, link):
    notebook = pytest.importorskip("hypatia.notebook")
    with services.db.lock:
        notebook.init_schema(services.db.conn)
        services.db.conn.execute("INSERT INTO sources(id, subject_id, origin, path, filename, title, status) VALUES "
                                 "('src1', 's1', 'upload', 'x', 'Transporte.pdf', 'Transporte', 'indexed')")
        services.db.conn.execute("INSERT INTO chunks(source_id, ord, page, heading, text) VALUES "
                                 "('src1', 0, 3, NULL, 'TCP garantiza la entrega ordenada con números de secuencia.')")
    got = call(services, "questions_suggest", source={"kind": "sources", "query": "secuencia"}, subject="redes",
               topic="Transporte")
    assert got["drafts"] and "Transporte.pdf" in got["source"]
    assert "p. 3" in link.calls[-1]["messages"][1]["content"]
