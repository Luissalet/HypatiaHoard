"""Thin sync wrappers over Hoard Link for the notebook, plus tolerant JSON parsing.

Every model call opens its own `services.link()` (an async context manager) and
runs through `services.run_async`, so callers stay synchronous (worker thread,
FastAPI sync endpoints, tools). A missing or failing model is reported as
`NoModel`, which every feature turns into a degraded answer (material + note).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Optional

try:  # vendored package; always present in the server
    from ..hoard_link import BackendError, HoardLinkError, Unavailable
except Exception:  # pragma: no cover
    class HoardLinkError(Exception):  # type: ignore[no-redef]
        pass

    class Unavailable(HoardLinkError):  # type: ignore[no-redef]
        pass

    class BackendError(HoardLinkError):  # type: ignore[no-redef]
        pass


NO_LLM_NOTE = (
    "No hay ningún modelo local disponible (llm). Se devuelven los pasajes/material para que el "
    "asistente redacte la respuesta él mismo, citando con [n]."
)


class NoModel(Exception):
    """No model resolved for a capability, or the resolved backend failed."""

    def __init__(self, capability: str, detail: str):
        self.capability = capability
        self.detail = detail
        super().__init__(f"{capability}: {detail}")

    def note(self) -> str:
        if self.capability == "llm":
            return f"{NO_LLM_NOTE} ({self.detail})"
        return f"Capacidad '{self.capability}' no disponible: {self.detail}"


@dataclass
class Reply:
    text: str
    model: Optional[str]


def _wrap(capability: str, exc: BaseException) -> NoModel:
    return NoModel(capability, str(exc) or exc.__class__.__name__)


def chat(services: Any, messages: list[dict[str, Any]], *, max_tokens: int = 2048,
         temperature: float = 0.3, json_mode: bool = False) -> Reply:
    kwargs: dict[str, Any] = {"max_tokens": max_tokens, "temperature": temperature}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    async def run() -> Any:
        from ..ai import link_chat  # long timeout + thinking off for a resident llama.cpp

        async with services.link() as link:
            return await link_chat(link, messages, **kwargs)

    try:
        result = services.run_async(run())
    except Exception as exc:  # noqa: BLE001 - Unavailable, BackendError, transport errors
        raise _wrap("llm", exc) from exc
    return Reply(text=(getattr(result, "text", "") or "").strip(), model=getattr(result, "model", None))


def embed(services: Any, batches: list[list[str]]) -> tuple[Optional[str], list[list[list[float]]]]:
    """Embed several batches with one Link: (model, [vectors per batch]). Raises NoModel."""

    async def run() -> Any:
        async with services.link() as link:
            res = await link.resolve("embeddings")
            if not getattr(res, "resolved", False):
                raise Unavailable("embeddings", [str(getattr(res, "reason", "unresolved"))])
            out = []
            for batch in batches:
                out.append(list(await link.embed(batch)))
            return getattr(res, "model", None), out

    try:
        return services.run_async(run())
    except Exception as exc:  # noqa: BLE001 - Unavailable, BackendError, transport errors
        raise _wrap("embeddings", exc) from exc


def resolve(services: Any, capability: str) -> tuple[bool, Optional[str], str]:
    """(resolved, model, reason). Never raises."""

    async def run() -> Any:
        async with services.link() as link:
            return await link.resolve(capability)

    try:
        res = services.run_async(run())
    except Exception as exc:  # noqa: BLE001 - resolution must never break a feature
        return False, None, str(exc) or exc.__class__.__name__
    return bool(getattr(res, "resolved", False)), getattr(res, "model", None), str(getattr(res, "reason", ""))


def tts_many(services: Any, pieces: list[tuple[str, Optional[str]]]) -> list[bytes]:
    """Synthesize several (text, voice) pieces. Hoard Link's `tts` when it resolves
    (explicit config or Faustus); otherwise Prospero's Hoard, the family's voice
    studio. Raises NoModel when neither is available."""

    async def resolved() -> bool:
        async with services.link() as link:
            return bool(getattr(await link.resolve("tts"), "resolved", False))

    try:
        use_link = services.run_async(resolved())
    except Exception:  # noqa: BLE001 - resolution must not break the podcast
        use_link = False
    if use_link:
        async def run() -> list[bytes]:
            out: list[bytes] = []
            async with services.link() as link:
                for text, voice in pieces:
                    out.append(await link.tts(text, None if voice in ("@A", "@B") else voice))
            return out

        try:
            return services.run_async(run())
        except Exception as exc:  # noqa: BLE001 - Unavailable, BackendError, transport errors
            raise _wrap("tts", exc) from exc

    from .. import voice

    if not voice.prospero_available():
        raise NoModel("tts", f"ni Hoard Link resuelve tts ni Prospero's Hoard responde en {voice.prospero_url()}")
    engine, (va, vb) = voice.podcast_settings(services.config.data_dir)
    out: list[bytes] = []
    for text, ref in pieces:
        ref = va if ref in (None, "@A") else vb if ref == "@B" else ref
        try:
            out.append(voice.speak(text, ref, engine))
        except voice.VoiceError as exc:
            if ref and ref != va:  # second voice not downloaded in Prospero: fall back to the first
                try:
                    out.append(voice.speak(text, va, engine))
                    continue
                except voice.VoiceError:
                    pass
            raise NoModel("tts", str(exc)) from exc
    return out


# ---------------------------------------------------------------- JSON parsing

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)


def parse_json(text: str) -> Any:
    """Parse a model's JSON reply tolerantly; returns None when nothing parses.

    Strips ``` fences, then tries the whole text, then the span from the first
    `[` or `{` to its matching last bracket, trimming trailing garbage.
    """
    if not text:
        return None
    candidates: list[str] = []
    m = _FENCE_RE.search(text)
    if m:
        candidates.append(m.group(1).strip())
    candidates.append(text.strip())
    for cand in candidates:
        try:
            return json.loads(cand)
        except ValueError:
            pass
        starts = [i for i in (cand.find("["), cand.find("{")) if i >= 0]
        if not starts:
            continue
        start = min(starts)
        closer = "]" if cand[start] == "[" else "}"
        end = cand.rfind(closer)
        while end > start:
            try:
                return json.loads(cand[start:end + 1])
            except ValueError:
                end = cand.rfind(closer, start, end)
        decoder = json.JSONDecoder()
        try:
            obj, _ = decoder.raw_decode(cand[start:])
            return obj
        except ValueError:
            continue
    return None
