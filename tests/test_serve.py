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
