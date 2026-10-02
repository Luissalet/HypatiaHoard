"""The podcast speaks through Prospero's Hoard (via the family hub) when Hoard Link has no tts."""
import io
import wave

from hypatia import voice
from hypatia.hoard_link import fam_media, family
from hypatia.notebook import llm


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(22050), w.writeframes(b"\x00\x00" * 100)
    return buf.getvalue()


class FakeHub:
    """Stands in for ``family.call``: answers the ``voice_tts`` tool of Prospero like the hub would."""

    missing = {"es_ES-sharvard-medium"}

    def __init__(self, tmp_path):
        self.calls: list[dict] = []
        self.dir = tmp_path

    def __call__(self, app, tool, arguments=None, **kwargs):
        assert app == "prospero" and tool == "voice_tts"
        args = dict(arguments or {})
        self.calls.append(args)
        if args.get("voice") in self.missing:
            return {"ok": False, "app": app, "tool": tool, "status": 404, "error": "voice not downloaded", "contract": 1}
        path = self.dir / f"tts-{len(self.calls)}.wav"
        path.write_bytes(_wav())
        return {"ok": True, "app": app, "tool": tool, "status": 200, "contract": 1,
                "result": {"ok": True, "path": str(path), "engine_id": args.get("engine") or "piper", "bytes": path.stat().st_size}}


def test_tts_many_falls_back_to_prospero(monkeypatch, tmp_path, clock):
    from hoardtest import make_services

    hub = FakeHub(tmp_path)
    monkeypatch.setattr(family, "call", hub)
    monkeypatch.setattr(fam_media, "available", lambda *a, **k: True)
    svc = make_services(tmp_path, clock)  # FakeLink without capabilities: no tts in Hoard Link
    try:
        blobs = llm.tts_many(svc, [("Hola", "@A"), ("Qué tal", "@B")])
        assert len(blobs) == 2 and all(b[:4] == b"RIFF" for b in blobs)
        refs = [c["voice"] for c in hub.calls]
        # host B's default voice is missing in Prospero -> falls back to host A's
        assert refs == ["es_ES-davefx-medium", "es_ES-sharvard-medium", "es_ES-davefx-medium"]
        assert all(c["engine"] == "piper" for c in hub.calls)
    finally:
        svc.stop()


def test_speak_reports_the_hubs_refusal(monkeypatch, tmp_path):
    monkeypatch.setattr(family, "call", FakeHub(tmp_path))
    try:
        voice.speak("hola", "es_ES-sharvard-medium")
    except voice.VoiceError as exc:
        assert "es_ES-sharvard-medium" in str(exc) and "voice not downloaded" in str(exc)
    else:
        raise AssertionError("expected VoiceError")


def test_no_prospero_means_no_tts(tmp_path, clock):
    from hoardtest import make_services

    svc = make_services(tmp_path, clock)
    try:
        try:
            llm.tts_many(svc, [("Hola", "@A")])
        except llm.NoModel as exc:
            assert exc.capability == "tts" and "Prospero" in exc.detail
        else:
            raise AssertionError("expected NoModel")
    finally:
        svc.stop()
