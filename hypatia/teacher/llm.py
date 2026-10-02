"""Model calls of the teacher role, through the same helper as the rest of the app
(`ai.chat`: Hoard Link, long timeout, the call's own reasoning level). A missing or
failing model becomes `NoModel`, which every feature turns into an explicit
"no model" state; nothing is ever made up in its place."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from .. import ai
from ..notebook.llm import parse_json  # noqa: F401 - tolerant JSON parsing shared with the notebook


class NoModel(Exception):
    def __init__(self, capability: str, detail: str):
        self.capability = capability
        self.detail = detail
        super().__init__(f"{capability}: {detail}")

    def note(self) -> str:
        return f"No hay modelo local ({self.capability}): {self.detail}"


@dataclass
class Reply:
    text: str
    model: Optional[str]


def chat(services: Any, messages: list[dict[str, Any]], *, max_tokens: int = 2048, temperature: float = 0.2,
         json_mode: bool = False, effort: Optional[str] = None, capability: str = "llm",
         images: Optional[list[bytes]] = None) -> Reply:
    kwargs: dict[str, Any] = {"max_tokens": max_tokens, "temperature": temperature, "effort": effort,
                              "capability": capability}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    if images:
        kwargs["images"] = images
    try:
        result = ai.chat(services, messages, **kwargs)
    except Exception as exc:  # noqa: BLE001 - Unavailable, BackendError, transport errors
        raise NoModel(capability, str(exc) or type(exc).__name__) from exc
    return Reply(text=(getattr(result, "text", "") or "").strip(), model=getattr(result, "model", None))


def resolve(services: Any, capability: str = "llm") -> tuple[bool, Optional[str], str]:
    """(resolved, model, reason); never raises."""
    async def probe(link):
        return await link.resolve(capability)

    try:
        res = services.with_link(probe)
    except Exception as exc:  # noqa: BLE001
        return False, None, str(exc) or type(exc).__name__
    return bool(getattr(res, "resolved", False)), getattr(res, "model", None), str(getattr(res, "reason", ""))
