"""Model access through Hoard Link: one chat helper, capability status (cached),
and JSON parsing of model replies."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any

import httpx

from .hoard_link import BackendError, Unavailable
from .hoard_link import reasoning as _reasoning
from .hoard_link.link import _ollama_endpoint, _ollama_format, _strip_think
from .hoard_link.types import ChatResult, Usage

STATUS_CAPABILITIES = ("llm", "embeddings", "tts", "vision")
STATUS_TTL_S = 30.0

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)

__all__ = ["BackendError", "Unavailable", "chat", "capabilities", "parse_json", "reset_status_cache"]


def llm_timeout_s() -> float:
    """How long one chat call may take. Hoard Link's own chat gives up after 120 s,
    which a big local model sharing its slots (and thinking first) easily needs."""
    try:
        return max(30.0, float(os.environ.get("HYPATIA_LLM_TIMEOUT_S", "900")))
    except ValueError:
        return 900.0


def llm_thinking() -> bool:
    """The old switch: `HYPATIA_LLM_THINKING=1` let every call think."""
    return os.environ.get("HYPATIA_LLM_THINKING", "0").strip().lower() in ("1", "true", "yes", "on")


def llm_effort(requested: Any = None) -> Any:
    """The reasoning level a call runs at (see `hoard_link.reasoning`).

    `HYPATIA_LLM_EFFORT` (off/low/medium/high/max) is the owner's knob and wins
    over everything; else the level the call asked for (grading, drafting
    questions and composing a study guide ask to think, bulk note-taking does
    not); else `HYPATIA_LLM_THINKING=1` means "high"; else off."""
    forced = _reasoning.normalize(os.environ.get("HYPATIA_LLM_EFFORT"))
    if forced is not None:
        return forced
    asked = _reasoning.normalize(requested)
    if asked is not None:
        return asked
    return "high" if llm_thinking() else "off"


async def link_chat(link, messages: list[dict[str, Any]], **kwargs: Any):
    """`link.chat(...)`, except for an already-resident model on llama.cpp or Ollama:
    that one is called directly with a long timeout (Hoard Link's own chat gives up
    after 120 s) and thinking off. Nothing has to load, so no VRAM lease is needed.
    Anything else (explicit config, Faustus registry, a model that would load,
    images) goes through Link unchanged."""
    level = llm_effort(kwargs.pop("effort", None))
    res = await link.resolve(kwargs.get("capability", "llm"))
    details = getattr(res, "details", None) or {}
    provider, api = getattr(res, "provider", None), getattr(res, "api", None)
    direct = (getattr(res, "resolved", False) and details.get("resident") and getattr(res, "url", None)
              and not kwargs.get("images")
              and ((provider == "llamacpp" and api == "openai") or (provider == "ollama" and api == "ollama")))
    if not direct:
        return await link.chat(messages, effort=level, **kwargs)
    if api == "ollama":
        url = _ollama_endpoint(res.url, "/api/chat")
        options: dict[str, Any] = {}
        if kwargs.get("temperature") is not None:
            options["temperature"] = kwargs["temperature"]
        if kwargs.get("max_tokens") is not None:
            options["num_predict"] = kwargs["max_tokens"]
        payload: dict[str, Any] = {"model": res.model, "messages": messages, "stream": False}
        if options:
            payload["options"] = options
        _reasoning.apply_ollama(payload, level)
        fmt = _ollama_format(kwargs.get("response_format"))
        if fmt is not None:
            payload["format"] = fmt
    else:
        url = res.url if res.url.rstrip("/").endswith("/chat/completions") else res.url.rstrip("/") + "/chat/completions"
        payload = {"model": res.model, "messages": messages, "stream": False}
        for key in ("max_tokens", "temperature", "response_format"):
            if kwargs.get(key) is not None:
                payload[key] = kwargs[key]
        _reasoning.apply_openai(payload, level)
    start = time.monotonic()
    timeout = max(llm_timeout_s(), _reasoning.timeout_for(120.0, level))
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0), trust_env=False) as client:
        async def post():
            try:
                return await client.post(url, json=payload)
            except httpx.HTTPError as error:
                raise BackendError(provider, 0, f"{type(error).__name__}: {error}") from error

        resp = await post()
        # Same recovery as Hoard Link's own chat: a chat template that refuses the
        # reasoning fields (llama-server answers 500 with the template's
        # raise_exception, or 400 naming them) gets the nearest effort name it
        # lists, and failing that the call once more without the reasoning fields.
        if resp.status_code >= 400 and level is not None and _reasoning.looks_like_reasoning_error(resp.status_code, resp.text):
            if _reasoning.remap_effort(payload, _reasoning.supported_efforts(resp.text)):
                resp = await post()
            if (resp.status_code >= 400 and _reasoning.looks_like_reasoning_error(resp.status_code, resp.text)
                    and _reasoning.strip(payload)):
                resp = await post()
    if resp.status_code >= 400:
        raise BackendError(provider, resp.status_code, resp.text[:200])
    try:
        data = resp.json()
        message = data["message"] if api == "ollama" else data["choices"][0]["message"]
        if not isinstance(message, dict):
            raise TypeError("message is not an object")
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise BackendError(provider, resp.status_code, f"unexpected chat response: {resp.text[:160]}") from error
    text, think = _strip_think(message.get("content") or "")
    if api == "ollama":
        usage = Usage(prompt_tokens=data.get("prompt_eval_count"), completion_tokens=data.get("eval_count"))
        reasoning = message.get("thinking") or think
    else:
        usage_raw = data.get("usage") or {}
        usage = Usage(prompt_tokens=usage_raw.get("prompt_tokens"), completion_tokens=usage_raw.get("completion_tokens"),
                      total_tokens=usage_raw.get("total_tokens"))
        reasoning = message.get("reasoning_content") or think
    return ChatResult(text=text, model=res.model, provider=provider, usage=usage,
                      elapsed_ms=(time.monotonic() - start) * 1000.0, reasoning=reasoning or None, effort=level)


def chat(services, messages: list[dict[str, Any]], **kwargs: Any):
    """A chat call from sync code; raises Unavailable / BackendError like Link does."""
    return services.with_link(lambda link: link_chat(link, messages, **kwargs))


_cache_lock = threading.Lock()
_cache: dict[int, tuple[float, dict[str, bool]]] = {}


def reset_status_cache() -> None:
    with _cache_lock:
        _cache.clear()


def capabilities(services) -> dict[str, bool]:
    """{llm, embeddings, tts, vision} -> resolves right now? Cached 30 s; never raises."""
    key = id(services)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < STATUS_TTL_S:
            return dict(hit[1])

    async def probe(link) -> dict[str, bool]:
        out = {}
        for capability in STATUS_CAPABILITIES:
            try:
                out[capability] = bool((await link.resolve(capability)).resolved)
            except Exception:  # noqa: BLE001 - status must never fail
                out[capability] = False
        return out

    try:
        models = services.with_link(probe)
    except Exception:  # noqa: BLE001
        models = {c: False for c in STATUS_CAPABILITIES}
    if not models.get("tts"):
        from . import voice  # the podcast can also speak through Prospero's Hoard

        models["tts"] = voice.prospero_available()
    with _cache_lock:
        _cache[key] = (time.monotonic(), models)
    return dict(models)


def parse_json(text: str) -> Any:
    """Best-effort JSON from a model reply (fences stripped, first array/object found). None if hopeless."""
    body = _FENCE_RE.sub("", (text or "").strip())
    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        pass
    for pattern in (r"\[.*\]", r"\{.*\}"):
        match = re.search(pattern, body, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except ValueError:
                continue
    return None
