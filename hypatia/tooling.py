"""The Tool dataclass shared by every tool catalog (study tools, notebook tools)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:  # pragma: no cover
    from .services import Services


@dataclass(frozen=True)
class Tool:
    """One assistant tool: `run(services, validated_args)` returns JSON-able data."""

    name: str
    description: str
    input_model: type
    annotations: dict[str, bool]
    run: Callable[["Services", Any], Any]


def ann(read_only: bool, destructive: bool = False, idempotent: bool | None = None) -> dict[str, bool]:
    """MCP tool annotations; idempotent defaults to read_only."""
    return {
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "idempotentHint": read_only if idempotent is None else idempotent,
        "openWorldHint": False,
    }
