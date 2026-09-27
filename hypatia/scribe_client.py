"""Read-only client for Scribe transcripts hosted by Funes's embedded audio app.

Used by ``cards_suggest`` (``source.kind == "scribe"``). It calls the
existing ``scribe_sessions`` and ``scribe_transcript`` agent tools under
Funes's ``/audio`` mount, keeping the source IDs and transcript shape used by
Hypatia. ``SCRIBE_URL`` and ``SCRIBE_TOKEN`` can still explicitly override the
endpoint and token. By default the endpoint is Funes's local ``/audio`` app and
the token is read from Funes data's ``audio/mcp-token``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import REPO_ROOT

DEFAULT_PORT = 8813
DEFAULT_URL = f"http://127.0.0.1:{DEFAULT_PORT}/audio"
_FUNES_DIR_NAMES = ("Funes's Hoard", "FunesHoard")


class ScribeUnavailable(RuntimeError):
    """Funes audio could not be reached, or no usable audio token was found."""


def _funes_root() -> Path:
    env = os.environ.get("FUNES_DIR")
    if env:
        return Path(env).expanduser()
    candidates = [REPO_ROOT.parent / name for name in _FUNES_DIR_NAMES]
    return next((path for path in candidates if path.is_dir()), candidates[0])


def _funes_data_dir() -> Path:
    env = os.environ.get("FUNES_DATA_DIR")
    if env:
        return Path(env).expanduser()
    return _funes_root() / "data"


def _audio_url(url: str) -> str:
    url = url.strip().rstrip("/")
    return url if url.casefold().endswith("/audio") else f"{url}/audio"


def resolve_url() -> str:
    # Historical SCRIBE_URL overrides remain full API base URLs (normally
    # ending in /audio after this migration); FUNES_URL accepts the app root.
    env = os.environ.get("SCRIBE_URL")
    if env and env.strip():
        return env.strip().rstrip("/")
    env = os.environ.get("FUNES_URL")
    if env and env.strip():
        return _audio_url(env)
    url_file = _funes_data_dir() / "url"
    try:
        text = url_file.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    return _audio_url(text) if text else DEFAULT_URL


def _token_path() -> Path:
    for name in ("SCRIBE_TOKEN_FILE", "FUNES_AUDIO_TOKEN_FILE"):
        env = os.environ.get(name)
        if env and env.strip():
            return Path(env).expanduser()
    # Keep the old direct data-directory override available for deployments
    # that have already moved the audio token independently.
    env = os.environ.get("SCRIBE_DATA_DIR")
    if env and env.strip():
        return Path(env).expanduser() / "mcp-token"
    return _funes_data_dir() / "audio" / "mcp-token"


def resolve_token() -> Optional[str]:
    env = os.environ.get("SCRIBE_TOKEN")
    if env and env.strip():
        return env.strip()
    try:
        token = _token_path().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


class ScribeClient:
    """Thin read-only wrapper over the embedded audio agent API."""

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, timeout: float = 20.0,
                 transport: Optional[httpx.BaseTransport] = None):
        self.base_url = (base_url or resolve_url()).rstrip("/")
        self.token = token if token is not None else resolve_token()
        self.timeout = timeout
        self._transport = transport

    def _client(self) -> httpx.Client:
        return httpx.Client(timeout=self.timeout, transport=self._transport)

    def _call(self, name: str, arguments: dict[str, Any]) -> dict:
        if not self.token:
            raise ScribeUnavailable(
                "No token found for Funes audio: start Funes so it writes data/audio/mcp-token, "
                "or set SCRIBE_TOKEN."
            )
        try:
            with self._client() as client:
                response = client.post(
                    f"{self.base_url}/api/agent/call",
                    json={"name": name, "arguments": arguments},
                    headers={"Authorization": f"Bearer {self.token}"},
                )
        except httpx.HTTPError as error:
            raise ScribeUnavailable(f"Funes audio is not reachable at {self.base_url} ({error}).") from error
        if response.status_code == 401:
            raise ScribeUnavailable("Funes audio rejected the token; it may have restarted since it was read.")
        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = {}
            raise ScribeUnavailable(body.get("error") or f"Funes audio returned HTTP {response.status_code}.")
        return response.json()

    def reachable(self) -> bool:
        try:
            with self._client() as client:
                response = client.get(f"{self.base_url}/api/agent/tools")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def sessions(self, q: Optional[str] = None, kind: Optional[str] = None, from_: Optional[str] = None,
                 to: Optional[str] = None, limit: int = 20) -> dict:
        args = {"q": q, "kind": kind, "from": from_, "to": to, "limit": limit}
        return self._call("scribe_sessions", {k: v for k, v in args.items() if v is not None})

    def transcript_page(self, session_id: str, from_s: Optional[float] = None, max_chars: int = 60000) -> dict:
        args: dict[str, Any] = {"session_id": session_id, "max_chars": max_chars}
        if from_s is not None:
            args["from_s"] = from_s
        return self._call("scribe_transcript", args)

    def full_transcript(self, session_id: str, max_total_chars: int = 60000) -> tuple[str, dict]:
        """Pages into the session transcript, preserving the existing plain-text result shape."""
        lines: list[str] = []
        session_meta: dict = {}
        from_s: Optional[float] = None
        used = 0
        while True:
            page = self.transcript_page(session_id, from_s=from_s)
            session_meta = page.get("session", session_meta)
            for seg in page.get("segments", []):
                line = f"[{seg['t']}] {seg['speaker']}: {seg['text']}"
                if used + len(line) > max_total_chars and lines:
                    return "\n".join(lines), session_meta
                lines.append(line)
                used += len(line) + 1
            next_from = page.get("next_from_s")
            if next_from is None or used >= max_total_chars:
                break
            from_s = next_from
        return "\n".join(lines), session_meta
