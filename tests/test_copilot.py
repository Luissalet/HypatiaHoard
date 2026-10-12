"""The Faustus copilot in Hypatia's Hoard: relay routes, launcher in the PWA shell, manifest and the off switch."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

from hoardtest import make_config, make_services
from hypatia.hoard_link.copilot import has_copilot, install_copilot
from hypatia.main import create_app

ROOT = Path(__file__).resolve().parent.parent


def build(tmp_path, clock, shell=True):
    config = make_config(tmp_path)
    if shell:
        config.dist_dir.mkdir(parents=True)
        (config.dist_dir / "index.html").write_text("<html><body><div id='root'></div></body></html>", encoding="utf-8")
    svc = make_services(tmp_path, clock)
    return create_app(svc.config, services=svc), svc


@pytest.fixture
def app_client(tmp_path, clock):
    app, svc = build(tmp_path, clock)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, app
    svc.stop()


@pytest.fixture
def fake_faustus():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            ok = self.path == "/api/hoard-copilot/capabilities"
            body = json.dumps({"contract_version": "1.0"} if ok else {}).encode()
            self.send_response(200 if ok else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def test_the_app_mounts_the_relay_and_the_launcher(app_client):
    client, app = app_client
    assert has_copilot(app) and app.state.hoard_copilot == "hypatia"
    launcher = client.get("/api/copilot/launcher.js")
    assert launcher.status_code == 200 and "javascript" in launcher.headers["content-type"] and "faustus-chat" in launcher.text
    # the relay answers (503 when no Faustus runs here); the PWA catch-all never swallows it
    assert client.get("/api/copilot/panel.js").status_code in (200, 503)
    assert client.post("/api/copilot/proxy", json={"path": "/api/other"}).status_code == 400
    assert client.get("/api/copilot/nope").status_code == 404


def test_the_pwa_shell_carries_the_launcher_and_the_api_stays_json(app_client):
    client, _ = app_client
    page = client.get("/")
    assert page.status_code == 200 and '<script type="module" src="/api/copilot/launcher.js"></script></body>' in page.text
    assert client.get("/api/unknown").json() == {"error": "Not found."}


def test_the_relay_names_this_app_and_its_data_space(tmp_path, fake_faustus):
    app = FastAPI()
    install_copilot(app, "hypatia", tmp_path, app_name="Hypatia's Hoard", faustus_urls=[fake_faustus], token="")
    info = TestClient(app).get("/api/copilot/info").json()
    assert info["app_id"] == "hypatia" and info["app_name"] == "Hypatia's Hoard"
    assert info["data_space_id"] and info["panel_url"] == "/api/copilot/panel.js"


def test_the_launcher_is_added_to_the_html_an_app_serves(tmp_path, fake_faustus):
    app = FastAPI()

    @app.get("/", response_class=HTMLResponse)
    def home():
        return "<html><body><p>hi</p></body></html>"

    install_copilot(app, "hypatia", tmp_path, app_name="Hypatia's Hoard", faustus_urls=[fake_faustus], token="")
    assert "/api/copilot/launcher.js" in TestClient(app).get("/").text


def test_the_manifest_declares_the_copilot_context():
    manifest = json.loads((ROOT / "faustus-plugin.json").read_text("utf-8"))
    copilot = manifest["x-family"]["copilot"]
    assert copilot["provider"] == "faustus" and copilot["contract"] == "1.0" and copilot["panel"] == "/api/copilot/panel.js"
    assert {"subject", "topic", "question", "session", "editor"} <= set(copilot["context"])
    assert manifest["x-family"]["agenda"] is True  # what was there stays


def test_the_off_switch_removes_the_routes(tmp_path, clock, monkeypatch):
    monkeypatch.setenv("HOARD_COPILOT", "0")
    app, svc = build(tmp_path, clock)
    try:
        assert not has_copilot(app)
        with TestClient(app, base_url="http://127.0.0.1") as client:
            assert "launcher.js" not in client.get("/").text
    finally:
        svc.stop()
