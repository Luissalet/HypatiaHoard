"""Shared fixtures: a settable clock, Services/TestClient on a temp data folder,
and FakeLink (no network ever: every Services gets a FakeLink with NO capability
by default; the `link` fixture swaps in one where everything resolves)."""

import sys
import warnings
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
for entry in (str(ROOT), str(ROOT / "tests")):
    if entry not in sys.path:
        sys.path.insert(0, entry)

warnings.filterwarnings("ignore", category=DeprecationWarning)

from fakes import FakeLink  # noqa: E402
from hoardtest import FakeClock, make_config, make_services  # noqa: E402,F401
from hypatia import ai  # noqa: E402
from hypatia.main import create_app  # noqa: E402


@pytest.fixture(autouse=True)
def _no_siblings(monkeypatch):
    """On the user's PC the sibling apps DO run (Prospero, Scribe, the hub):
    tests must never reach them, so point every sibling at a closed port."""
    from hypatia import voice

    monkeypatch.setenv("HYPATIA_PROSPERO_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("SCRIBE_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("HOARD_EVENTS", "0")
    monkeypatch.setenv("HOARD_HUB_URL", "http://127.0.0.1:1")
    voice.reset_cache()
    yield
    voice.reset_cache()


@pytest.fixture(autouse=True)
def _fresh_status_cache():
    ai.reset_status_cache()
    yield
    ai.reset_status_cache()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def services(tmp_path, clock):
    svc = make_services(tmp_path, clock)
    yield svc
    svc.stop()


@pytest.fixture
def link(services):
    """A FakeLink where llm/embeddings/tts/vision all resolve, installed on `services`."""
    fake = FakeLink()
    services.link = lambda: fake
    return fake


@pytest.fixture
def client(tmp_path, clock):
    from fastapi.testclient import TestClient

    svc = make_services(tmp_path, clock)
    app = create_app(svc.config, services=svc)
    with TestClient(app, base_url="http://127.0.0.1") as test_client:
        test_client.services = app.state.services
        test_client.clock = clock
        yield test_client
