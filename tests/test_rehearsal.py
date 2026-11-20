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
    """Stands in for family.call: Cicero's deck_get, source_get and deck_defects_receive through the Hub.

    It keeps Cicero's open and closed defects by key (the key is the defect id here), with Cicero's rules: the verdict opens what
    fails, keeps open what is pending, closes the rest, and reopens the pending ones named in reopen."""

    def __init__(self, deck):
        self.deck = deck
        self.sent: list[dict] = []
        self.open: set[str] = set()
        self.closed: set[str] = set()
        self.source_text: str | None = "Un CFS admite cuatro colores. La capacidad de 16 requiere cuatro unidades en total."

    def __call__(self, app, tool, arguments=None, *, timeout=120.0):
        assert app == "cicero"
        if tool == "deck_get":
            return {"ok": True, "result": copy.deepcopy(self.deck)}
        if tool == "source_get":
            if self.source_text is None:
                return {"ok": False, "error": "source unavailable"}
            return {"ok": True, "result": {"text": self.source_text}}
        if tool == "deck_defects_receive":
            self.sent.append(arguments)
            failing, pending = {d["key"] for d in arguments["defects"]}, set(arguments.get("pending") or [])
            reopened = self.closed & (pending - failing) & set(arguments.get("reopen") or [])   # Cicero: pending minus what is sent
            resolved = sorted(self.open - failing - pending)
            self.open = failing | (self.open & pending) | reopened
            self.closed = (self.closed | set(resolved)) - self.open
            return {"ok": True, "result": {"opened": sorted(failing), "reopened": sorted(reopened), "resolved": resolved,
                                           "pending": sorted(self.open & pending),
                                           "open_total": len(self.open)}}
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


def test_unjudged_objection_stays_open_in_cicero(services, hub):
    """No model answers and the objection has no keywords: nothing is said to hold, and Cicero keeps its open defect."""
    bare = [{**OBJECTIONS[0], "keywords": []}, OBJECTIONS[1]]
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=bare)["rehearsal"]
    qid = next(o["question_id"] for o in call(services, "rehearsal_get", rehearsal=rid)["objections"] if o["slide_id"] == "S2")
    out = call(services, "rehearsal_check", rehearsal=rid)
    verdicts = {r["slide_id"]: r["verdict"] for r in out["results"]}
    assert verdicts == {"S2": "unjudged", "S1": "holds"} and out["holds"] == 1
    assert out["unjudged"] == [qid] and "holds its objections" not in out["next"]
    sent = hub.sent[-1]
    assert sent["defects"] == [] and sent["pending"] == [qid]            # the judged slide advances, the unjudged one stays open
    services.link = lambda: FakeLink(chat_handler=judge_by_keywords)     # the model answers again: a real verdict
    again = call(services, "rehearsal_check", rehearsal=rid)
    assert again["unjudged"] == [] and [d["key"] for d in hub.sent[-1]["defects"]] == [qid] and hub.sent[-1]["pending"] == []
    call(services, "rehearsal_undo", rehearsal=rid)
    assert hub.sent[-1]["defects"] == [] and hub.sent[-1]["pending"] == [qid]   # undo resends the previous verdict as it was


def test_undo_of_the_check_that_closed_a_pending_objection_reopens_it_in_cicero(services, hub):
    """fails -> unjudged (defect kept) -> holds (defect closed) -> undo: Cicero has the defect open again, as before the undone check."""
    def verdict(word):
        return FakeLink(chat_handler=lambda messages, **kw: json.dumps({"verdict": word, "missing": [], "feedback": word}))
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[{**OBJECTIONS[0], "keywords": []}])["rehearsal"]
    [qid] = [o["question_id"] for o in call(services, "rehearsal_get", rehearsal=rid)["objections"]]
    services.link = lambda: verdict("fails")
    call(services, "rehearsal_check", rehearsal=rid)
    services.link = lambda: FakeLink(capabilities=())                    # the judge does not answer
    assert call(services, "rehearsal_check", rehearsal=rid)["sent_to_cicero"]["kept_pending"] == 1 and hub.open == {qid}
    services.link = lambda: verdict("holds")
    assert call(services, "rehearsal_check", rehearsal=rid)["sent_to_cicero"]["resolved"] == 1 and hub.open == set()
    undone = call(services, "rehearsal_undo", rehearsal=rid)
    assert hub.open == {qid} and undone["cicero_restored"]["opened"] == 1 and undone["cicero_restored"]["open_total"] == 1
    assert hub.sent[-1]["pending"] == [qid] and hub.sent[-1]["reopen"] == [qid]


def test_undo_does_not_open_a_pending_objection_that_never_had_a_defect(services, hub):
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[{**OBJECTIONS[0], "keywords": []}])["rehearsal"]
    call(services, "rehearsal_check", rehearsal=rid)                     # no judge: pending, nothing opened
    services.link = lambda: FakeLink(chat_handler=lambda messages, **kw: json.dumps({"verdict": "holds", "missing": [], "feedback": ""}))
    call(services, "rehearsal_check", rehearsal=rid)
    call(services, "rehearsal_undo", rehearsal=rid)
    assert hub.open == set() and hub.sent[-1].get("reopen", []) == []


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


REPORT_R1 = "Un CFS admite cuatro colores. La capacidad de 16 requiere cinco unidades en total."
REPORT_R2 = "Un CFS admite cuatro colores. La capacidad de 16 requiere cuatro unidades en total."
STALE = {"slide_id": "S2", "question": "¿Cuántas unidades CFS hacen falta para llegar a 16 colores?", "expected": "Cinco unidades.",
         "keywords": ["cinco unidades"], "evidence": ["La capacidad de 16 requiere cinco unidades en total."]}


def model_that_redrafts(messages, **kwargs):
    """Rewrites an objection against the sources it is shown; judges a slide by the key points it is given."""
    user = messages[-1]["content"]
    if "Objeción anterior" in user:
        assert REPORT_R2 in user and "Cinco unidades." in user          # the new source and the old objection reached the model
        return json.dumps({"objections": [{"slide_id": "S2", "question": STALE["question"], "expected": "Cuatro unidades.",
                                           "keywords": ["cuatro unidades"],
                                           "evidence": ["La capacidad de 16 requiere cuatro unidades en total."]}]})
    slide, rest = user.split("Objeción:")
    keys = [k.strip() for k in rest.split("Puntos clave:")[1].split(",")]
    holds = all(k in slide.lower() for k in keys)
    return json.dumps({"verdict": "holds" if holds else "fails", "missing": [] if holds else keys, "feedback": ""})


def test_objection_is_written_again_when_the_source_it_cites_changes(services, hub):
    services.link = lambda: FakeLink(chat_handler=model_that_redrafts)
    hub.source_text = REPORT_R1
    hub.deck["slides"][1]["notes"] = "Para 16 colores hacen falta cuatro unidades."
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[STALE])["rehearsal"]
    first = call(services, "rehearsal_check", rehearsal=rid)
    assert first["weak_slides"] == ["S2"] and first["refreshed"] == []      # judged against the report it was written from

    hub.source_text = REPORT_R2                                              # the report gets a new revision
    second = call(services, "rehearsal_check", rehearsal=rid)
    [change] = second["refreshed"]
    assert change["slide_id"] == "S2" and change["by"] == "model" and "written again" in second["next"]
    assert second["weak_slides"] == [] and hub.sent[-1]["defects"] == []     # the slide holds the new objection: closed in Cicero
    [question] = services.store.list("question", rid)
    assert question["modelAnswer"] == "Cuatro unidades." and "cuatro unidades en total" in question["explanation"]
    third = call(services, "rehearsal_check", rehearsal=rid)
    assert third["refreshed"] == []                                          # the source did not change again

    call(services, "rehearsal_undo", rehearsal=rid)                         # the third check
    undone = call(services, "rehearsal_undo", rehearsal=rid)                # the check that rewrote it
    assert undone["objections_restored"] == 1
    [question] = services.store.list("question", rid)
    assert question["modelAnswer"] == "Cinco unidades." and question["keywords"] == ["cinco unidades"]
    assert [d["slide_id"] for d in hub.sent[-1]["defects"]] == ["S2"]       # Cicero gets the previous verdict back
    again = call(services, "rehearsal_check", rehearsal=rid)
    assert len(again["refreshed"]) == 1                                      # the change is seen again after the undo


def test_without_a_model_a_changed_source_keeps_only_the_quotes_it_still_holds(services, hub):
    hub.source_text = REPORT_R1
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[STALE])["rehearsal"]
    hub.source_text = REPORT_R2
    out = call(services, "rehearsal_check", rehearsal=rid, send=False)
    assert [c["by"] for c in out["refreshed"]] == ["evidence"]
    [objection] = call(services, "rehearsal_get", rehearsal=rid)["objections"]
    assert objection["evidence"] == [] and objection["expected"] == "Cinco unidades."


def test_an_unreadable_source_is_not_taken_for_a_change(services, hub):
    hub.source_text = REPORT_R1
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[STALE])["rehearsal"]
    hub.source_text = None                                                   # Cicero does not hand the source over
    assert call(services, "rehearsal_check", rehearsal=rid, send=False)["refreshed"] == []
    hub.source_text = REPORT_R1
    assert call(services, "rehearsal_check", rehearsal=rid, send=False)["refreshed"] == []


DATA_R1 = "Devoluciones por puesto: cicero 1, hypatia 0, writer 3."
DATA_R2 = "Devoluciones por puesto: cicero 6, hypatia 0, writer 6."
RETURNS = {"slide_id": "S2", "question": "¿Cuántas devoluciones tuvo cada puesto?", "expected": "Cicero 1, Hypatia 0, Writer 3.",
           "keywords": ["cicero 1", "writer 3"], "evidence": [DATA_R1]}


def model_on_returns(messages, **kwargs):
    """Rewrites the returns objection against the data it is shown; judges a slide by the key points it is given."""
    user = messages[-1]["content"]
    if "Objeción anterior" in user:
        assert DATA_R2 in user and "Cicero 1, Hypatia 0, Writer 3." in user
        return json.dumps({"objections": [{"slide_id": "S2", "question": RETURNS["question"],
                                           "expected": "Cicero 6, Hypatia 0, Writer 6.", "keywords": ["cicero 6", "writer 6"],
                                           "evidence": [DATA_R2]}]})
    slide, rest = user.split("Objeción:")
    keys = [k.strip() for k in rest.split("Puntos clave:")[1].split(",")]
    holds = all(k in slide.lower() for k in keys)
    return json.dumps({"verdict": "holds" if holds else "fails", "missing": [] if holds else keys, "feedback": ""})


def _returns_rehearsal(services, hub):
    """1/0/3 in the data, a slide that does not give it yet: the objection fails and its defect is open in Cicero.
    Then the data becomes 6/0/6 and Cicero refreshes the slide's figure."""
    services.link = lambda: FakeLink(chat_handler=model_on_returns)
    hub.source_text = DATA_R1
    hub.deck["slides"][1]["notes"] = "Devoluciones por puesto."
    rid = call(services, "rehearsal_prepare", deck_id="D1", objections=[RETURNS])["rehearsal"]
    [qid] = [o["question_id"] for o in call(services, "rehearsal_get", rehearsal=rid)["objections"]]
    assert call(services, "rehearsal_check", rehearsal=rid)["weak_slides"] == ["S2"] and hub.open == {qid}
    hub.source_text = DATA_R2
    hub.deck["slides"][1]["notes"] = "Devoluciones por puesto: cicero 6, hypatia 0, writer 6."
    return rid, qid


def test_while_the_model_is_down_a_changed_source_leaves_the_objection_pending_and_its_defect_as_it_was(services, hub):
    rid, qid = _returns_rehearsal(services, hub)
    sent_before = hub.sent[-1]["defects"]
    services.link = lambda: FakeLink(capabilities=())                          # the drafter (and judge) does not answer
    out = call(services, "rehearsal_check", rehearsal=rid)
    [result] = [r for r in out["results"] if r["slide_id"] == "S2"]
    assert result["verdict"] == "redraft_pending"                              # never judged against the 1/0/3 answer
    assert hub.sent[-1]["defects"] == [] and hub.sent[-1]["pending"] == [qid] and hub.open == {qid}
    [change] = out["refreshed"]
    assert change["by"] == "evidence" and change["redraft_pending"] is True   # quotes checked, question not written again
    assert out["pending_redraft"] == [qid] and "not written again yet" in out["next"]
    assert sent_before[0]["expected"] == "Cicero 1, Hypatia 0, Writer 3."      # the defect Cicero keeps is the previous one
    [objection] = call(services, "rehearsal_get", rehearsal=rid)["objections"]
    assert objection["expected"] == "Cicero 1, Hypatia 0, Writer 3." and objection["evidence"] == []
    assert objection["last"]["verdict"] == "redraft_pending"


def test_a_redraft_missed_while_the_model_was_down_is_done_once_it_answers_on_the_same_source(services, hub):
    rid, qid = _returns_rehearsal(services, hub)
    services.link = lambda: FakeLink(capabilities=())
    call(services, "rehearsal_check", rehearsal=rid)                            # pending: model down
    services.link = lambda: FakeLink(chat_handler=model_on_returns)            # the model is back; nothing else changes
    out = call(services, "rehearsal_check", rehearsal=rid)
    [change] = out["refreshed"]
    assert change["by"] == "model" and change["redraft_pending"] is False and change["question"] == RETURNS["question"]
    assert out["pending_redraft"] == [] and out["weak_slides"] == []
    [objection] = call(services, "rehearsal_get", rehearsal=rid)["objections"]
    assert objection["expected"] == "Cicero 6, Hypatia 0, Writer 6." and objection["evidence"] == [DATA_R2]
    [question] = services.store.list("question", rid)
    assert question["modelAnswer"] == "Cicero 6, Hypatia 0, Writer 6." and DATA_R2 in question["explanation"]
    assert hub.sent[-1]["defects"] == [] and hub.open == set()                  # judged on 6/0/6: the slide holds, closed in Cicero
    assert call(services, "rehearsal_check", rehearsal=rid)["refreshed"] == []  # written against this source: no further redraft

    call(services, "rehearsal_undo", rehearsal=rid)                             # the last check
    undone = call(services, "rehearsal_undo", rehearsal=rid)                    # the check that wrote it again
    assert undone["objections_restored"] == 1 and hub.open == {qid}             # Cicero has the previous defect open again
    [objection] = call(services, "rehearsal_get", rehearsal=rid)["objections"]
    assert objection["expected"] == "Cicero 1, Hypatia 0, Writer 3." and objection["evidence"] == []
    undone = call(services, "rehearsal_undo", rehearsal=rid)                    # the pending check
    assert undone["objections_restored"] == 1
    [objection] = call(services, "rehearsal_get", rehearsal=rid)["objections"]
    assert objection["evidence"] == [DATA_R1]
    assert len(call(services, "rehearsal_check", rehearsal=rid)["refreshed"]) == 1


def test_undo_gives_cicero_back_the_defect_a_pending_objection_had_before_the_undone_check(services, hub):
    """1/0/3 defect open -> pending (model down) -> redrafted on 6/0/6 and still failing (Cicero's defect now says 6/0/6) -> undo:
    the objection is pending again, and Cicero's open defect says again what it said before the undone check."""
    rid, qid = _returns_rehearsal(services, hub)
    hub.deck["slides"][1]["notes"] = "Devoluciones por puesto."                  # the slide does not give the figures
    services.link = lambda: FakeLink(capabilities=())
    call(services, "rehearsal_check", rehearsal=rid)
    services.link = lambda: FakeLink(chat_handler=model_on_returns)
    call(services, "rehearsal_check", rehearsal=rid)
    assert hub.sent[-1]["defects"][0]["expected"] == "Cicero 6, Hypatia 0, Writer 6." and hub.open == {qid}
    call(services, "rehearsal_undo", rehearsal=rid)
    [defect] = hub.sent[-1]["defects"]
    assert defect["key"] == qid and defect["expected"] == "Cicero 1, Hypatia 0, Writer 3." and hub.open == {qid}
