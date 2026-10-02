"""Voices for the podcast through Prospero's Hoard, the family's voice studio.

Hoard Link resolves `tts` only from explicit configuration or a running Faustus; when neither
answers, Hypatia asks Prospero's Hoard through the family hub (`fam_media.speak`, the `voice_tts`
tool), which already has Piper with Spanish voices. Nothing is installed from here: if Prospero
is not running, the podcast keeps its script and says why.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .hoard_link import fam_media

DEFAULT_ENGINE = "piper"
DEFAULT_VOICES = ("es_ES-davefx-medium", "es_ES-sharvard-medium")


def prospero_available() -> bool:
    """True when the hub is up and Prospero's Hoard is running (cached 30 s by the client)."""
    return fam_media.available("tts")


def reset_cache() -> None:
    fam_media.forget_availability()


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


def speak(text: str, voice_ref: Optional[str], engine: str = DEFAULT_ENGINE, timeout: float = 300.0) -> bytes:
    """WAV bytes for `text` from Prospero through the hub. Raises VoiceError."""
    res = fam_media.speak_bytes(text, voice=voice_ref, engine=engine, lang="es", timeout_s=timeout, local_fallback=False)
    if not res.get("ok"):
        raise VoiceError(f"Prospero's Hoard rechazó la voz {voice_ref!r}: {res.get('error') or 'sin respuesta'}")
    return res["data"]
