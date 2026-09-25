"""Process-level configuration read from the environment (never from the DB)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .guard import parse_allowed_hosts

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 5187


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Config:
    """Everything the process needs before the database exists."""

    data_dir: Path = field(default_factory=lambda: REPO_ROOT / "data")
    port: int = DEFAULT_PORT
    port_strict: bool = False
    allowed_hosts: tuple[str, ...] = ()  # extra Host values (exact or *.suffix) besides localhost
    data_dir_configured: bool = False
    resources_dir: Path = field(default_factory=lambda: REPO_ROOT / "resources")
    dist_dir: Path = field(default_factory=lambda: REPO_ROOT / "dist-hoard")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "hypatia-hoard.db"

    @property
    def token_path(self) -> Path:
        return self.data_dir / "mcp-token"

    @classmethod
    def from_env(cls) -> "Config":
        raw_dir = _env("HYPATIA_DATA_DIR")
        port_raw = _env("HYPATIA_PORT") or _env("PORT") or str(DEFAULT_PORT)
        try:
            port = int(port_raw)
        except ValueError:
            port = DEFAULT_PORT
        if not 1 <= port <= 65535:
            port = DEFAULT_PORT
        resources = _env("HYPATIA_RESOURCES_DIR")
        return cls(
            data_dir=Path(raw_dir).expanduser() if raw_dir else REPO_ROOT / "data",
            port=port,
            port_strict=_env("PORT_STRICT") == "1",
            allowed_hosts=parse_allowed_hosts(_env("HYPATIA_ALLOWED_HOSTS")),
            data_dir_configured=bool(raw_dir),
            resources_dir=Path(resources).expanduser() if resources else REPO_ROOT / "resources",
        )
