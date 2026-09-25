"""Test helpers importable from any test module (a module name no other conftest shadows)."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

from fakes import FakeLink
from hypatia.config import Config
from hypatia.services import Services


class FakeClock:
    """`clock()` returns `.value` (tz-aware UTC); `.advance(seconds=, days=)` moves it."""

    def __init__(self, start: datetime = datetime(2026, 9, 25, 10, 0, 0, 123000, tzinfo=timezone.utc)):
        self.value = start

    def __call__(self) -> datetime:
        return self.value

    def advance(self, seconds: float = 0, days: float = 0) -> None:
        self.value += timedelta(seconds=seconds, days=days)


def make_config(tmp_path: Path, **overrides) -> Config:
    base = dict(data_dir=tmp_path / "data", data_dir_configured=True, resources_dir=tmp_path / "resources",
                dist_dir=tmp_path / "dist-hoard")
    base.update(overrides)
    return Config(**base)


def make_services(tmp_path: Path, clock, **overrides) -> Services:
    svc = Services(make_config(tmp_path, **overrides), clock=clock)
    offline = FakeLink(capabilities=())
    svc.link = lambda: offline
    return svc
