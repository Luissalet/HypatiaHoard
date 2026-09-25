"""App-specific wrapper around the vendored `hoard_link` package: `data/backend.json`
+ environment -> LinkConfig, and the prompts of the study features. The vendored
package (`hypatia/hoard_link/`) is never edited."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional

from .hoard_link import LinkConfig

APP_ID = "hypatia"
BACKEND_FILE = "backend.json"

# Room for a reasoning model's hidden thinking on top of the visible reply.
SUGGEST_MAX_TOKENS = 4096
GRADE_MAX_TOKENS = 1536


def backend_json_path(data_dir: Path) -> Path:
    return Path(data_dir) / BACKEND_FILE


def read_backend_json(data_dir: Path) -> dict[str, Any]:
    """The raw `backend.json` contents, or `{}` if absent or unreadable."""
    path = backend_json_path(data_dir)
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError:
        return {}
    return raw if isinstance(raw, dict) else {}


def load_link_config(data_dir: Path, env: Optional[Mapping[str, str]] = None) -> LinkConfig:
    return LinkConfig.load(backend_json_path(data_dir), env=env if env is not None else os.environ, app=APP_ID)


SUGGEST_SYSTEM = (
    "Eres un profesor que redacta preguntas de examen a partir de material que el alumno realmente tiene "
    "(apuntes, un fragmento, una transcripción). Reglas: cada pregunta evalúa un único concepto; nunca inventes "
    "nada que no esté en el material; escribe en {language}. Tipos permitidos: {types}. "
    "TEST: 3-5 opciones con ids 'a','b','c'...; correctOptionIds con los ids correctos. "
    "DESARROLLO/PRACTICO: modelAnswer breve y keywords (3-6 términos clave). "
    "COMPLETAR: clozeText con huecos '{{{{blank1}}}}', '{{{{blank2}}}}'... y blanks [{{\"id\":\"blank1\",\"accepted\":[...]}}]. "
    "Añade explanation (1-2 frases) y difficulty 1-5. "
    "Responde SOLO con JSON estricto, sin texto ni bloques ```: un array de hasta {n} objetos con la forma "
    '{{"type","prompt","options","correctOptionIds","modelAnswer","keywords","clozeText","blanks","explanation","difficulty"}}. '
    "Si el material tiene menos contenido, devuelve menos preguntas; [] si no hay nada preguntable."
)

_LANGUAGE_NAME = {"es": "español", "en": "inglés", "auto": "el mismo idioma que el material"}


def build_suggest_messages(material: str, n: int, types: list[str], language: str = "es") -> list[dict[str, str]]:
    system = SUGGEST_SYSTEM.format(language=_LANGUAGE_NAME.get(language, language), types=", ".join(types), n=n)
    return [{"role": "system", "content": system}, {"role": "user", "content": material}]


GRADE_SYSTEM = (
    "Eres un profesor que corrige respuestas de examen con honestidad. Compara la respuesta del alumno con la "
    "respuesta modelo y las palabras clave. Una afirmación cierta pero sobre otra cosa no puntúa. "
    'Responde SOLO con JSON estricto: {"verdict":"correct|partial|wrong","score":0-10,'
    '"feedback":"2-3 frases en español dirigidas al alumno","missing":["conceptos que faltan"]}.'
)


def build_grade_messages(question: dict[str, Any], answer: str) -> list[dict[str, str]]:
    keywords = ", ".join(question.get("keywords") or []) or "(ninguna)"
    user = (
        f"Pregunta: {question.get('prompt', '')}\n\n"
        f"Respuesta modelo: {question.get('modelAnswer') or '(no hay)'}\n"
        + (f"Resultado numérico esperado: {question['numericAnswer']}\n" if question.get("numericAnswer") else "")
        + f"Palabras clave: {keywords}\n\nRespuesta del alumno: {answer}"
    )
    return [{"role": "system", "content": GRADE_SYSTEM}, {"role": "user", "content": user}]
