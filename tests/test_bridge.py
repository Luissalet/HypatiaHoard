"""The MCP bridge: autostart when nothing answers, and the catalog it serves comes from the app."""
import asyncio
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(monkeypatch, autostart: str):
    monkeypatch.setenv("HYPATIA_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("HYPATIA_BRIDGE_AUTOSTART", autostart)
    spec = importlib.util.spec_from_file_location("hypatia_bridge_under_test", ROOT / "mcp_server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_nothing_answers_and_autostart_is_off(monkeypatch):
    bridge = load(monkeypatch, "0")
    assert bridge._healthy() is False
    assert bridge.ensure_running(timeout_s=1) is False


def test_nothing_answers_so_the_bridge_starts_the_app(monkeypatch, tmp_path):
    bridge = load(monkeypatch, "1")
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path))
    started = []
    answers = iter([False, True])
    monkeypatch.setattr(bridge, "_healthy", lambda: next(answers, True))
    monkeypatch.setattr(bridge.subprocess, "Popen", lambda argv, **kw: started.append((argv, kw["env"], kw["cwd"])))
    assert bridge.ensure_running(timeout_s=5) is True
    argv, env, cwd = started[0]
    assert argv == [sys.executable, "-m", "hypatia"] and Path(cwd) == ROOT
    assert env["HYPATIA_PORT"] == "1" and env["PORT_STRICT"] == "1"
    assert (tmp_path / "logs").is_dir()


def test_bridge_lists_the_app_catalog(monkeypatch, client):
    bridge = load(monkeypatch, "0")
    data = client.get("/api/agent/tools").json()
    server = bridge.HypatiaBridge(data["tools"], data["instructions"])
    tools = asyncio.run(server.list_tools())
    names = {t.name for t in tools}
    assert {"cards_due", "card_review", "exam_mock", "cards_add", "decks_list"} <= names
    due = next(t for t in tools if t.name == "cards_due")
    assert due.annotations.readOnlyHint is True and "Sinónimos" in due.description
    assert "127.0.0.1:5187" in data["instructions"]
