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
    """Reasoning models answer study tasks fine without thinking, and many times faster."""
    return os.environ.get("HYPATIA_LLM_THINKING", "0").strip().lower() in ("1", "true", "yes", "on")


async def link_chat(link, messages: list[dict[str, Any]], **kwargs: Any):
    """`link.chat(...)`, except for an already-resident model on llama.cpp or Ollama:
    that one is called directly with a long timeout (Hoard Link's own chat gives up
    after 120 s) and thinking off. Nothing has to load, so no VRAM lease is needed.
    Anything else (explicit config, Faustus registry, a model that would load,
    images) goes through Link unchanged."""
    res = await link.resolve(kwargs.get("capability", "llm"))
    details = getattr(res, "details", None) or {}
    provider, api = getattr(res, "provider", None), getattr(res, "api", None)
    direct = (getattr(res, "resolved", False) and details.get("resident") and getattr(res, "url", None)
              and not kwargs.get("images")
              and ((provider == "llamacpp" and api == "openai") or (provider == "ollama" and api == "ollama")))
    if not direct:
        return await link.chat(messages, **kwargs)
    if api == "ollama":
        url = _ollama_endpoint(res.url, "/api/chat")
        options: dict[str, Any] = {}
        if kwargs.get("temperature") is not None:
            options["temperature"] = kwargs["temperature"]
        if kwargs.get("max_tokens") is not None:
            options["num_predict"] = kwargs["max_tokens"]
        payload: dict[str, Any] = {"model": res.model, "messages": messages, "stream": False, "think": llm_thinking()}
        if options:
            payload["options"] = options
        fmt = _ollama_format(kwargs.get("response_format"))
        if fmt is not None:
            payload["format"] = fmt
    else:
        url = res.url if res.url.rstrip("/").endswith("/chat/completions") else res.url.rstrip("/") + "/chat/completions"
        payload = {"model": res.model, "messages": messages, "stream": False,
                   "chat_template_kwargs": {"enable_thinking": llm_thinking()}}
        for key in ("max_tokens", "temperature", "response_format"):
            if kwargs.get(key) is not None:
                payload[key] = kwargs[key]
    start = time.monotonic()
    async with httpx.AsyncClient(timeout=httpx.Timeout(llm_timeout_s(), connect=10.0), trust_env=False) as client:
        try:
            resp = await client.post(url, json=payload)
        except httpx.HTTPError as error:
            raise BackendError(provider, 0, f"{type(error).__name__}: {error}") from error
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
                      elapsed_ms=(time.monotonic() - start) * 1000.0, reasoning=reasoning or None)


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
