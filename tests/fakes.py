"""Test doubles (not a test module): FakeLink, a stand-in for hoard_link.Link that
never touches the network, and a tiny WAV writer."""

from __future__ import annotations

import hashlib
import io
import json
import math
import wave
from typing import Any, Callable

from hypatia.hoard_link import ChatResult, Resolution, Unavailable, Usage

ALL_CAPABILITIES = ("llm", "embeddings", "tts", "vision")


def tiny_wav(ms: int = 100, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * (rate * ms // 1000))
    return buf.getvalue()


def default_reply(messages: list[dict[str, Any]], **kwargs: Any) -> str:
    """Canned replies by prompt kind (the system prompt says what is asked)."""
    system = " ".join(str(m.get("content")) for m in messages if m.get("role") == "system").lower()
    if "corrige" in system:
        return json.dumps({"verdict": "partial", "score": 6, "feedback": "Falta un concepto.", "missing": ["cohesión"]})
    if "redacta preguntas" in system:
        return json.dumps([
            {"type": "TEST", "prompt": "¿Qué es un requisito funcional?",
             "options": [{"id": "a", "text": "Lo que hace el sistema"}, {"id": "b", "text": "Cuánto tarda"}],
             "correctOptionIds": ["a"], "explanation": "Describe comportamiento.", "difficulty": 2},
            {"type": "DESARROLLO", "prompt": "Explica el acoplamiento.", "modelAnswer": "Grado de dependencia entre módulos.",
             "keywords": ["dependencia", "módulos"]},
            {"type": "TEST", "prompt": "Inválida sin opciones"},
        ])
    return "Respuesta de prueba [1]."


class FakeLink:
    def __init__(self, capabilities: tuple[str, ...] = ALL_CAPABILITIES,
                 chat_handler: Callable[..., str] | None = None, model: str = "fake-llm", dim: int = 16):
        self.capabilities = tuple(capabilities)
        self.chat_handler = chat_handler or default_reply
        self.model = model
        self.dim = dim
        self.calls: list[dict[str, Any]] = []

    async def resolve(self, capability: str) -> Resolution:
        ok = capability in self.capabilities
        return Resolution(capability=capability, provider="fake" if ok else None, url="http://fake" if ok else None,
                          model=self.model if ok else None, api="openai" if ok else None,
                          state="resolved" if ok else "unavailable", reason="fake")

    def _need(self, capability: str) -> None:
        if capability not in self.capabilities:
            raise Unavailable(capability, ["fake: not available"])

    async def chat(self, messages, images=None, max_tokens=None, temperature=None, capability="llm", response_format=None):
        self._need(capability)
        self.calls.append({"kind": "chat", "messages": messages, "capability": capability, "max_tokens": max_tokens,
                           "temperature": temperature, "response_format": response_format, "images": images})
        text = self.chat_handler(messages, capability=capability, response_format=response_format)
        return ChatResult(text=text, model=self.model, provider="fake", usage=Usage(1, 2, 3), elapsed_ms=1.0)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self._need("embeddings")
        self.calls.append({"kind": "embed", "n": len(texts)})
        out = []
        for text in texts:
            digest = hashlib.sha256(text.encode("utf-8")).digest()
            vec = [(digest[i % len(digest)] - 128) / 128 for i in range(self.dim)]
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out

    async def tts(self, text: str, voice: str | None = None) -> bytes:
        self._need("tts")
        self.calls.append({"kind": "tts", "text": text, "voice": voice})
        return tiny_wav()

    async def aclose(self) -> None:
        pass
