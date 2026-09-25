"""The podcast speaks through Prospero's Hoard when Hoard Link has no tts."""
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

from hypatia import voice
from hypatia.notebook import llm


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(22050), w.writeframes(b"\x00\x00" * 100)
    return buf.getvalue()


class _Prospero(BaseHTTPRequestHandler):
    calls: list = []
    missing = {"es_ES-sharvard-medium"}

    def do_GET(self):  # noqa: N802
        self._send(200, "application/json", json.dumps({"service": "prosperos-hoard"}).encode())

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Prospero.calls.append(body)
        if body["voice"]["voice_ref"] in _Prospero.missing:
            self._send(404, "application/json", b'{"error":"voice not downloaded"}')
        else:
            self._send(200, "audio/wav", _wav())

    def _send(self, code, ctype, data):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def test_tts_many_falls_back_to_prospero(monkeypatch, tmp_path, clock):
    from hoardtest import make_services

    server = HTTPServer(("127.0.0.1", 0), _Prospero)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("HYPATIA_PROSPERO_URL", f"http://127.0.0.1:{server.server_port}")
    voice.reset_cache()
    svc = make_services(tmp_path, clock)  # FakeLink without capabilities: no tts in Hoard Link
    try:
        blobs = llm.tts_many(svc, [("Hola", "@A"), ("Qué tal", "@B")])
        assert len(blobs) == 2 and all(b[:4] == b"RIFF" for b in blobs)
        refs = [c["voice"]["voice_ref"] for c in _Prospero.calls]
        # host B's default voice is missing in Prospero -> falls back to host A's
        assert refs == ["es_ES-davefx-medium", "es_ES-sharvard-medium", "es_ES-davefx-medium"]
        assert all(c["voice"]["engine_id"] == "piper" for c in _Prospero.calls)
    finally:
        svc.stop()
        server.shutdown()


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
