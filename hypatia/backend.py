"""App-specific wrapper around the vendored `hoard_link` package.

Hypatia's Hoard uses exactly one model capability -- `llm`, for drafting
flashcards with `cards_suggest` -- so this module stays small: it turns
`data/backend.json` plus the environment into a `LinkConfig` for this app,
and builds the drafting prompt. `services.py`/`suggest.py` stay about the
app's own logic; this is where the Hoard Link specifics live so the
vendored package (`hypatia/hoard_link/`) never has to be edited.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional

from .hoard_link import LinkConfig

APP_ID = "hypatia"
BACKEND_FILE = "backend.json"

# One fact per card is a short answer, but a reasoning model counts its
# hidden thinking against the same budget (Hoard Link strips it from the
# text before this app ever sees it), so the cap must leave room for both.
SUGGEST_MAX_TOKENS = 2048

SUGGEST_SYSTEM = (
    "You write spaced-repetition flashcards from material the user actually has "
    "(a passage, a meeting transcript). Rules: one fact per card; the front is a "
    "short, unambiguous question; the back is a short answer, no more than one or "
    "two sentences; never invent a fact that is not in the material; write in {language}; "
    'reply with STRICT JSON only, no prose, no markdown fences: a JSON array of up to '
    '{max_cards} objects, each {{"front": "...", "back": "...", "source": "..."}}, where '
    '"source" is a short pointer back into the material you were given (e.g. a quoted '
    "phrase, a timestamp, a section) so the user can trace the fact. If the material has "
    "fewer facts than {max_cards}, return fewer cards rather than padding. Return [] if "
    "the material has no fact worth a card."
)

_LANGUAGE_NAME = {"es": "Spanish", "en": "English", "auto": "the same language as the material"}


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


def build_suggest_messages(material: str, language: str, max_cards: int) -> list[dict[str, str]]:
    """Chat messages asking the model to draft flashcards from `material`.

    `material` is whatever text the assistant handed `cards_suggest`
    (a pasted passage, or a rendered Scribe transcript) -- capped by the
    caller before it gets here so the prompt stays within the model's
    context.
    """
    system = SUGGEST_SYSTEM.format(language=_LANGUAGE_NAME.get(language, language), max_cards=max_cards)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": material},
    ]
