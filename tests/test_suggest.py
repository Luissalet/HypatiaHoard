"""cards_suggest: prompt building, JSON parsing, drafting with a fake Hoard
Link, the Scribe source (against a fake Scribe's Hoard ASGI app), the tool
schema/accept flow, and the HTTP API -- all offline."""

from __future__ import annotations

import json

import pytest
from conftest import make_config
from fakes import chat_text, make_fake_scribe_client
from fastapi.testclient import TestClient

from hypatia import backend, suggest
from hypatia.agent_tools import TOOLS, call_tool, tool_catalog
from hypatia.hoard_link import BackendError, Unavailable
from hypatia.main import create_app
from hypatia.services import Services

SESSIONS = [
    {"id": "s1", "title": "Reunión de presupuesto", "kind": "meeting", "status": "done",
     "started_at": "2026-01-01T10:00:00", "duration": "0:20", "sources": ["mic"], "tags": [], "first_line": "hola"},
    {"id": "s2", "title": "Entrevista candidato", "kind": "interview", "status": "done",
     "started_at": "2026-01-02T10:00:00", "duration": "0:10", "sources": ["mic"], "tags": [], "first_line": "hola"},
]
TRANSCRIPTS = {
    "s1": [
        {"t": "00:00", "start_s": 0.0, "end_s": 2.0, "speaker": "yo", "text": "Hoy hablamos del presupuesto anual.", "live": False},
        {"t": "00:05", "start_s": 5.0, "end_s": 7.0, "speaker": "otros", "text": "El presupuesto sube a 10000 euros.", "live": False},
        {"t": "00:10", "start_s": 10.0, "end_s": 12.0, "speaker": "yo", "text": "Cerramos la reunión con ese acuerdo.", "live": False},
    ],
    "s2": [
        {"t": "00:00", "start_s": 0.0, "end_s": 2.0, "speaker": "yo", "text": "Cuéntame tu experiencia previa.", "live": False},
        {"t": "00:03", "start_s": 3.0, "end_s": 5.0, "speaker": "otros", "text": "Trabajé cinco años en soporte técnico.", "live": False},
    ],
}

DRAFT_JSON = json.dumps([
    {"front": "¿Cuánto sube el presupuesto anual?", "back": "A 10000 euros.", "source": "00:05"},
    {"front": "¿Con qué se cierra la reunión?", "back": "Con el acuerdo del presupuesto.", "source": "00:10"},
])


def make_client(tmp_path, clock, **overrides):
    svc = Services(make_config(tmp_path), clock=clock, **overrides)
    app = create_app(make_config(tmp_path), services=svc)
    test_client = TestClient(app, base_url="http://127.0.0.1")
    test_client.__enter__()  # runs the app's lifespan (sets app.state.services), like the `client` fixture's `with`
    test_client.services = svc
    test_client.clock = clock
    return test_client


# --------------------------------------------------------- backend.py --
def test_build_suggest_messages_names_language_and_cap():
    messages = backend.build_suggest_messages("El cielo es azul.", "es", 5)
    assert messages[0]["role"] == "system" and "Spanish" in messages[0]["content"] and "5" in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "El cielo es azul."}


def test_load_link_config_reads_backend_json(tmp_path):
    (tmp_path / backend.BACKEND_FILE).write_text(json.dumps({"only_resident": False}), encoding="utf-8")
    cfg = backend.load_link_config(tmp_path, env={})
    assert cfg.only_resident is False
    assert cfg.app == backend.APP_ID


# --------------------------------------------------------- parse_drafts --
def test_parse_drafts_plain_json_array():
    drafts = suggest.parse_drafts(DRAFT_JSON)
    assert len(drafts) == 2
    assert drafts[0]["front"] == "¿Cuánto sube el presupuesto anual?"
    assert drafts[0]["source"] == "00:05"


def test_parse_drafts_strips_markdown_fences():
    fenced = f"```json\n{DRAFT_JSON}\n```"
    assert suggest.parse_drafts(fenced) == suggest.parse_drafts(DRAFT_JSON)


def test_parse_drafts_accepts_a_wrapped_object():
    wrapped = json.dumps({"cards": json.loads(DRAFT_JSON)})
    assert len(suggest.parse_drafts(wrapped)) == 2


def test_parse_drafts_extracts_array_from_surrounding_prose():
    prose = f"Here are the cards:\n{DRAFT_JSON}\nHope that helps!"
    assert len(suggest.parse_drafts(prose)) == 2


def test_parse_drafts_returns_none_on_garbage():
    assert suggest.parse_drafts("not json at all") is None
    assert suggest.parse_drafts("") is None


def test_parse_drafts_empty_array_is_not_none():
    assert suggest.parse_drafts("[]") == []


def test_parse_drafts_drops_items_missing_front_or_back():
    raw = json.dumps([{"front": "Q1", "back": "A1"}, {"front": "", "back": "A2"}, {"front": "Q3"}])
    assert [d["front"] for d in suggest.parse_drafts(raw)] == ["Q1"]


# --------------------------------------------------------- gather_material --
def test_gather_material_text_truncates_long_input():
    long_text = "x" * (suggest.MAX_MATERIAL_CHARS + 500)
    material, label, truncated = suggest.gather_material({"kind": "text", "text": long_text})
    assert len(material) == suggest.MAX_MATERIAL_CHARS
    assert truncated is True
    assert label == "pasted text"


def test_gather_material_rejects_unknown_kind():
    with pytest.raises(suggest.SuggestInputError):
        suggest.gather_material({"kind": "audio"})


def test_gather_material_scribe_needs_session_or_range():
    client = make_fake_scribe_client(SESSIONS, TRANSCRIPTS)
    with pytest.raises(suggest.SuggestInputError):
        suggest.gather_material({"kind": "scribe"}, client)


def test_gather_material_scribe_session_id(tmp_path):
    client = make_fake_scribe_client(SESSIONS, TRANSCRIPTS)
    material, label, truncated = suggest.gather_material({"kind": "scribe", "session_id": "s1"}, client)
    assert "presupuesto" in material and "Reunión de presupuesto" in label and truncated is False


def test_gather_material_scribe_range_concatenates_sessions():
    client = make_fake_scribe_client(SESSIONS, TRANSCRIPTS)
    material, label, _truncated = suggest.gather_material({"kind": "scribe", "since": "2026-01-01"}, client)
    assert "Reunión de presupuesto" in material and "Entrevista candidato" in material
    assert "Reunión de presupuesto" in label and "Entrevista candidato" in label


def test_gather_material_scribe_range_with_no_sessions_errors():
    client = make_fake_scribe_client([], {})
    with pytest.raises(suggest.SuggestInputError):
        suggest.gather_material({"kind": "scribe", "since": "2026-01-01"}, client)


def test_gather_material_scribe_unreachable_raises_suggest_input_error(monkeypatch, tmp_path):
    monkeypatch.setenv("SCRIBE_DIR", str(tmp_path / "nowhere"))
    monkeypatch.delenv("SCRIBE_TOKEN", raising=False)
    monkeypatch.delenv("SCRIBE_URL", raising=False)
    from hypatia.scribe_client import ScribeClient

    with pytest.raises(suggest.SuggestInputError):
        suggest.gather_material({"kind": "scribe", "session_id": "s1"}, ScribeClient())


# --------------------------------------------------------- suggest_cards --
def test_suggest_cards_returns_drafts_from_the_model(services):
    services._link_chat_override = lambda messages, **kw: chat_text(DRAFT_JSON)
    result = suggest.suggest_cards(services, {"kind": "text", "text": "El presupuesto sube a 10000 euros en 2026."},
                                    "Reuniones", 12, "es")
    assert result["material"] is None
    assert result["note"] is None
    assert len(result["drafts"]) == 2
    assert result["drafts"][0]["source"] == "00:05"
    assert result["model"] == "fake-qwen"


def test_suggest_cards_fills_default_source_when_model_omits_it(services):
    raw = json.dumps([{"front": "Q", "back": "A"}])
    services._link_chat_override = lambda messages, **kw: chat_text(raw)
    result = suggest.suggest_cards(services, {"kind": "text", "text": "material"}, "Mazo", 12, "es")
    assert result["drafts"][0]["source"] == "pasted text"


def test_suggest_cards_respects_max_cards_cap(services):
    many = json.dumps([{"front": f"Q{i}", "back": f"A{i}"} for i in range(10)])
    services._link_chat_override = lambda messages, **kw: chat_text(many)
    result = suggest.suggest_cards(services, {"kind": "text", "text": "material"}, "Mazo", 3, "es")
    assert len(result["drafts"]) == 3


def test_suggest_cards_no_backend_available_returns_material_and_note(services):
    def raise_unavailable(messages, **kw):
        raise Unavailable("llm", ["no server configured"])

    services._link_chat_override = raise_unavailable
    result = suggest.suggest_cards(services, {"kind": "text", "text": "El gato duerme en el sofá."}, "Mazo", 12, "es")
    assert result["drafts"] == []
    assert result["material"] == "El gato duerme en el sofá."
    assert "no server configured" in result["note"]


def test_suggest_cards_backend_error_returns_material_and_note(services):
    def raise_backend_error(messages, **kw):
        raise BackendError("llamacpp", 500, "boom")

    services._link_chat_override = raise_backend_error
    result = suggest.suggest_cards(services, {"kind": "text", "text": "material"}, "Mazo", 12, "es")
    assert result["drafts"] == [] and result["material"] == "material"
    assert "call failed" in result["note"]


def test_suggest_cards_bad_json_falls_back_to_material(services):
    services._link_chat_override = lambda messages, **kw: chat_text("I cannot help with that.")
    result = suggest.suggest_cards(services, {"kind": "text", "text": "material"}, "Mazo", 12, "es")
    assert result["drafts"] == [] and result["material"] == "material"
    assert "expected JSON" in result["note"]


def test_suggest_cards_model_found_nothing_worth_a_card(services):
    services._link_chat_override = lambda messages, **kw: chat_text("[]")
    result = suggest.suggest_cards(services, {"kind": "text", "text": "material"}, "Mazo", 12, "es")
    assert result["drafts"] == [] and result["material"] is None
    assert "no fact worth a card" in result["note"]


def test_suggest_cards_from_scribe_session(services):
    services._link_chat_override = lambda messages, **kw: chat_text(DRAFT_JSON)
    client = make_fake_scribe_client(SESSIONS, TRANSCRIPTS)
    result = suggest.suggest_cards(services, {"kind": "scribe", "session_id": "s1"}, "Reuniones", 12, "es", client)
    assert len(result["drafts"]) == 2


# --------------------------------------------------------- tool schema/flow --
def test_tool_catalog_includes_suggest_and_accept():
    names = [t["name"] for t in tool_catalog()]
    assert "cards_suggest" in names and "cards_suggest_accept" in names
    by_name = {t.name: t for t in TOOLS}
    assert by_name["cards_suggest"].annotations["readOnlyHint"] is False
    assert by_name["cards_suggest_accept"].annotations["readOnlyHint"] is False
    schema = next(t for t in tool_catalog() if t["name"] == "cards_suggest")["inputSchema"]
    assert "source" in schema["properties"]


def test_call_tool_cards_suggest_text_source(services):
    services._link_chat_override = lambda messages, **kw: chat_text(DRAFT_JSON)
    result = call_tool(services, "cards_suggest", {"source": {"kind": "text", "text": "material"}, "deck": "Mazo"})
    assert len(result["drafts"]) == 2


def test_call_tool_cards_suggest_scribe_source(services):
    services._scribe_client_override = make_fake_scribe_client(SESSIONS, TRANSCRIPTS)
    services._link_chat_override = lambda messages, **kw: chat_text(DRAFT_JSON)
    result = call_tool(services, "cards_suggest",
                        {"source": {"kind": "scribe", "session_id": "s1"}, "deck": "Reuniones"})
    assert len(result["drafts"]) == 2


def test_call_tool_cards_suggest_scribe_unreachable_is_a_value_error(services):
    result_error = None
    try:
        call_tool(services, "cards_suggest", {"source": {"kind": "scribe", "session_id": "s1"}, "deck": "Mazo"})
    except ValueError as error:
        result_error = error
    assert result_error is not None


def test_call_tool_cards_suggest_accept_saves_cards(services):
    drafts = [{"front": "¿Capital de X?", "back": "Y", "source": "material"}]
    result = call_tool(services, "cards_suggest_accept", {"deck": "Aceptadas", "drafts": drafts})
    assert result["count"] == 1
    found = services.cards.find_by_front("¿Capital de X?", result["deck"]["id"])
    assert found is not None and found["back"] == "Y"


def test_cards_suggest_accept_is_idempotent_like_cards_add(services):
    drafts = [{"front": "F", "back": "B1", "source": "s"}]
    call_tool(services, "cards_suggest_accept", {"deck": "D", "drafts": drafts})
    again = call_tool(services, "cards_suggest_accept", {"deck": "D", "drafts": [{"front": "F", "back": "B2", "source": "s"}]})
    assert again["cards"][0]["existing"] is True


# --------------------------------------------------------- HTTP API --
def test_api_suggest_draft_text_source(tmp_path, clock):
    client = make_client(tmp_path, clock, link_chat=lambda messages, **kw: chat_text(DRAFT_JSON))
    response = client.post("/api/suggest", json={"source": {"kind": "text", "text": "material"}, "deck": "Mazo"})
    assert response.status_code == 200
    body = response.json()
    assert len(body["drafts"]) == 2


def test_api_suggest_draft_bad_source_kind_is_400(tmp_path, clock):
    client = make_client(tmp_path, clock)
    response = client.post("/api/suggest", json={"source": {"kind": "nope"}, "deck": "Mazo"})
    assert response.status_code == 400  # rejected by the discriminated-union schema itself


def test_api_suggest_scribe_sessions_unreachable_reports_reason(tmp_path, clock, monkeypatch):
    monkeypatch.setenv("SCRIBE_DIR", str(tmp_path / "nowhere"))
    monkeypatch.delenv("SCRIBE_TOKEN", raising=False)
    # A real Scribe may be listening on 5185 on the developer's machine: point at a closed port.
    monkeypatch.setenv("SCRIBE_URL", "http://127.0.0.1:1")
    client = make_client(tmp_path, clock)
    response = client.get("/api/suggest/scribe/sessions")
    assert response.status_code == 200
    body = response.json()
    assert body["reachable"] is False and body["sessions"] == [] and body["reason"]


def test_api_suggest_accept_saves_cards(tmp_path, clock):
    client = make_client(tmp_path, clock)
    response = client.post("/api/suggest/accept", json={
        "deck": "Aceptadas",
        "drafts": [{"front": "¿Uno?", "back": "Uno.", "source": "material"}],
    })
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    cards = client.get("/api/cards", params={"deck": body["deck"]["id"]}).json()["cards"]
    assert cards[0]["front"] == "¿Uno?"
