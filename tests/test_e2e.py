"""Boot the real app in a subprocess, then talk to it over HTTP and through the MCP stdio bridge."""

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from hypatia.port import free_port

ROOT = Path(__file__).resolve().parent.parent


def wait_health(url: str, process: subprocess.Popen, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"app exited early with code {process.returncode}")
        try:
            if httpx.get(f"{url}/api/health", timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise AssertionError("app did not become healthy")


@pytest.fixture
def app_process(tmp_path):
    port = free_port()
    data_dir = tmp_path / "data"
    env = {
        **os.environ,
        "HYPATIA_DATA_DIR": str(data_dir),
        "HYPATIA_PORT": str(port),
        "PORT_STRICT": "1",
        "PYTHONUNBUFFERED": "1",
    }
    process = subprocess.Popen([sys.executable, "-m", "hypatia"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    try:
        wait_health(url, process)
        yield url, data_dir, env
    finally:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()


def test_subprocess_http_and_mcp_bridge(app_process):
    url, data_dir, env = app_process
    health = httpx.get(f"{url}/api/health").json()
    assert health["service"] == "hypatia-hoard" and health["dataDirConfigured"] is True
    tools = httpx.get(f"{url}/api/agent/tools").json()["tools"]
    assert [t["name"] for t in tools][:2] == ["decks_list", "deck_create"]

    token = (data_dir / "mcp-token").read_text().strip()
    assert len(token) == 64
    assert httpx.post(f"{url}/api/agent/call", json={"name": "decks_list"}).status_code == 401
    auth = {"Authorization": f"Bearer {token}"}

    deck = httpx.post(f"{url}/api/agent/call", json={"name": "deck_create", "arguments": {"name": "E2E"}}, headers=auth).json()["deck"]
    added = httpx.post(
        f"{url}/api/agent/call",
        json={"name": "cards_add", "arguments": {"deck": "E2E", "cards": [{"front": "¿Capital de Valdeniebla?", "back": "Villa del Sauce", "source": "mapa.pdf"}]}},
        headers=auth,
    ).json()
    assert added["count"] == 1
    card_id = added["cards"][0]["id"]

    async def through_mcp():
        from mcp.client.session import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        params = StdioServerParameters(
            command=sys.executable,
            args=[str(ROOT / "mcp_server.py")],
            env={**env, "HYPATIA_URL": url, "HYPATIA_TOKEN_FILE": str(data_dir / "mcp-token")},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                assert "SM-2" in (init.instructions or "") or "grade" in (init.instructions or "").lower()
                listed = await session.list_tools()
                names = [t.name for t in listed.tools]
                assert names == [t["name"] for t in tools]
                write_tool = next(t for t in listed.tools if t.name == "cards_add")
                assert write_tool.annotations.readOnlyHint is False
                destructive_tool = next(t for t in listed.tools if t.name == "card_delete")
                assert destructive_tool.annotations.destructiveHint is True

                due = json.loads((await session.call_tool("cards_due", {"deck": "E2E"})).content[0].text)
                assert due["count"] == 1 and due["queue"][0]["back"] == "Villa del Sauce"

                graded = json.loads((await session.call_tool("card_review", {"id": card_id, "grade": "good"})).content[0].text)
                assert graded["card"]["repetitions"] == 1

                searched = json.loads((await session.call_tool("cards_search", {"q": "Valdeniebla"})).content[0].text)
                assert searched["count"] >= 1

                bad = json.loads((await session.call_tool("card_review", {"id": 999999, "grade": "good"})).content[0].text)
                assert "error" in bad

    asyncio.run(through_mcp())
