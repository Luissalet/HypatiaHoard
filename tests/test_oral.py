"""Oral cards: spoken question, transcribed answer, comparison by meaning, review recorded."""

import json
from pathlib import Path

import pytest

from fakes import FakeLink, tiny_wav
from hypatia import oral
from hypatia.agent_tools import call_tool, tool_catalog

TEST_Q = {"type": "TEST", "prompt": "¿En qué capa trabaja **TCP**?",
          "options": [{"id": "o1", "text": "Red"}, {"id": "o2", "text": "Transporte"}, {"id": "o3", "text": "Enlace"}],
          "correctOptionIds": ["o2"], "explanation": "TCP es de transporte."}
DEV_Q = {"type": "DESARROLLO", "prompt": "Explica el *handshake* de TCP.", "modelAnswer": "SYN, SYN-ACK y ACK: tres pasos.",
         "keywords": ["SYN", "ACK", "tres pasos"]}
CLOZE_Q = {"type": "COMPLETAR", "prompt": "Completa", "clozeText": "TCP usa {{b1}} y {{b2}}",
           "blanks": [{"id": "b1", "accepted": ["puertos"]}, {"id": "b2", "accepted": ["números de secuencia", "secuencias"]}]}


def call(services, name, **args):
    return call_tool(services, name, args)


def judge_reply(verdict="correct", score=9, covered=("Los tres pasos",), missing=(), feedback="Has nombrado los tres pasos."):
    def handler(messages, **_):
        system = messages[0]["content"]
        assert "ORAL" in system and "significado" in system
        return json.dumps({"verdict": verdict, "score": score, "covered": list(covered), "missing": list(missing),
                           "feedback": feedback})
    return handler


def add_in_order(services, clock, questions):
    """One by one, a second apart: the due queue asks never-seen cards oldest first."""
    ids = []
    for question in questions:
        clock.advance(seconds=1)
        ids.append(call(services, "questions_add", subject="Redes", topic="Transporte", questions=[question])["questions"][0]["id"])
    return ids


@pytest.fixture
def bank(services, clock):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Redes", "createdAt": now, "updatedAt": now})
    services.store.put("topic", {"id": "t1", "subjectId": "s1", "title": "Transporte", "order": 0, "createdAt": now, "updatedAt": now})
    ids = add_in_order(services, clock, [DEV_Q, TEST_Q, CLOZE_Q])
    clock.advance(seconds=1)
    call(services, "page_card_add", subject="Redes", title="Resumen de TCP", html="<p>TCP es fiable.</p>")
    return dict(zip(("DESARROLLO", "TEST", "COMPLETAR"), ids))


def reviews(services):
    with services.db.lock:
        return [tuple(row) for row in
                services.db.conn.execute("SELECT question_id, grade, via FROM reviews ORDER BY rowid").fetchall()]


# ---------- text for the voice ----------

def test_spoken_question_reads_options_and_gaps():
    assert oral.spoken_question(TEST_Q) == "¿En qué capa trabaja TCP? Opciones: a, Red. b, Transporte. c, Enlace."
    assert oral.spoken_question(CLOZE_Q) == "Completa TCP usa hueco y hueco."
    assert oral.speakable("La **media** es $\\frac{a}{b}$ ![x](y.png) [ver](http://z)") == "La media es fracción a b ver"
    assert oral.expected_answer(TEST_Q) == "b) Transporte"


def test_spoken_commands_and_no_answer():
    assert oral.spoken_command("Repite la pregunta, ¿puedes?") is None
    assert oral.spoken_command("Repite la pregunta.") == "repeat"
    assert oral.spoken_command("¡Siguiente!") == "skip" and oral.spoken_command("Parar") == "stop"
    assert oral.is_no_answer("Pues no lo sé.") and oral.is_no_answer("Ni idea") and not oral.is_no_answer("No sé si es la red")
    assert oral.spoken_options(TEST_Q, "La be") == ["o2"] and oral.spoken_options(TEST_Q, "Creo que es transporte") == ["o2"]
    assert oral.spoken_options(TEST_Q, "la segunda") == ["o2"] and oral.spoken_options(TEST_Q, "ninguna de esas") == []


# ---------- the queue ----------

def test_next_card_skips_pages_and_excluded(services, link, bank):
    first = call(services, "oral_card_next", subject="Redes")
    assert first["remaining"] == 3 and first["card"]["id"] == bank["DESARROLLO"]
    card = first["card"]
    assert "modelAnswer" not in card and card["spoken"] == "Explica el handshake de TCP."
    audio = card["audio"]
    assert Path(audio["path"]).is_file() and audio["url"] == f"/api/study/oral/audio/{audio['name']}"
    assert [c for c in link.calls if c["kind"] == "tts"][0]["text"] == card["spoken"]
    # The same text is synthesized once.
    call(services, "oral_card_next", subject="Redes")
    assert len([c for c in link.calls if c["kind"] == "tts"]) == 1
    second = call(services, "oral_card_next", subject="Redes", exclude=[card["id"]], speak=False)
    assert second["card"]["id"] == bank["TEST"] and second["card"]["audio"] is None
    assert second["card"]["options"][1] == {"id": "o2", "letter": "b", "text": "Transporte"}
    done = call(services, "oral_card_next", subject="Redes", exclude=list(bank.values()))
    assert done["card"] is None and done["remaining"] == 0 and done["note"]


# ---------- an answer ----------

def test_answer_by_meaning_records_the_review(services, bank):
    fake = FakeLink(chat_handler=judge_reply(covered=["SYN", "SYN-ACK", "ACK"]))
    services.link = lambda: fake
    out = call(services, "oral_card_answer", id=bank["DESARROLLO"], subject="Redes",
               transcript="Primero se manda un sin, luego sin ac y al final ac")
    assert out["verdict"] == "correct" and out["grade"] == "good" and out["recorded"] and out["by"] == "model"
    assert out["covered"] == ["SYN", "SYN-ACK", "ACK"] and out["missing"] == []
    assert out["review"]["result"] == "CORRECT" and out["review"]["nextReviewAt"] > services.today()
    assert reviews(services) == [(bank["DESARROLLO"], "good", "oral")]
    assert out["feedbackSpoken"] == "Correcto. Has nombrado los tres pasos."
    assert Path(out["feedbackAudio"]["path"]).is_file()
    # The next card is another one, already spoken.
    assert out["next"]["card"]["id"] == bank["TEST"] and out["next"]["card"]["audio"]
    user = [c for c in fake.calls if c["kind"] == "chat"][0]["messages"][1]["content"]
    assert "Respuesta esperada: SYN, SYN-ACK y ACK: tres pasos." in user and "sin ac" in user
    stats = services.store.get("question", bank["DESARROLLO"])["stats"]
    assert stats["seen"] == 1 and stats["lastResult"] == "CORRECT"


def test_partial_and_wrong_say_what_was_missing(services, bank):
    fake = FakeLink(chat_handler=judge_reply("partial", 5, ["SYN"], ["El ACK final"], "Te has dejado el último paso."))
    services.link = lambda: fake
    out = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Se manda un SYN", speak_feedback=False)
    assert out["grade"] == "hard" and out["missing"] == ["El ACK final"] and out["feedbackAudio"] is None
    assert out["feedbackSpoken"] == "Casi. Te has dejado el último paso. Te ha faltado: El ACK final."
    fake.chat_handler = judge_reply("wrong", 0, [], ["Los tres pasos"], "Eso es de otra capa.")
    out = call(services, "oral_card_answer", id=bank["TEST"], transcript="La de red", record=False, speak_feedback=False)
    assert out["grade"] == "again" and not out["recorded"] and "review" not in out
    assert out["feedbackSpoken"] == "No es correcto. Eso es de otra capa. La respuesta es: b) Transporte."
    assert [r[0] for r in reviews(services)] == [bank["DESARROLLO"]]


def test_audio_is_transcribed_first(services, link, bank, tmp_path, monkeypatch):
    seen = {}

    def fake_transcribe(path, language="es"):
        seen["path"], seen["language"] = Path(path), language
        return {"ok": True, "text": "La be", "via": "prospero", "language": "es", "duration_s": 1.2}

    monkeypatch.setattr(oral, "transcribe", fake_transcribe)
    link.chat_handler = judge_reply("correct", 10, ["Transporte"], [], "Es la capa de transporte.")
    wav = tmp_path / "respuesta.wav"
    wav.write_bytes(tiny_wav())
    out = call(services, "oral_card_answer", id=bank["TEST"], audio_path=str(wav))
    assert seen == {"path": wav, "language": "es"}
    assert out["transcript"] == "La be" and out["transcription"] == {"via": "prospero", "language": "es", "duration_s": 1.2}
    assert out["recorded"] and out["grade"] == "good"
    with pytest.raises(LookupError):
        call(services, "oral_card_answer", id=bank["TEST"], audio_path=str(tmp_path / "no.wav"))
    with pytest.raises(ValueError):
        call(services, "oral_card_answer", id=bank["TEST"])


def test_silence_commands_and_no_answer(services, link, bank, monkeypatch):
    monkeypatch.setattr(oral, "transcribe", lambda path, language="es": {"ok": True, "text": "  ", "via": "funes"})
    wav = Path(services.config.data_dir) / "silencio.wav"
    wav.write_bytes(tiny_wav())
    quiet = call(services, "oral_card_answer", id=bank["DESARROLLO"], audio_path=str(wav))
    assert quiet["heard"] is False and not quiet["recorded"] and "next" not in quiet
    again = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Repite la pregunta")
    assert again["action"] == "repeat" and not again["recorded"]
    skipped = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Siguiente")
    assert skipped["action"] == "skip" and skipped["next"]["card"]["id"] == bank["TEST"]
    assert reviews(services) == [] and not [c for c in link.calls if c["kind"] == "chat"]
    blank = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Pues no me acuerdo")
    assert blank["verdict"] == "wrong" and blank["grade"] == "again" and blank["by"] == "rule"
    assert reviews(services) == [(bank["DESARROLLO"], "again", "oral")]
    assert not [c for c in link.calls if c["kind"] == "chat"]
    monkeypatch.setattr(oral, "transcribe", lambda path, language="es": {"ok": False, "error": "Funes: funes unreachable"})
    failed = call(services, "oral_card_answer", id=bank["TEST"], audio_path=str(wav))
    assert failed["error"] == "stt_unavailable" and not failed["recorded"]


def test_without_a_model_rules_grade_options_and_gaps(services, bank):
    right = call(services, "oral_card_answer", id=bank["TEST"], transcript="La be", speak_feedback=False)
    assert right["verdict"] == "correct" and right["recorded"] and right["by"] == "rule" and right["model"] is None
    half = call(services, "oral_card_answer", id=bank["COMPLETAR"], transcript="usa puertos y ventanas", speak_feedback=False)
    assert half["verdict"] == "partial" and half["covered"] == ["puertos"] and half["missing"] == ["números de secuencia"]
    open_answer = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Se envía un SYN y después un ACK",
                       speak_feedback=False)
    assert open_answer["verdict"] is None and open_answer["needsSelfGrade"] and not open_answer["recorded"]
    assert open_answer["covered"] == ["SYN", "ACK"] and open_answer["missing"] == ["tres pasos"]
    assert open_answer["feedbackSpoken"] == "Compara con la respuesta: SYN, SYN-ACK y ACK: tres pasos."
    forced = call(services, "oral_card_answer", id=bank["DESARROLLO"], transcript="Se envía un SYN y después un ACK",
                  grade="hard", speak_feedback=False)
    assert forced["recorded"] and forced["grade"] == "hard"
    assert [r[1] for r in reviews(services)] == ["good", "hard", "hard"]


def test_page_cards_are_not_oral(services, bank):
    page = next(q for q in services.store.list("question", "s1") if q.get("pageHtml"))
    with pytest.raises(ValueError):
        call(services, "oral_card_answer", id=page["id"], transcript="la recuerdo")


# ---------- transcription chain ----------

def test_transcribe_falls_back_to_the_voice_studio(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(oral.fam_media, "transcribe",
                        lambda path, **kw: {"ok": False, "error": "funes unreachable", "kind": "app_down"})
    monkeypatch.setenv("HOARD_HOME", str(tmp_path / "hoard"))
    monkeypatch.setattr(oral, "_under_home", lambda path: False)

    def fake_call(app, tool, arguments=None, *, timeout=120.0):
        staged = Path(arguments["path"])
        calls.append((app, tool, staged.parent, staged.is_file(), arguments["language"]))
        return {"ok": True, "status": 200, "result": {"text": " Hola ", "language": "es", "engine_id": "faster-whisper"}}

    monkeypatch.setattr(oral.family, "call", fake_call)
    wav = tmp_path / "a.wav"
    wav.write_bytes(tiny_wav())
    out = oral.transcribe(wav, "es")
    assert out == {"ok": True, "text": "Hola", "via": "prospero", "language": "es", "duration_s": None}
    assert calls == [("prospero", "voice_transcribe", tmp_path / "hoard" / "tmp" / "oral", True, "es")]
    assert list((tmp_path / "hoard" / "tmp" / "oral").iterdir()) == []      # the staged copy is removed
    monkeypatch.setattr(oral.fam_media, "transcribe",
                        lambda path, **kw: {"ok": False, "error": "hub unreachable", "kind": "hub_down"})
    monkeypatch.setattr("hypatia.hoard_link.media.stt.available", lambda: False)
    down = oral.transcribe(wav, "es")
    assert down["ok"] is False and "Funes" in down["error"] and len(calls) == 1


def test_the_voice_studio_module_is_turned_on_when_it_is_off(tmp_path, monkeypatch):
    from hypatia import voice

    calls, state = [], {"on": False}

    def fake_call(app, tool, arguments=None, **kwargs):
        assert app == "prospero"
        calls.append(tool)
        if tool == "studio_module_set":
            state["on"] = arguments["module"] == "generation" and arguments["enabled"] is True and bool(arguments["reason"])
            return {"ok": True, "status": 200, "contract": 1, "result": {"ok": True}}
        if not state["on"]:
            return {"ok": False, "status": 409, "contract": 1, "error": "generation is OFF. Enable it explicitly in Modules."}
        if tool == "voice_tts":
            spoken = tmp_path / "spoken.wav"
            spoken.write_bytes(tiny_wav())
            return {"ok": True, "status": 200, "contract": 1, "result": {"ok": True, "path": str(spoken), "engine_id": "piper"}}
        return {"ok": True, "status": 200, "contract": 1, "result": {"text": "hola", "language": "es"}}

    monkeypatch.setattr(oral.family, "call", fake_call)
    assert voice.speak("Hola", "es_ES-davefx-medium") == tiny_wav()
    assert calls == ["voice_tts", "studio_module_set", "voice_tts"]
    state["on"] = False
    calls.clear()
    monkeypatch.setattr(oral.fam_media, "transcribe",
                        lambda path, **kw: {"ok": False, "error": "funes unreachable", "kind": "app_down"})
    monkeypatch.setattr(oral, "_under_home", lambda path: True)
    wav = tmp_path / "a.wav"
    wav.write_bytes(tiny_wav())
    assert oral.transcribe(wav)["text"] == "hola"
    assert calls == ["voice_transcribe", "studio_module_set", "voice_transcribe"]
    # Any other refusal is not a reason to touch the modules.
    assert voice.wake_studio("voice not downloaded") is False


def test_save_answer_audio_picks_the_extension(tmp_path, monkeypatch):
    monkeypatch.setenv("HOARD_HOME", str(tmp_path))
    assert oral.save_answer_audio(b"x" * 10, "audio/webm;codecs=opus").suffix == ".webm"
    assert oral.save_answer_audio(b"x" * 10, "application/octet-stream", "nota.MP3").suffix == ".mp3"
    assert oral.save_answer_audio(b"x" * 10, "", "raro.exe").suffix == ".webm"
    with pytest.raises(ValueError):
        oral.save_answer_audio(b"")


# ---------- REST and catalog ----------

def test_rest_routes(client, monkeypatch):
    svc = client.services
    fake = FakeLink(chat_handler=judge_reply("correct", 10, ["Transporte"], [], "Bien."))
    svc.link = lambda: fake
    now = svc.now_iso()
    svc.store.put("subject", {"id": "s1", "name": "Redes", "createdAt": now, "updatedAt": now})
    ids = add_in_order(svc, client.clock, [TEST_Q, DEV_Q])
    monkeypatch.setattr("hypatia.hoard_link.media.stt.available", lambda: False)
    status = client.get("/api/study/oral/status").json()
    assert status["tts"] is True and status["llm"] is True and status["stt"] is None
    card = client.post("/api/study/oral/next", json={"subject": "Redes"}).json()["card"]
    assert card["id"] == ids[0]
    served = client.get(card["audio"]["url"])
    assert served.status_code == 200 and served.headers["content-type"] == "audio/wav" and served.content == tiny_wav()
    assert client.get("/api/study/oral/audio/../../mcp-token").status_code == 404
    assert client.get("/api/study/oral/audio/" + "0" * 24 + ".wav").status_code == 404
    monkeypatch.setenv("HOARD_HOME", str(svc.config.data_dir / "home"))
    heard = {}

    def fake_transcribe(path, language="es"):
        heard["suffix"], heard["bytes"] = Path(path).suffix, Path(path).read_bytes()
        return {"ok": True, "text": "transporte", "via": "prospero", "language": "es", "duration_s": 0.4}

    monkeypatch.setattr(oral, "transcribe", fake_transcribe)
    out = client.post(f"/api/study/oral/answer-audio?id={ids[0]}&subject=Redes&exclude=zz", content=b"RIFFfake",
                      headers={"Content-Type": "audio/wav"}).json()
    assert heard == {"suffix": ".wav", "bytes": b"RIFFfake"}
    assert out["recorded"] and out["grade"] == "good" and out["next"]["card"]["id"] == ids[1]
    assert list((svc.config.data_dir / "home" / "tmp" / "oral").iterdir()) == []
    assert client.post(f"/api/study/oral/answer-audio?id={ids[0]}", content=b"").status_code == 400
    typed = client.post("/api/study/oral/answer", json={"id": ids[1], "transcript": "SYN, SYN-ACK, ACK", "record": False}).json()
    assert typed["verdict"] == "correct" and not typed["recorded"]
    assert client.post("/api/study/oral/answer", json={"id": "nope", "transcript": "x"}).status_code == 404
    spoken = client.post("/api/study/oral/speak", json={"text": "Hola **mundo**"}).json()
    assert spoken["ok"] and spoken["text"] == "Hola mundo" and spoken["duration_s"] == 0.1


def test_speak_without_a_voice(services):
    assert call(services, "oral_speak", text="Hola")["ok"] is False
    card = call(services, "oral_card_next")
    assert card["card"] is None


def test_catalog_has_the_oral_tools():
    catalog = {item["name"]: item for item in tool_catalog()}
    assert len(catalog) == 79
    assert catalog["oral_card_next"]["annotations"]["readOnlyHint"] is True
    assert catalog["oral_card_answer"]["annotations"]["readOnlyHint"] is False
    assert set(catalog["oral_card_answer"]["inputSchema"]["properties"]) >= {"id", "audio_path", "transcript", "record", "exclude"}
