"""Oral cards: the question is read aloud, the user answers by voice, the answer is
transcribed, compared by meaning with the expected answer, and the grade enters the
spaced-repetition schedule like any other review.

Voice and transcription belong to the family: the question and the feedback are
spoken by Prospero's Hoard (`voice_tts`, else Hoard Link's `tts`), and the answer is
transcribed by Funes's Hoard (`transcribe_file`), else by Prospero's Hoard
(`voice_transcribe`), else by a local `faster_whisper` when it is installed. The
comparison is one call to the family's language model; without a model, option and
fill-in cards are still graded by rule and open cards come back for self-grading.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import unicodedata
import uuid
import wave
from pathlib import Path
from typing import Any, Iterable

from . import ai, backend, bank, study, voice
from .hoard_link import fam_media, family
from .sm2 import parse_grade

SUGGESTED = {"correct": "good", "partial": "hard", "wrong": "again"}
MAX_SPOKEN_CHARS = 1800
MAX_ANSWER_BYTES = 40 * 1024 * 1024
STT_TIMEOUT_S = 300.0
CACHE_KEEP_DAYS = 30
AUDIO_NAME = re.compile(r"^[0-9a-f]{24}\.wav$")
AUDIO_TYPES = {"audio/webm": ".webm", "video/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav",
               "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
               "audio/aac": ".aac", "audio/flac": ".flac"}
AUDIO_SUFFIXES = frozenset(AUDIO_TYPES.values()) | {".opus", ".mp4", ".mkv", ".mov", ".wma"}

ORAL_SYSTEM = (
    "Eres un profesor que evalúa una respuesta ORAL de repaso, transcrita automáticamente. Compara por significado con la "
    "respuesta esperada, nunca por coincidencia literal: da por buenas las paráfrasis y los sinónimos, e ignora muletillas, "
    "repeticiones, el orden y los errores evidentes de transcripción. Una afirmación cierta pero sobre otra cosa no puntúa. "
    "No des por dicha ninguna idea que el alumno no haya dicho ni añadas ideas que la respuesta esperada no contiene. "
    "En preguntas de opciones el alumno puede decir la letra, la posición o el contenido de la opción. "
    'Responde SOLO con JSON estricto: {"verdict":"correct|partial|wrong","score":0-10,'
    '"covered":["ideas de la respuesta esperada que el alumno sí ha dicho"],'
    '"missing":["ideas de la respuesta esperada que faltan o que ha dicho mal"],'
    '"feedback":"1-2 frases en español dirigidas al alumno, para leerlas en voz alta"}.'
)

# ---------- text for the voice ----------

_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_HTML_TAG = re.compile(r"<[^>]+>")
_BLANK = re.compile(r"\{\{[^}]*\}\}")
_LATEX_COMMAND = re.compile(r"\\([a-zA-Z]+)")
_LATEX_WORDS = {"frac": " fracción ", "sqrt": " raíz de ", "cdot": " por ", "times": " por ", "leq": " menor o igual que ",
                "geq": " mayor o igual que ", "neq": " distinto de ", "infty": " infinito ", "sum": " sumatorio ",
                "int": " integral ", "alpha": " alfa ", "beta": " beta ", "gamma": " gamma ", "lambda": " lambda ",
                "pi": " pi ", "theta": " theta ", "sigma": " sigma ", "mu": " mu ", "to": " tiende a ", "rightarrow": " implica "}
_LETTERS = "abcdefgh"


def speakable(text: Any) -> str:
    """Markdown, HTML and simple LaTeX turned into a sentence a voice can read."""
    out = _CODE_FENCE.sub(" (fragmento de código) ", str(text or ""))
    out = _MD_IMAGE.sub(" ", out)
    out = _MD_LINK.sub(r"\1", out)
    out = _HTML_TAG.sub(" ", out)
    out = _BLANK.sub(" hueco ", out)
    out = _LATEX_COMMAND.sub(lambda m: _LATEX_WORDS.get(m.group(1), " "), out)
    out = re.sub(r"\*+|`+|~~|(?<!\w)_+|_+(?!\w)", "", out)       # emphasis marks leave no gap before punctuation
    out = re.sub(r"[$#>|{}\\]+", " ", out)
    out = re.sub(r"\s+([,.;:?!…])", r"\1", out)
    return re.sub(r"\s+", " ", out).strip()


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def spoken_question(question: dict) -> str:
    """What the voice reads for a card: the prompt, then the options or the sentence with its gaps."""
    parts = [speakable(question.get("prompt"))]
    qtype = question.get("type")
    if qtype == "TEST":
        options = [f"{_LETTERS[i]}, {speakable(o.get('text'))}" for i, o in enumerate((question.get("options") or [])[:len(_LETTERS)])]
        if options:
            parts.append("Opciones: " + ". ".join(options) + ".")
    elif qtype == "COMPLETAR" and question.get("clozeText"):
        cloze = speakable(question["clozeText"])
        if cloze and cloze != parts[0]:
            parts.append(cloze)
    text = " ".join(p for p in parts if p)
    return _clip(text if text[-1:] in ".?!…" or not text else text + ".", MAX_SPOKEN_CHARS)


def expected_answer(question: dict) -> str:
    """The expected answer as plain text (for the model and for the spoken feedback)."""
    qtype = question.get("type")
    if qtype == "TEST":
        correct = set(question.get("correctOptionIds") or [])
        hits = [f"{_LETTERS[i]}) {speakable(o.get('text'))}" for i, o in enumerate((question.get("options") or [])[:len(_LETTERS)])
                if o.get("id") in correct]
        return "; ".join(hits)
    if qtype == "COMPLETAR":
        return "; ".join(" o ".join(str(a) for a in (b.get("accepted") or [])) for b in question.get("blanks") or [])
    answer = speakable(question.get("modelAnswer"))
    if question.get("numericAnswer"):
        answer = f"{answer} (resultado: {question['numericAnswer']})".strip()
    return answer


# ---------- what was said ----------

def _plain(text: Any) -> str:
    """Lower case, no accents, no punctuation, single spaces."""
    s = unicodedata.normalize("NFD", str(text or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9ñ ]+", " ", s)).strip()


_COMMANDS = {
    "repeat": {"repite", "repetir", "repite la pregunta", "repiteme la pregunta", "repetir la pregunta", "repitela",
               "otra vez la pregunta", "puedes repetir", "puedes repetir la pregunta", "no te he oido"},
    "skip": {"saltar", "salta", "saltala", "saltar pregunta", "salta la pregunta", "siguiente", "siguiente pregunta",
             "siguiente tarjeta", "pasa a la siguiente"},
    "stop": {"parar", "para", "terminar", "termina", "terminar repaso", "parar repaso", "fin del repaso", "stop", "basta",
             "ya esta por hoy", "se acabo"},
}
_NO_ANSWER = re.compile(r"^(?:pues |eh |mmm |uf |la verdad es que |la verdad |sinceramente )*"
                        r"(?:no (?:lo |la |me |te )?(?:se|acuerdo|recuerdo|sabria decir(?:te)?)|ni idea|no tengo ni idea|"
                        r"no tengo idea|paso|en blanco|me he quedado en blanco)(?: (?:ahora mismo|la verdad|de eso|sinceramente))?$")
_LETTER_NAMES = {"a": 0, "b": 1, "be": 1, "c": 2, "ce": 2, "d": 3, "de": 3, "e": 4, "f": 5, "efe": 5, "g": 6, "ge": 6, "h": 7,
                 "hache": 7}
_ORDINALS = {"primera": 0, "primero": 0, "uno": 0, "1": 0, "segunda": 1, "segundo": 1, "dos": 1, "2": 1, "tercera": 2,
             "tercero": 2, "tres": 2, "3": 2, "cuarta": 3, "cuarto": 3, "cuatro": 3, "4": 3, "quinta": 4, "quinto": 4,
             "cinco": 4, "5": 4, "sexta": 5, "sexto": 5, "seis": 5, "6": 5}


def spoken_command(transcript: str) -> str | None:
    """repeat | skip | stop when the whole (short) answer is one of the session commands."""
    plain = _plain(transcript)
    for action, phrases in _COMMANDS.items():
        if plain in phrases:
            return action
    return None


def is_no_answer(transcript: str) -> bool:
    return bool(_NO_ANSWER.match(_plain(transcript)))


def spoken_options(question: dict, transcript: str) -> list[str]:
    """Option ids named in a spoken answer: by letter ("la be"), position ("la segunda") or content."""
    options = (question.get("options") or [])[:len(_LETTERS)]
    plain = _plain(transcript)
    found: list[int] = []

    def add(index: int | None) -> None:
        if index is not None and 0 <= index < len(options) and index not in found:
            found.append(index)

    by_text = sorted(((len(_plain(o.get("text"))), i) for i, o in enumerate(options)), reverse=True)
    rest = f" {plain} "
    for size, i in by_text:
        text = _plain(options[i].get("text"))
        if size and f" {text} " in rest:
            add(i)
            rest = rest.replace(f" {text} ", " ")
    if found:
        return [options[i]["id"] for i in sorted(found)]
    words = plain.split()
    for pos, word in enumerate(words):
        previous = words[pos - 1] if pos else ""
        if previous in ("opcion", "letra", "respuesta") or (previous == "la" and (len(word) <= 2 or word in _ORDINALS)):
            add(_LETTER_NAMES.get(word))
            if word in _ORDINALS:
                add(_ORDINALS[word])
        elif word in _ORDINALS and previous in ("el", "numero"):
            add(_ORDINALS[word])
    if not found and len(words) == 1:
        add(_LETTER_NAMES.get(words[0]))
        if not found:
            add(_ORDINALS.get(words[0]))
    return [options[i]["id"] for i in sorted(found)]


# ---------- transcription (Funes, else Prospero, else local) ----------

def stage_dir() -> Path:
    """Where answers wait to be transcribed: under the user's home, a folder every family app may read."""
    base = Path(os.environ.get("HOARD_HOME") or Path.home() / ".hoard") / "tmp" / "oral"
    base.mkdir(parents=True, exist_ok=True)
    return base


def save_answer_audio(data: bytes, content_type: str = "", filename: str = "") -> Path:
    """Uploaded answer audio as a file in the staging folder."""
    if not data:
        raise ValueError("El audio está vacío.")
    if len(data) > MAX_ANSWER_BYTES:
        raise ValueError("El audio supera 40 MB.")
    suffix = AUDIO_TYPES.get((content_type or "").split(";", 1)[0].strip().lower(), "")
    if not suffix:
        suffix = Path(filename or "").suffix.lower()
    if suffix not in AUDIO_SUFFIXES:
        suffix = ".webm"
    target = stage_dir() / f"answer-{uuid.uuid4().hex}{suffix}"
    target.write_bytes(data)
    return target


def _under_home(path: Path) -> bool:
    try:
        path.resolve().relative_to(Path.home().resolve())
        return True
    except (OSError, ValueError):
        return False


def _duration(data: dict) -> float | None:
    for key in ("duration_s", "duration"):
        try:
            if data.get(key) is not None:
                return round(float(data[key]), 2)
        except (TypeError, ValueError):
            continue
    return None


def transcribe(path: Path, language: str = "es") -> dict:
    """`{ok, text, via, language, duration_s}` for an audio file, or `{ok: False, error}`."""
    path = Path(path)
    errors: list[str] = []
    res = fam_media.transcribe(str(path), language=language, word_timestamps=False, local_fallback=False,
                               timeout_s=STT_TIMEOUT_S)
    if res.get("ok"):
        return {"ok": True, "text": str(res.get("text") or "").strip(), "via": "funes",
                "language": res.get("language") or language, "duration_s": _duration(res)}
    errors.append(f"Funes: {res.get('error') or 'sin respuesta'}")
    if res.get("kind") != "hub_down":
        staged = path if _under_home(path) else stage_dir() / f"copy-{uuid.uuid4().hex}{path.suffix.lower()}"
        request = {"path": str(staged), "language": language, "word_timestamps": False}
        try:
            if staged != path:
                shutil.copyfile(path, staged)
            raw = family.call("prospero", "voice_transcribe", request, timeout=STT_TIMEOUT_S)
            if isinstance(raw, dict) and not raw.get("ok") and voice.wake_studio(raw.get("error")):
                raw = family.call("prospero", "voice_transcribe", request, timeout=STT_TIMEOUT_S)
        finally:
            if staged != path:
                staged.unlink(missing_ok=True)
        data = raw.get("result") if isinstance(raw, dict) else None
        if isinstance(raw, dict) and raw.get("ok") and isinstance(data, dict) and "text" in data:
            return {"ok": True, "text": str(data.get("text") or "").strip(), "via": "prospero",
                    "language": data.get("language") or language, "duration_s": _duration(data)}
        errors.append(f"Prospero: {(raw or {}).get('error') or 'sin respuesta'}"[:200])
    from .hoard_link.media import stt

    if stt.available():
        res = fam_media.transcribe(str(path), language=language, word_timestamps=False, local_fallback=True,
                                   timeout_s=STT_TIMEOUT_S)
        if res.get("ok"):
            return {"ok": True, "text": str(res.get("text") or "").strip(), "via": str(res.get("via") or "local"),
                    "language": res.get("language") or language, "duration_s": _duration(res)}
        errors.append(f"local: {res.get('error') or 'sin respuesta'}"[:200])
    return {"ok": False, "error": "; ".join(errors)}


def _running(service: str) -> bool:
    """Is the family app behind `service` running? A busy hub can miss the one-second probe (and the
    miss is cached for 30 s), so a negative answer is asked once more, patiently."""
    if fam_media.available(service):
        return True
    fam_media.forget_availability()
    return fam_media.available(service, timeout=8.0)


def stt_source() -> str | None:
    """Who would transcribe right now: funes | prospero | local | None."""
    if _running("stt"):
        return "funes"
    if _running("prospero"):
        return "prospero"
    from .hoard_link.media import stt

    return "local" if stt.available() else None


# ---------- voice (Prospero, else Hoard Link's tts) ----------

def cache_dir(services) -> Path:
    path = Path(services.config.data_dir) / "oral" / "tts"
    path.mkdir(parents=True, exist_ok=True)
    return path


_last_prune = 0.0


def _prune(folder: Path) -> None:
    global _last_prune
    now = time.time()
    if now - _last_prune < 3600:
        return
    _last_prune = now
    for item in folder.glob("*.wav"):
        try:
            if now - item.stat().st_mtime > CACHE_KEEP_DAYS * 86400:
                item.unlink()
        except OSError:
            continue


def _wav_seconds(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 2)
    except (wave.Error, OSError, EOFError):
        return None


def _synthesize(services, text: str, voice_ref: str | None, engine: str) -> bytes | None:
    try:
        return voice.speak(text, voice_ref, engine)
    except voice.VoiceError:
        pass
    try:
        data = services.with_link(lambda link: link.tts(text, None))
    except Exception:  # noqa: BLE001 - no voice is a state, not a failure
        return None
    return bytes(data) if data else None


def speak(services, text: str, voice_ref: str | None = None) -> dict | None:
    """`text` as a WAV in data/oral/tts (the same text and voice are synthesized once).
    None when no voice answers."""
    text = _clip(speakable(text), MAX_SPOKEN_CHARS)
    if not text:
        return None
    engine, (default_voice, _) = voice.podcast_settings(services.config.data_dir)
    ref = (voice_ref or "").strip() or default_voice
    name = hashlib.sha1(f"{engine}|{ref}|{text}".encode("utf-8")).hexdigest()[:24] + ".wav"
    folder = cache_dir(services)
    target = folder / name
    if not target.is_file() or target.stat().st_size < 64:
        data = _synthesize(services, text, ref, engine)
        if not data:
            return None
        partial = target.with_suffix(f".{uuid.uuid4().hex[:8]}.part")
        partial.write_bytes(data)
        os.replace(partial, target)
        _prune(folder)
    return {"name": name, "path": str(target), "url": f"/api/study/oral/audio/{name}", "bytes": target.stat().st_size,
            "duration_s": _wav_seconds(target), "voice": ref, "text": text}


def audio_file(services, name: str) -> Path | None:
    if not AUDIO_NAME.match(name or ""):
        return None
    target = cache_dir(services) / name
    return target if target.is_file() else None


# ---------- the queue ----------

def _card(services, question: dict, titles: dict[str, str], subjects: dict[str, str], with_audio: bool) -> dict:
    out = {"id": question["id"], "type": question.get("type"), "prompt": question.get("prompt"),
           "spoken": spoken_question(question), "subjectId": question.get("subjectId"),
           "subject": subjects.get(question.get("subjectId")), "topicId": question.get("topicId"),
           "topic": titles.get(question.get("topicId"))}
    if question.get("type") == "TEST" and question.get("options"):
        out["options"] = [{"id": o.get("id"), "letter": _LETTERS[i], "text": o.get("text")}
                          for i, o in enumerate(question["options"][:len(_LETTERS)])]
    if question.get("clozeText"):
        out["clozeText"] = question["clozeText"]
    out["audio"] = speak(services, out["spoken"]) if with_audio else None
    return out


def next_card(services, subject_id: str | None, topic_id: str | None, exclude: Iterable[str] = (),
              with_audio: bool = True) -> dict:
    """The next card to ask aloud: the due queue (overdue, never seen, last failed) without page
    cards and without the ids already asked in this session."""
    skip = {str(i) for i in exclude or ()}
    total = len(services.store.list("question", subject_id))
    queue = study.due_queue(services, subject_id, topic_id, max(1, total))
    ids = [q["id"] for q in queue["queue"] if q.get("kind") != "page" and q["id"] not in skip]
    card = None
    if ids:
        question = services.store.get("question", ids[0])
        subjects = {s["id"]: s.get("name") for s in services.store.list("subject")}
        card = _card(services, question, bank.topic_titles(services, subject_id), subjects, with_audio)
    return {"card": card, "remaining": len(ids), "asked": len(skip), "today": queue["today"],
            "note": None if card else "No quedan tarjetas para repasar de viva voz."}


# ---------- the comparison ----------

def _judge_messages(question: dict, transcript: str) -> list[dict[str, str]]:
    lines = [f"Pregunta: {speakable(question.get('prompt'))}"]
    if question.get("type") == "TEST":
        lines.append("Opciones: " + "; ".join(f"{_LETTERS[i]}) {speakable(o.get('text'))}"
                                               for i, o in enumerate((question.get("options") or [])[:len(_LETTERS)])))
    if question.get("clozeText"):
        lines.append(f"Frase con huecos: {speakable(question['clozeText'])}")
    lines.append(f"Respuesta esperada: {expected_answer(question) or '(no hay)'}")
    if question.get("keywords"):
        lines.append("Palabras clave: " + ", ".join(str(k) for k in question["keywords"]))
    lines.append(f"\nRespuesta del alumno (transcripción): {transcript}")
    return [{"role": "system", "content": ORAL_SYSTEM}, {"role": "user", "content": "\n".join(lines)}]


def _texts(value: Any, limit: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


def _by_rule(question: dict, transcript: str) -> dict:
    """Grading without a model: options and gaps by rule; open answers only show their matched keywords."""
    qtype = question.get("type")
    if qtype == "TEST":
        chosen = spoken_options(question, transcript)
        if not chosen:
            return {"verdict": None, "score": None, "covered": [], "missing": [],
                    "feedback": "No he reconocido qué opción has dicho."}
        right = set(chosen) == set(question.get("correctOptionIds") or [])
        return {"verdict": "correct" if right else "wrong", "score": 10.0 if right else 0.0,
                "covered": [expected_answer(question)] if right else [],
                "missing": [] if right else [expected_answer(question)],
                "feedback": "Correcto." if right else "No es la opción correcta."}
    if qtype == "COMPLETAR":
        plain = f" {_plain(transcript)} "
        covered, missing = [], []
        for blank in question.get("blanks") or []:
            accepted = [str(a) for a in blank.get("accepted") or []]
            hit = next((a for a in accepted if _plain(a) and f" {_plain(a)} " in plain), None)
            (covered if hit else missing).append(hit or (accepted[0] if accepted else "?"))
        verdict = "correct" if not missing else "partial" if covered else "wrong"
        return {"verdict": verdict, "score": round(10.0 * len(covered) / max(1, len(covered) + len(missing)), 1),
                "covered": covered, "missing": missing,
                "feedback": {"correct": "Correcto.", "partial": "Te ha faltado algún hueco.", "wrong": "No es correcto."}[verdict]}
    plain = _plain(transcript)
    keywords = [str(k) for k in question.get("keywords") or []]
    covered = [k for k in keywords if _plain(k) and _plain(k) in plain]
    return {"verdict": None, "score": None, "covered": covered, "missing": [k for k in keywords if k not in covered],
            "feedback": None}


def judge(services, question: dict, transcript: str) -> dict:
    """`{verdict, score, covered, missing, feedback, model, suggestedGrade}` for a spoken answer.
    `verdict` is None when nothing could decide (no model, open answer): the user grades it."""
    if is_no_answer(transcript):
        return {"verdict": "wrong", "score": 0.0, "covered": [], "missing": [], "feedback": "Sin respuesta.",
                "model": None, "suggestedGrade": "again", "by": "rule"}
    try:
        result = ai.chat(services, _judge_messages(question, transcript), max_tokens=backend.GRADE_MAX_TOKENS,
                         temperature=0.1, response_format={"type": "json_object"}, effort="low")
    except (ai.Unavailable, ai.BackendError) as error:
        ruled = _by_rule(question, transcript)
        return {**ruled, "model": None, "suggestedGrade": SUGGESTED.get(ruled["verdict"]), "by": "rule",
                "note": f"Sin modelo para comparar por significado ({error})."}
    data = ai.parse_json(result.text)
    verdict = str(data.get("verdict", "")).strip().lower() if isinstance(data, dict) else ""
    if verdict not in SUGGESTED:
        ruled = _by_rule(question, transcript)
        return {**ruled, "model": result.model, "suggestedGrade": SUGGESTED.get(ruled["verdict"]), "by": "rule",
                "note": "El modelo no devolvió una valoración legible."}
    try:
        score = max(0.0, min(10.0, float(data.get("score"))))
    except (TypeError, ValueError):
        score = {"correct": 10.0, "partial": 5.0, "wrong": 0.0}[verdict]
    return {"verdict": verdict, "score": score, "covered": _texts(data.get("covered")), "missing": _texts(data.get("missing")),
            "feedback": str(data.get("feedback") or "").strip(), "model": result.model,
            "suggestedGrade": SUGGESTED[verdict], "by": "model"}


def feedback_speech(question: dict, verdict: dict) -> str:
    """What is said back: the verdict, the model's sentence, what was missing and, when wrong, the answer."""
    head = {"correct": "Correcto.", "partial": "Casi.", "wrong": "No es correcto."}.get(verdict.get("verdict"))
    parts = [head] if head else []
    feedback = speakable(verdict.get("feedback"))
    if feedback and _plain(feedback) != _plain(head or ""):
        parts.append(feedback if feedback[-1:] in ".?!…" else feedback + ".")
    missing = [speakable(m) for m in verdict.get("missing") or []]
    expected = expected_answer(question)
    if verdict.get("verdict") == "partial" and missing:
        parts.append("Te ha faltado: " + "; ".join(missing[:4]) + ".")
    if verdict.get("verdict") in ("wrong", None) and expected:
        parts.append(("La respuesta es: " if head else "Compara con la respuesta: ") + _clip(expected, 500)
                     + ("" if expected[-1:] in ".?!…" else "."))
    return _clip(" ".join(parts), MAX_SPOKEN_CHARS)


# ---------- one answer ----------

def answer(services, question: dict, *, transcript: str | None = None, audio_path: str | None = None, record: bool = True,
           grade: Any = None, speak_feedback: bool = True, language: str = "es", exclude: Iterable[str] = (),
           subject_id: str | None = None, topic_id: str | None = None, with_next: bool = True) -> dict:
    """Transcribe (when audio is given), compare by meaning, record the review and say what was right and
    what was missing. Nothing is recorded for silence, for a session command or when no verdict was possible."""
    if question.get("pageHtml"):
        raise ValueError("Las tarjetas de página se repasan enteras; no tienen respuesta que decir de viva voz.")
    base: dict[str, Any] = {"questionId": question["id"], "type": question.get("type"), "prompt": question.get("prompt"),
                            "recorded": False}
    stt: dict[str, Any] | None = None
    if transcript is None:
        if not (audio_path or "").strip():
            raise ValueError("Hace falta el audio de la respuesta (audio_path) o su transcripción (transcript).")
        source = Path(audio_path)
        if not source.is_file():
            raise LookupError(f"No existe el audio {audio_path}.")
        stt = transcribe(source, language)
        if not stt["ok"]:
            return {**base, "heard": False, "transcript": "", "error": "stt_unavailable",
                    "note": f"No se pudo transcribir la respuesta: {stt['error']}"}
        transcript = stt["text"]
    said = str(transcript or "").strip()
    base["transcript"] = said
    if stt is not None:
        base["transcription"] = {"via": stt["via"], "language": stt.get("language"), "duration_s": stt.get("duration_s")}
    skip = [str(i) for i in exclude or ()]
    if not said:
        return {**base, "heard": False, "note": "No se ha oído ninguna respuesta; no se ha registrado nada."}
    command = spoken_command(said)
    if command:
        out = {**base, "heard": True, "action": command}
        if command == "skip" and with_next:
            out["next"] = next_card(services, subject_id, topic_id, skip + [question["id"]], speak_feedback)
        return out
    verdict = judge(services, question, said)
    final = parse_grade(grade) if grade not in (None, "") else verdict["suggestedGrade"]
    spoken = feedback_speech(question, verdict)
    out = {**base, "heard": True, **verdict, "grade": final, "expected": expected_answer(question),
           "explanation": question.get("explanation"), "needsSelfGrade": final is None, "feedbackSpoken": spoken,
           "feedbackAudio": speak(services, spoken) if speak_feedback and spoken else None}
    if record and final is not None:
        review = study.review(services, question, final, via="oral")
        out["recorded"] = True
        out["review"] = {"result": review["result"], "nextReviewAt": review["nextReviewAt"],
                         "intervalDays": review["intervalDays"], "scheduler": review["scheduler"]}
    if with_next:
        out["next"] = next_card(services, subject_id, topic_id, skip + [question["id"]], speak_feedback)
    return out


def status(services) -> dict:
    caps = ai.capabilities(services)
    engine, (default_voice, _) = voice.podcast_settings(services.config.data_dir)
    return {"tts": bool(caps.get("tts")) or _running("tts"), "stt": stt_source(), "llm": bool(caps.get("llm")),
            "voice": default_voice, "engine": engine}
