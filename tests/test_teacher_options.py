"""TEST options in every shape a model writes them (the live 27B returned {"a": "..."} maps that
became options "a) a / b) b"): tolerant reading, strict validation of generated drafts (repair
from the stem or drop with a reason, never show a broken draft), the JSON-schema request with
its fallbacks, and the approval guard. Invented content only."""

import json

import pytest

from fakes import FakeLink
from hypatia.agent_tools import call_tool
from hypatia.hoard_link import BackendError
from hypatia.notebook import init_schema
from hypatia.notebook import worker as nb_worker
from hypatia.options import correct_from_item, normalize_options, options_from_prompt, invalid_test_reason
from hypatia.teacher import generate, llm
from hypatia.teacher.store import teacher_store

TEXTS = ["Sujeto elíptico", "Complemento directo", "Atributo", "Complemento agente"]
PASSAGES = [{"n": 1, "chunkId": 1, "sourceId": "s", "filename": "Tema ficticio.pdf", "title": None, "page": 14,
             "heading": None, "text": "Un pasaje inventado sobre análisis sintáctico.", "snippet": "Un pasaje inventado"}]


def read(shape_options, correct, extra=None):
    item = {"type": "TEST", "prompt": "¿Qué función inventada cumple «X»?", "options": shape_options, "cita": [1],
            **({"correctOptionIds": correct} if correct is not None else {}), **(extra or {})}
    return generate.read_generated(json.dumps({"questions": [item]}, ensure_ascii=False), {"TEST": 1}, PASSAGES)


@pytest.mark.parametrize("options,correct", [
    ({"a": TEXTS[0], "b": TEXTS[1], "c": TEXTS[2], "d": TEXTS[3]}, ["b"]),          # the live failure
    ({"A": TEXTS[0], "B": TEXTS[1], "C": TEXTS[2], "D": TEXTS[3]}, "B"),
    ([f"{l}) {t}" for l, t in zip("abcd", TEXTS)], ["b"]),
    ([f"{l}. {t}" for l, t in zip("ABCD", TEXTS)], "b"),
    (TEXTS, [2]),                                                                    # 1-based number
    ([{"id": l, "text": t} for l, t in zip("abcd", TEXTS)], ["b"]),
    ([{l: t} for l, t in zip("abcd", TEXTS)], ["b"]),
    ([{"letter": l, "option": t} for l, t in zip("abcd", TEXTS)], "b"),
    ([{"label": l.upper(), "value": t} for l, t in zip("abcd", TEXTS)], ["B"]),
    ("\n".join(f"{l}) {t}" for l, t in zip("abcd", TEXTS)), "b"),
    (TEXTS, "Complemento directo"),                                                  # correct given as its text
    ([{"id": l, "text": t, "correct": l == "b"} for l, t in zip("abcd", TEXTS)], None),  # per-option flag
])
def test_every_option_shape_keeps_the_texts(options, correct):
    accepted, drops = read(options, correct)
    assert not drops, drops
    q = accepted[0]["question"]
    assert [o["text"] for o in q["options"]] == TEXTS
    correct_ids = q["correctOptionIds"]
    assert [o["text"] for o in q["options"] if o["id"] in correct_ids] == ["Complemento directo"]
    assert accepted[0]["cites"][0]["filename"] == "Tema ficticio.pdf"


@pytest.mark.parametrize("options,correct,reason", [
    (["a", "b", "c", "d"], ["a"], "solo la letra"),
    ([{"id": l, "text": l} for l in "abcd"], ["a"], "solo la letra"),
    ({"a": "Opción A", "b": "Opción B", "c": "Opción C"}, ["a"], "solo la letra"),
    (TEXTS[:2], ["a"], "menos de 3 opciones"),
    (TEXTS, None, "sin respuesta correcta"),
    (TEXTS, ["z"], "sin respuesta correcta"),
    (TEXTS, ["a", "b", "c", "d"], "todas las opciones"),
    ([TEXTS[0], TEXTS[0].upper(), TEXTS[2]], ["a"], "repetidas"),
    ([TEXTS[0], "", TEXTS[2], TEXTS[3]], ["a"], "opción vacía"),
])
def test_broken_test_drafts_are_dropped_with_their_reason(options, correct, reason):
    accepted, drops = read(options, correct)
    assert accepted == []
    assert drops[0]["reason"].startswith("test inválido") and reason in drops[0]["reason"], drops
    assert "excerpt" in drops[0]


def test_options_written_in_the_stem_are_repaired():
    prompt = "¿Qué función inventada cumple «X»?\nSeleccione una:\n" + "\n".join(f"{l}) {t}" for l, t in zip("abcd", TEXTS))
    accepted, drops = read(["a", "b", "c", "d"], ["b"], {"prompt": prompt})
    assert not drops
    q = accepted[0]["question"]
    assert [o["text"] for o in q["options"]] == TEXTS and q["correctOptionIds"] == ["b"]
    assert "a) " not in q["prompt"] and q["prompt"].startswith("¿Qué función")
    assert options_from_prompt("Sin opciones aquí") is None


def test_reply_variants_and_budget():
    item = {"type": "test", "prompt": "Uno", "options": TEXTS, "correctOptionIds": ["a"], "cita": "[1]"}
    fenced = "Pensando un poco…\n```json\n" + json.dumps([item, item, {"type": "DESARROLLO", "prompt": "x"}]) + "\n```"
    accepted, drops = generate.read_generated(fenced, {"TEST": 1}, PASSAGES)
    assert len(accepted) == 1 and [d["reason"] for d in drops] == ["sobra (ya hay las pedidas de su tipo)", "tipo no pedido"]
    accepted, drops = generate.read_generated("lo siento, no puedo", {"TEST": 1}, PASSAGES)
    assert accepted == [] and drops[0]["reason"] == "la respuesta no es JSON"
    alias = {"type": "TEST", "enunciado": "Dos", "opciones": {"a": "x1", "b": "x2", "c": "x3"}, "respuesta": "c", "cita": [1]}
    accepted, _ = generate.read_generated(json.dumps({"preguntas": [alias]}), {"TEST": 1}, PASSAGES)
    assert accepted[0]["question"]["prompt"] == "Dos" and accepted[0]["question"]["correctOptionIds"] == ["c"]


def test_normalizer_details():
    opts, id_map, flagged = normalize_options([{"id": "x1", "text": "Uno"}, {"id": "x2", "text": "Dos"}])
    assert [o["id"] for o in opts] == ["x1", "x2"]  # real ids are kept as written
    assert correct_from_item({"correct": "b"}, opts, id_map, flagged) == ["x2"]  # letter -> position
    assert correct_from_item({"correctOptionIds": "a, B"}, opts, id_map, flagged) == ["x1", "x2"]
    opts, id_map, flagged = normalize_options(["(a) Uno", "(b) Dos", "(c) Tres"])
    assert [o["text"] for o in opts] == ["Uno", "Dos", "Tres"]
    opts, _, _ = normalize_options(["A. Smith dijo", "Otra cosa", "Tercera"])  # not a sequence: no stripping
    assert opts[0]["text"] == "A. Smith dijo"
    assert invalid_test_reason({"options": [{"id": "a", "text": "Uno"}, {"id": "b", "text": "Dos"}], "correctOptionIds": ["a"]},
                        min_options=2) is None


def test_questions_add_reads_a_map_of_options_too(services):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Lengua Inventada", "createdAt": now, "updatedAt": now})
    out = call_tool(services, "questions_add", {"subject": "s1", "questions": [
        {"type": "TEST", "prompt": "¿Cuál?", "options": [{"id": "a", "text": "Uno"}, {"id": "b", "text": "Dos"}],
         "correctOptionIds": ["b"]}]})
    q = services.store.get("question", out["questions"][0]["id"])
    assert q["options"] == [{"id": "a", "text": "Uno"}, {"id": "b", "text": "Dos"}] and q["correctOptionIds"] == ["b"]
    from hypatia import bank

    cleaned = bank.clean_question_input({"type": "TEST", "prompt": "¿Cuál?", "options": {"a": "Uno", "b": "Dos"},
                                         "correctOptionIds": ["B"]})
    assert cleaned["options"] == [{"id": "a", "text": "Uno"}, {"id": "b", "text": "Dos"}]
    assert cleaned["correctOptionIds"] == ["b"]


# ---------------------------------------------------------------- the job: schema request and fallbacks

class SchemaRefusingLink(FakeLink):
    """A server that answers 400 to json_schema (some do), then follows json_object."""

    async def chat(self, messages, images=None, max_tokens=None, temperature=None, capability="llm",
                   response_format=None, effort=None):
        if (response_format or {}).get("type") == "json_schema":
            self.calls.append({"kind": "refused", "response_format": response_format})
            raise BackendError("fake", 400, "response_format json_schema not supported")
        return await super().chat(messages, images, max_tokens, temperature, capability, response_format, effort)


def live_like_reply(messages, **kwargs):
    system = " ".join(str(m["content"]) for m in messages if m["role"] == "system")
    if "pasajes numerados" not in system:
        return "{}"
    return json.dumps({"questions": [
        {"type": "TEST", "prompt": "¿Qué es Velarion?", "options": {"a": "Un astro", "b": "Una luna", "c": "Un río",
                                                                     "d": "Un mar"}, "correctOptionIds": ["a"],
         "cita": [1]},
        {"type": "TEST", "prompt": "Rota", "options": ["a", "b", "c", "d"], "correctOptionIds": ["a"], "cita": [1]},
    ]}, ensure_ascii=False)


@pytest.fixture
def subject_with_source(services):
    with services.db.lock:
        init_schema(services.db.conn)
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Ciencias Inventadas", "createdAt": now, "updatedAt": now})
    folder = services.config.resources_dir / "ciencias-inventadas" / "Temas"
    folder.mkdir(parents=True)
    (folder / "Astros.md").write_text("# Astros\n\nVelarion es un astro inventado que gira cada 40 días.\n", encoding="utf-8")
    from hypatia.notebook import sources

    yield services
    nb_worker.stop_worker()


def _index(services):
    from hypatia.notebook import sources

    for sid in sources.scan_subject(services, services.store.get("subject", "s1"))["pending"]:
        sources.index_source(services, sid, embed=False)


@pytest.mark.parametrize("link_cls,formats", [(FakeLink, ["json_schema"]), (SchemaRefusingLink, ["json_object"])])
def test_generation_asks_for_a_schema_and_never_keeps_a_broken_draft(subject_with_source, link_cls, formats):
    svc = subject_with_source
    fake = link_cls(chat_handler=live_like_reply)
    svc.link = lambda: fake
    _index(svc)
    out = call_tool(svc, "exam_generate", {"subject": "s1", "counts": {"TEST": 2}, "source": "generate", "wait_s": 20})
    job = out["job"]
    assert job["status"] == "done" and job["result"]["generated"] == 1 and job["result"]["dropped"] == 1
    assert job["result"]["dropReasons"] == {"test inválido: opción sin texto (solo la letra)": 1}
    assert job["result"]["dropSamples"][0]["excerpt"].startswith('{"type": "TEST", "prompt": "Rota"')
    draft = out["exam"]["drafts"][0]
    assert draft["options"] == [{"id": "a", "text": "Un astro"}, {"id": "b", "text": "Una luna"},
                                {"id": "c", "text": "Un río"}, {"id": "d", "text": "Un mar"}]
    assert draft["problem"] is None
    chats = [c for c in fake.calls if c["kind"] == "chat"]
    assert [c["response_format"]["type"] for c in chats] == formats
    if formats == ["json_object"]:
        assert fake.calls[0]["kind"] == "refused"
    else:
        assert chats[0]["response_format"]["json_schema"]["schema"] is generate.GEN_SCHEMA


def test_a_broken_draft_already_stored_is_refused_on_approval(subject_with_source):
    svc = subject_with_source
    store = teacher_store(svc)
    exam = generate.create_exam(svc, {"subjectId": "s1", "counts": {"TEST": 1}, "source": "bank"})["exam"]
    broken = {"id": "d1", "type": "TEST", "status": "pending", "points": 1, "citations": [{"n": 1}],
              "question": {"type": "TEST", "prompt": "Rota", "options": [{"id": l, "text": l} for l in "abcd"],
                           "correctOptionIds": ["a"]}}
    store.put("teacherExam", {**store.get("teacherExam", exam["id"]), "drafts": [broken]})
    view = call_tool(svc, "exam_get", {"exam": exam["id"]})["exam"]
    assert view["drafts"][0]["problem"] == "opción sin texto (solo la letra)"
    res = call_tool(svc, "exam_drafts_review", {"exam": exam["id"], "accept": "all"})
    assert res["invalid"] == ["d1"] and res["added"] == []
    assert svc.store.count("question") == 0
    stored = store.get("teacherExam", exam["id"])["drafts"][0]
    assert stored["status"] == "rejected" and stored["rejectedReason"].startswith("test inválido")


def test_llm_chat_without_model_is_no_model(services):
    with pytest.raises(llm.NoModel):
        llm.chat(services, [{"role": "user", "content": "hola"}], schema={"type": "object"})
