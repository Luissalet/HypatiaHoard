"""Request guard: the shared guard in front of the app (host allow-list, Origin rule, Fetch Metadata, websockets).

The rules themselves are tested in the commons; here is what Hypatia relies on: which hosts its settings let in,
the 403 envelope the PWA reads, and that a websocket is guarded too."""

import pytest
from hoardtest import make_config
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hypatia.hoard_link.guard import install_guard, parse_allowed_hosts
from hypatia.main import create_app

NAV = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}
CORS = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty"}
IFRAME = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe"}


def test_middleware_navigation_reaches_root_but_not_embeds_or_fetches():
    app = FastAPI()
    install_guard(app, port_getter=lambda: 5187, allowed_hosts=parse_allowed_hosts("*.ts.net"), allowed_env="")

    @app.get("/")
    def home():
        return {"ok": True}

    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.get("/", headers=NAV).status_code == 200
        assert client.get("/", headers={**NAV, "host": "my-pc.ts.net"}).status_code == 200
        assert client.get("/", headers=IFRAME).status_code == 403
        assert client.get("/", headers=CORS).status_code == 403
        assert client.get("/", headers={**NAV, "host": "other.example"}).status_code == 403
        rejected = client.get("/", headers=CORS)
        assert rejected.json() == {"error": "Cross-site requests are not allowed."}


def test_websockets_are_guarded_too():
    app = FastAPI()
    install_guard(app, port_getter=lambda: 5187, allowed_env="")

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        await socket.send_text("hola")

    with TestClient(app, base_url="http://127.0.0.1") as client:
        with client.websocket_connect("/ws", headers={"host": "localhost"}) as ok:
            assert ok.receive_text() == "hola"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"host": "evil.example"}):
                pass


def test_allowed_hosts_setting_is_parsed_once_into_the_config(monkeypatch):
    from hypatia.config import Config

    monkeypatch.setenv("HYPATIA_ALLOWED_HOSTS", " pc.example , *.TS.net,, ")
    assert Config.from_env().allowed_hosts == ("pc.example", "*.ts.net")


@pytest.fixture
def guarded(tmp_path):
    app = create_app(make_config(tmp_path, allowed_hosts=parse_allowed_hosts("pc.example, *.ts.net")))
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client


def test_app_host_origin_and_cross_site_rules(guarded):
    get = lambda **headers: guarded.get("/api/health", headers=headers).status_code  # noqa: E731
    assert get() == 200
    assert get(host="pc.example") == 200
    assert get(host="My-PC.ts.net:8443") == 200
    assert get(host="evil.example") == 403
    assert get(host="ts.net") == 403
    assert get(origin="https://my-pc.ts.net:8443") == 200
    assert get(origin="http://localhost:5173") == 200
    assert get(origin="https://evil.example") == 403
    assert get(**NAV) == 200
    assert get(**CORS) == 403
    assert get(**IFRAME) == 403
    post = lambda **headers: guarded.post("/api/agent/call", json={}, headers=headers).status_code  # noqa: E731
    assert post(**NAV) == 403
    assert post(**CORS, origin="https://evil.example") == 403
    assert post(**{"sec-fetch-site": "same-origin", "sec-fetch-mode": "cors"}) != 403  # reaches the route (wants a token)


def test_app_without_allowed_hosts_is_local_only(client):
    assert client.get("/api/health", headers={"host": "my-pc.ts.net"}).status_code == 403
    assert client.get("/api/health", headers={"host": "[::1]:5187"}).status_code == 200
