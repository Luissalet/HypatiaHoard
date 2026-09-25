"""/api/ai/v1/chat/completions — an OpenAI-compatible proxy to the local model
Hoard Link resolves, so the PWA's OpenAI provider works against this server."""

from __future__ import annotations

import base64
import time
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import ai
from .deps import services

router = APIRouter(prefix="/api/ai/v1")


class ChatBody(BaseModel):
    model: str | None = None
    messages: list[dict[str, Any]] = Field(..., min_length=1, max_length=500)
    max_tokens: int | None = Field(None, ge=1, le=65536)
    temperature: float | None = Field(None, ge=0, le=2)
    response_format: dict[str, Any] | None = None


def _flatten(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[bytes]]:
    """OpenAI content parts -> plain text messages + images (data: URLs only; no network)."""
    out, images = [], []
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            texts = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    texts.append(str(part.get("text") or ""))
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else part.get("image_url")
                    if isinstance(url, str) and url.startswith("data:") and "," in url:
                        images.append(base64.b64decode(url.split(",", 1)[1]))
            content = "\n".join(texts)
        out.append({"role": message.get("role") or "user", "content": content if content is not None else ""})
    return out, images


@router.post("/chat/completions")
def chat_completions(request: Request, body: ChatBody):
    svc = services(request)
    messages, images = _flatten(body.messages)
    kwargs: dict[str, Any] = {"max_tokens": body.max_tokens, "temperature": body.temperature,
                              "response_format": body.response_format}
    if images:
        kwargs.update(images=images, capability="vision")
    try:
        result = ai.chat(svc, messages, **kwargs)
    except ai.Unavailable as error:
        return JSONResponse({"error": f"No local model is available: {error}"}, status_code=503)
    except ai.BackendError as error:
        return JSONResponse({"error": f"The local model failed: {error}"}, status_code=502)
    usage = result.usage.to_dict() if result.usage else {}
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": result.model or body.model or "local",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": result.text}, "finish_reason": "stop"}],
        "usage": {k: usage.get(k) or 0 for k in ("prompt_tokens", "completion_tokens", "total_tokens")},
    }
