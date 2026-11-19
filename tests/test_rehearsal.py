"""Objection rehearsal of a Cicero deck: prepare, check slide by slide, send the weak ones back, close them once fixed, undo."""
from __future__ import annotations

import copy
import json

import pytest

from fakes import FakeLink
from hypatia import rehearsal
from hypatia.agent_tools import call_tool

DECK = {
    "id": "D1", "title": "Tres impresoras multicolor", "language": "es",
    "sources": [{"id": 1, "title": "Creality — K2 Plus CFS"}],
    "slides": [
        {"id": "S1", "position": 1, "title": "Qué comparamos", "blocks": [{"type": "bullets", "items": ["Tres impresoras", "Taller pequeño"]}],
         "notes": "", "sources": []},
        {"id": "S2", "position": 2, "title": "Hasta 16 colores", "blocks": [{"type": "bullets", "items": ["La K2 Plus imprime hasta 16 colores"]}],
         "notes": "", "sources": [1]},
    ],
}
OBJECTIONS = [
    {"slide_id": "S2", "question": "¿Cuántas unidades CFS hacen falta para llegar a 16 colores?",
     "expected": "Cuatro: cada CFS admite cuatro colores, así que 16 requieren cuatro unidades.",
     "keywords": ["cuatro unidades"], "evidence": ["Un CFS admite cuatro colores. La capacidad de 16 requiere cuatro unidades en total."]},
    {"slide_id": "S1", "question": "¿Para qué tamaño de taller es la comparación?", "expected": "Para un taller pequeño.",
     "keywords": ["taller pequeño"], "evidence": []},
]


def call(services, name, **args):
    return call_tool(services, name, args)


class FakeHub:
    """Stands in for family.call: Cicero's deck_get, source_get and deck_defects_receive through the Hub."""

    def __init__(self, deck):
        self.deck = deck
        self.sent: list[dict] = []

    def __call__(self, app, tool, arguments=None, *, timeout=120.0):
        assert app == "cicero"
        if tool == "deck_get":
            return {"ok": True, "result": copy.deepcopy(self.deck)}
        if tool == "source_get":
            return {"ok": True, "result": {"text": "Un CFS admite cuatro colores. La capacidad de 16 requiere cuatro unidades en total."}}
        if tool == "deck_defects_receive":
            self.sent.append(arguments)
            return {"ok": True, "result": {"opened": [d["key"] for d in arguments["defects"]], "reopened": [], "resolved": [],
                                           "open_total": len(arguments["defects"])}}
        return {"ok": False, "error": f"unexpected {tool}"}


@pytest.fixture
def hub(monkeypatch):
    fake = FakeHub(copy.deepcopy(DECK))
    monkeypatch.setattr(rehearsal.family, "call", fake)
    return fake


def judge_by_keywords(messages, **kwargs):
    """A model stand-in: the slide holds when it states the expected point."""
    user = messages[-1]["content"]
    slide = user.split("Objeción:")[0].lower()
    holds = ("cuatro unidades" in slide) if "16 colores" in user else ("taller pequeño" in slide)
    return json.dumps({"verdict": "holds" if holds else "fails", "missing": [] if holds else ["cuatro unidades"],
                       "feedback": "" if holds else "La diapositiva no dice cuántas unidades hacen falta."})


def test_prepare_reads_the_deck_and_makes_a_subject_of_objections(services, hub):
    out = call(services, "rehearsal_prepare", deck_id="D1", objections=OBJECTIONS)
    assert out["objections"] == 2 and out["slides"] == 2 and out["undo"]["tool"] == "rehearsal_undo"
    questions = services.store.list("question", out["rehearsal"])
    assert sorted(q["prompt"] for q in questions) == sorted(o["question"] for o in OBJECTIONS)
    q = next(q for q in questions if "16 colores" in q["prompt"])
    assert q["type"] == "DESARROLLO" and q["modelAnswer"].startswith("Cuatro") and "«Un CFS admite" in q["explanation"]
    assert q["sourceRef"] == "hoard://cicero/deck/D1/slide/S2"
    topics = {t["title"] for t in services.store.list("topic", out["rehearsal"])}
    assert topics == {"1. Qué comparamos", "2. Hasta 16 colores"}


def test_weak_slide_goes_back_to_cicero_and_stops_being_flagged_once_fixed(services, hub):
    fake = FakeLink(chat_handler=judge_by_keywords)
    services.link = lambda: fake
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=OBJECTIONS)["rehearsal"]

    first = call(services, "rehearsal_check", rehearsal=rid)
    assert first["weak_slides"] == ["S2"] and first["holds"] == 1
    sent = hub.sent[-1]
    assert sent["deck_id"] == "D1" and sent["origin"] == f"hypatia:rehearsal/{rid}" and sent["reason"]
    [defect] = sent["defects"]
    assert defect["slide_id"] == "S2" and "16 colores" in defect["objection"] and defect["evidence"] == OBJECTIONS[0]["evidence"]
    assert first["sent_to_cicero"]["ok"] is True

    # The slide is fixed in Cicero: the notes now give the answer the evidence supports.
    hub.deck["slides"][1]["notes"] = "Cada CFS admite cuatro colores: para 16 hacen falta cuatro unidades."
    second = call(services, "rehearsal_check", rehearsal=rid)
    assert second["weak_slides"] == [] and second["holds"] == 2
    assert hub.sent[-1]["defects"] == []            # the empty verdict closes the defect in Cicero
    state = call(services, "rehearsal_get", rehearsal=rid)
    assert state["runs"] == 2 and all(o["last"]["verdict"] == "holds" for o in state["objections"])


def test_without_a_model_keywords_decide(services, hub):
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=OBJECTIONS)["rehearsal"]
    out = call(services, "rehearsal_check", rehearsal=rid, send=False)
    verdicts = {r["slide_id"]: (r["verdict"], r["judge"]) for r in out["results"]}
    assert verdicts == {"S2": ("fails", "keywords"), "S1": ("holds", "keywords")}
    assert out["sent_to_cicero"] is None and hub.sent == []


def test_model_drafts_objections_and_keeps_only_real_quotes(services, hub):
    def drafter(messages, **kwargs):
        assert "Un CFS admite cuatro colores" in messages[-1]["content"]          # the source text reached the model
        return json.dumps({"objections": [
            {"slide_id": "S2", "question": "¿Con una sola unidad hay 16 colores?", "expected": "No, hacen falta cuatro.",
             "keywords": ["cuatro"], "evidence": ["La capacidad de 16 requiere cuatro unidades en total.", "Una cita inventada que no está"]},
            {"slide_id": "S9", "question": "¿Y esta?", "expected": "No existe.", "keywords": [], "evidence": []},
        ]})
    services.link = lambda: FakeLink(chat_handler=drafter)
    out = call(services, "rehearsal_prepare", deck_id="D1")
    assert out["objections"] == 1 and out["drafted_by_model"] is True
    [q] = services.store.list("question", out["rehearsal"])
    assert "La capacidad de 16 requiere" in q["explanation"] and "inventada" not in q["explanation"]


def test_undo_takes_back_the_check_then_the_rehearsal(services, hub):
    services.link = lambda: FakeLink(chat_handler=judge_by_keywords)
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=OBJECTIONS)["rehearsal"]
    call(services, "rehearsal_check", rehearsal=rid)
    hub.deck["slides"][1]["notes"] = "Para 16 colores hacen falta cuatro unidades."
    call(services, "rehearsal_check", rehearsal=rid)
    undone = call(services, "rehearsal_undo", rehearsal=rid)
    assert undone["undone"] == "check" and undone["runs_left"] == 1
    assert [d["slide_id"] for d in hub.sent[-1]["defects"]] == ["S2"]   # Cicero gets the previous verdict back
    call(services, "rehearsal_undo", rehearsal=rid)                      # the first check
    gone = call(services, "rehearsal_undo", rehearsal=rid)               # the rehearsal itself
    assert gone["undone"] == "prepare" and gone["subject_removed"] is True
    assert services.store.get("subject", rid) is None and services.store.list("question", rid) == []
    with pytest.raises(LookupError):
        call(services, "rehearsal_get", rehearsal=rid)


def test_unknown_slide_and_unreachable_cicero_are_explained(services, monkeypatch):
    with pytest.raises(LookupError, match="Start Cicero"):
        call(services, "rehearsal_prepare", deck_id="D1", objections=OBJECTIONS)   # the test Hub is closed
    with pytest.raises(ValueError, match="not in deck"):
        call(services, "rehearsal_prepare", deck_id="D1", deck=DECK, objections=[{**OBJECTIONS[0], "slide_id": "S7"}])
