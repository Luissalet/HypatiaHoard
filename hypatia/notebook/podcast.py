"""Audio overview: a two-host Spanish dialogue script, TTS per turn and WAV concatenation."""

from __future__ import annotations

import io
import json
import re
import wave
from pathlib import Path
from typing import Any, Optional

from . import llm

TURN_SILENCE_MS = 300
MAX_TTS_CHARS = 450
MAX_TURNS = 60

SCRIPT_SYSTEM = """Escribes guiones de pódcast educativo en español de España, natural y cercano, con dos presentadores:
- A (Ana): guía la conversación, plantea preguntas y resume.
- B (Bruno): explica con ejemplos y analogías, matiza y conecta ideas.
Reglas:
- Diálogo hablado real: frases cortas, reacciones naturales ("Exacto", "Espera, ¿entonces…?"), sin leer listas.
- Solo lo que dice cada uno: NADA de acotaciones, efectos, música, risas, nombres delante del texto, asteriscos, emojis ni Markdown.
- Todo el contenido sale del material; no inventes datos. No leas números de cita [n] en voz alta.
- Fórmulas: dilas con palabras ("la suma de…"), nunca LaTeX.
- Duración: entre 1300 y 2000 palabras (unos 10 minutos), 24–40 intervenciones alternas; empieza con una presentación breve del tema y termina con un repaso de las 3–5 ideas clave.
Devuelve SOLO JSON: {"title": "...", "turns": [{"speaker": "A", "text": "..."}, {"speaker": "B", "text": "..."}]}"""

_STAGE = re.compile(r"(\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|<[^>]*>)")
_LABEL = re.compile(r"^\s*(A|B|Ana|Bruno|Presentador[ae]? ?[AB12]?|Host ?[AB12])\s*[:\-–—]\s*", re.IGNORECASE)


def clean_turn_text(text: str) -> str:
    text = _STAGE.sub(" ", str(text or ""))
    text = _LABEL.sub("", text.strip())
    text = re.sub(r"[#_`$\\]|\*\*", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([.,;:!?…])", r"\1", text)
    return text


def normalize_script(raw: Any, fallback_title: str) -> Optional[dict[str, Any]]:
    """Validate/clean a model script: speakers A/B, no stage directions, non-empty turns."""
    if isinstance(raw, list):
        raw = {"turns": raw}
    if not isinstance(raw, dict):
        return None
    turns_in = raw.get("turns") or raw.get("dialogue") or raw.get("dialogo") or []
    if not isinstance(turns_in, list):
        return None
    turns: list[dict[str, str]] = []
    for i, t in enumerate(turns_in):
        if isinstance(t, str):
            speaker, text = ("A" if i % 2 == 0 else "B"), t
        elif isinstance(t, dict):
            sp = str(t.get("speaker") or t.get("host") or "").strip().upper()
            speaker = "B" if sp.startswith("B") or sp.endswith(" B") or sp.endswith("2") else ("A" if sp else ("A" if i % 2 == 0 else "B"))
            text = t.get("text") or t.get("line") or ""
        else:
            continue
        text = clean_turn_text(text)
        if not text:
            continue
        if turns and turns[-1]["speaker"] == speaker:
            turns[-1]["text"] += " " + text
        else:
            turns.append({"speaker": speaker, "text": text})
        if len(turns) >= MAX_TURNS:
            break
    if len(turns) < 2:
        return None
    title = clean_turn_text(raw.get("title") or fallback_title)[:120] or fallback_title
    return {"title": title, "turns": turns}


def word_count(script: dict[str, Any]) -> int:
    return sum(len(t["text"].split()) for t in script.get("turns", []))


def script_markdown(script: dict[str, Any]) -> str:
    names = {"A": "Ana", "B": "Bruno"}
    lines = [f"# {script['title']}", ""]
    for t in script["turns"]:
        lines.append(f"**{names.get(t['speaker'], t['speaker'])}:** {t['text']}")
        lines.append("")
    return "\n".join(lines).strip()


def load_voices(data_dir: Path) -> tuple[Optional[str], Optional[str]]:
    path = Path(data_dir) / "backend.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None, None
    voices = ((data or {}).get("podcast") or {}).get("voices") if isinstance(data, dict) else None
    if not isinstance(voices, list):
        return None, None
    a = voices[0] if len(voices) > 0 and voices[0] else None
    b = voices[1] if len(voices) > 1 and voices[1] else None
    return (str(a) if a else None), (str(b) if b else None)


def split_for_tts(text: str, limit: int = MAX_TTS_CHARS) -> list[str]:
    if len(text) <= limit:
        return [text]
    sentences = re.split(r"(?<=[.!?…;:])\s+", text)
    out: list[str] = []
    cur = ""
    for s in sentences:
        while len(s) > limit:
            cut = s.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(s[:cut].strip())
            s = s[cut:].strip()
        if cur and len(cur) + 1 + len(s) > limit:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return [p for p in out if p]


class AudioFormatError(ValueError):
    pass


def concat_wavs(segments: list[tuple[bytes, bool]], silence_ms: int = TURN_SILENCE_MS) -> bytes:
    """Concatenate WAV blobs. Each segment is (wav_bytes, starts_new_turn); silence goes
    before a segment that starts a new turn. All segments must share channels, sample
    width and rate (no resampling)."""
    params = None
    frames: list[bytes] = []
    for i, (blob, new_turn) in enumerate(segments):
        try:
            with wave.open(io.BytesIO(blob), "rb") as w:
                p = (w.getnchannels(), w.getsampwidth(), w.getframerate())
                data = w.readframes(w.getnframes())
        except (wave.Error, EOFError) as exc:
            raise AudioFormatError(f"El fragmento {i + 1} de TTS no es un WAV PCM válido: {exc}") from exc
        if params is None:
            params = p
        elif p != params:
            raise AudioFormatError(
                "Los fragmentos de TTS tienen formatos distintos "
                f"(canales/bits/Hz {params[0]}/{params[1] * 8}/{params[2]} frente a {p[0]}/{p[1] * 8}/{p[2]}); "
                "usa voces del mismo motor/frecuencia en data/backend.json → podcast.voices."
            )
        if frames and new_turn and silence_ms > 0:
            n = int(params[2] * silence_ms / 1000)
            frames.append(b"\x00" * n * params[0] * params[1])
        frames.append(data)
    if params is None:
        raise AudioFormatError("No hay audio que concatenar")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(params[0])
        w.setsampwidth(params[1])
        w.setframerate(params[2])
        w.writeframes(b"".join(frames))
    return out.getvalue()


def synthesize(services: Any, script: dict[str, Any], out_path: Path) -> dict[str, Any]:
    """TTS every turn and write one WAV. Returns {audioPath?, note?, error?}; never raises NoModel."""
    va, vb = load_voices(services.config.data_dir)
    # No voices configured: "@A"/"@B" mean "the default voice of host A/B" -- Hoard Link's
    # tts gets None, Prospero's Hoard gets its two Spanish Piper voices (llm.tts_many).
    va, vb = va or "@A", vb or "@B"
    pieces: list[tuple[str, Optional[str]]] = []
    starts: list[bool] = []
    for t in script["turns"]:
        for j, part in enumerate(split_for_tts(t["text"])):
            pieces.append((part, va if t["speaker"] == "A" else vb))
            starts.append(j == 0)
    try:
        blobs = llm.tts_many(services, pieces)
    except llm.NoModel as exc:
        return {"note": "Sin síntesis de voz (tts) disponible: se guarda solo el guion. " + exc.detail}
    try:
        audio = concat_wavs(list(zip(blobs, starts)))
    except AudioFormatError as exc:
        return {"error": str(exc)}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".part")
    tmp.write_bytes(audio)
    tmp.replace(out_path)
    return {"audioPath": str(out_path)}
