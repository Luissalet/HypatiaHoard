"""Model calls of the teacher role, through the same helper as the rest of the app
(`ai.chat`: Hoard Link, long timeout, the call's own reasoning level). A missing or
failing model becomes `NoModel`, which every feature turns into an explicit
"no model" state; nothing is ever made up in its place."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from .. import ai
from ..notebook.llm import parse_json  # noqa: F401 - tolerant JSON parsing shared with the notebook

log = logging.getLogger("hypatia.teacher")


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
    format: Optional[str] = None


def chat(services: Any, messages: list[dict[str, Any]], *, max_tokens: int = 2048, temperature: float = 0.2,
         json_mode: bool = False, effort: Optional[str] = None, capability: str = "llm",
         images: Optional[list[bytes]] = None, schema: Optional[dict[str, Any]] = None,
         schema_name: str = "respuesta") -> Reply:
    """One model call. With `schema`, the reply is constrained to that JSON schema
    (response_format json_schema); a server that refuses it (an HTTP error, not a
    missing model) is asked again with plain JSON mode, then without any format."""
    kwargs: dict[str, Any] = {"max_tokens": max_tokens, "temperature": temperature, "effort": effort,
                              "capability": capability}
    if images:
        kwargs["images"] = images
    formats: list[Optional[dict[str, Any]]] = []
    if schema is not None:
        formats.append({"type": "json_schema", "json_schema": {"name": schema_name, "schema": schema, "strict": False}})
    if json_mode or schema is not None:
        formats.append({"type": "json_object"})
    formats.append(None)
    last: Optional[BaseException] = None
    for fmt in formats:
        call = dict(kwargs)
        if fmt is not None:
            call["response_format"] = fmt
        try:
            result = ai.chat(services, messages, **call)
        except ai.BackendError as exc:  # the server answered with an error: maybe it refuses this format
            last = exc
            if getattr(exc, "status", 0) and fmt is not None:
                log.info("model refused response_format %s (%s); trying a simpler one", fmt.get("type"), exc)
                continue
            raise NoModel(capability, str(exc) or type(exc).__name__) from exc
        except Exception as exc:  # noqa: BLE001 - Unavailable, transport errors
            raise NoModel(capability, str(exc) or type(exc).__name__) from exc
        return Reply(text=(getattr(result, "text", "") or "").strip(), model=getattr(result, "model", None),
                     format=fmt.get("type") if fmt else None)
    raise NoModel(capability, str(last) if last else "no reply")


def resolve(services: Any, capability: str = "llm") -> tuple[bool, Optional[str], str]:
    """(resolved, model, reason); never raises."""
    async def probe(link):
        return await link.resolve(capability)

    try:
        res = services.with_link(probe)
    except Exception as exc:  # noqa: BLE001
        return False, None, str(exc) or type(exc).__name__
    return bool(getattr(res, "resolved", False)), getattr(res, "model", None), str(getattr(res, "reason", ""))
