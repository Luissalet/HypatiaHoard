"""Voices for the podcast through Prospero's Hoard, the family's voice studio.

Hoard Link resolves `tts` only from explicit configuration or a running Faustus;
when neither answers, Hypatia asks Prospero's Hoard (`POST /api/voice/speak`),
which already has Piper with Spanish voices. Nothing is installed from here:
if Prospero is not running, the podcast keeps its script and says why.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

import httpx

from .config import REPO_ROOT

DEFAULT_ENGINE = "piper"
DEFAULT_VOICES = ("es_ES-davefx-medium", "es_ES-sharvard-medium")
_TTL_S = 30.0
_cache: dict[str, tuple[float, bool]] = {}
_lock = threading.Lock()


def prospero_url() -> str:
    """HYPATIA_PROSPERO_URL, else the sibling app's data/url, else its fixed port."""
    env = os.environ.get("HYPATIA_PROSPERO_URL", "").strip()
    if env:
        return env.rstrip("/")
    sibling = REPO_ROOT.parent / "Prospero's Hoard" / "data" / "url"
    try:
        text = sibling.read_text(encoding="utf-8-sig").strip()
        if text.startswith("http://127.0.0.1") or text.startswith("http://localhost"):
            return text.rstrip("/")
    except OSError:
        pass
    return "http://127.0.0.1:8815"


def prospero_available(url: Optional[str] = None) -> bool:
    url = url or prospero_url()
    with _lock:
        hit = _cache.get(url)
        if hit and time.monotonic() - hit[0] < _TTL_S:
            return hit[1]
    try:
        resp = httpx.get(f"{url}/api/health", timeout=2.0, trust_env=False)
        ok = resp.status_code == 200 and resp.json().get("service") == "prosperos-hoard"
    except Exception:  # noqa: BLE001 - availability probe
        ok = False
    with _lock:
        _cache[url] = (time.monotonic(), ok)
    return ok


def reset_cache() -> None:
    with _lock:
        _cache.clear()


def podcast_settings(data_dir: Path) -> tuple[str, tuple[str, str]]:
    """(engine_id, (voice A, voice B)) from data/backend.json `podcast`, else Piper's Spanish voices."""
    try:
        raw = json.loads((Path(data_dir) / "backend.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raw = {}
    pod = raw.get("podcast") if isinstance(raw, dict) else None
    pod = pod if isinstance(pod, dict) else {}
    engine = str(pod.get("engine") or DEFAULT_ENGINE)
    voices = pod.get("voices") if isinstance(pod.get("voices"), list) else []
    a = str(voices[0]) if len(voices) > 0 and voices[0] else DEFAULT_VOICES[0]
    b = str(voices[1]) if len(voices) > 1 and voices[1] else DEFAULT_VOICES[1]
    return engine, (a, b)


class VoiceError(RuntimeError):
    pass


def speak(text: str, voice_ref: Optional[str], engine: str = DEFAULT_ENGINE, url: Optional[str] = None,
          timeout: float = 300.0) -> bytes:
    """WAV bytes for `text` from Prospero. Raises VoiceError."""
    url = url or prospero_url()
    body = {"text": text, "voice": {"engine_id": engine, "voice_ref": voice_ref}}
    try:
        resp = httpx.post(f"{url}/api/voice/speak", json=body, timeout=timeout, trust_env=False)
    except httpx.HTTPError as error:
        raise VoiceError(f"Prospero's Hoard no responde en {url}: {error}") from error
    if resp.status_code >= 400 or not resp.headers.get("content-type", "").startswith("audio/"):
        raise VoiceError(f"Prospero's Hoard rechazó la voz {voice_ref!r}: HTTP {resp.status_code} {resp.text[:200]}")
    return resp.content
