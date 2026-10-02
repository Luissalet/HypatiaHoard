"""`python -m hypatia` when another instance already serves."""
import pytest

from hypatia import __main__ as entry
from hypatia.hoard_link import net


def test_a_second_start_leaves_the_running_instance_alone(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(net, "already_running", lambda service, port, **kw: service == "hypatia-hoard")
    import uvicorn

    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: pytest.fail("a second server must not start"))
    entry.serve()
    assert "already running" in capsys.readouterr().out
    assert not (tmp_path / "data").exists()  # nothing was opened or rewritten (database, token)


def test_the_url_the_server_listens_on_is_recorded_for_the_bridge(monkeypatch, tmp_path):
    monkeypatch.setenv("HYPATIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HYPATIA_PORT", "5191")
    monkeypatch.setenv("PORT_STRICT", "1")
    monkeypatch.setattr(net, "already_running", lambda *a, **k: False)
    import uvicorn

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw))
    entry.serve()
    assert seen["port"] == 5191
    assert (tmp_path / "data" / "url").read_text() == "http://127.0.0.1:5191"
