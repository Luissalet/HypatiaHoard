"""Read-only client for Scribe's Hoard's agent HTTP API (family contract).

Used only by `cards_suggest` (`source.kind == "scribe"`) to fetch a
transcript to draft cards from. Never opens Scribe's database and never
writes anything to Scribe: it calls `GET /api/agent/tools` (reachability)
and `POST /api/agent/call` with the read-only `scribe_sessions` /
`scribe_transcript` tools, authenticated with Scribe's own token.

Scribe's base URL and token are resolved the same way every Hoard sibling
does: an explicit override first, then the sibling folder's own
`data/url` / `data/mcp-token`, then the family's known default port.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import REPO_ROOT

DEFAULT_PORT = 5185
DEFAULT_URL = f"http://127.0.0.1:{DEFAULT_PORT}"
# Folder names Scribe's Hoard is cloned under, tried in order next to this
# repo (see BRIEF/README: sibling folders on the user's machine are named
# "Scribe's Hoard"; the cloud checkout used for development is "ScribeHoard").
_SIBLING_DIR_NAMES = ("Scribe's Hoard", "ScribeHoard")


class ScribeUnavailable(RuntimeError):
    """Scribe's Hoard could not be reached, or no usable token was found."""


def _candidate_dirs() -> list[Path]:
    dirs: list[Path] = []
    env = os.environ.get("SCRIBE_DIR")
    if env:
        dirs.append(Path(env).expanduser())
    dirs.extend(REPO_ROOT.parent / name for name in _SIBLING_DIR_NAMES)
    return dirs


def _scribe_data_dir() -> Optional[Path]:
    env = os.environ.get("SCRIBE_DATA_DIR")
    if env:
        return Path(env).expanduser()
    for candidate in _candidate_dirs():
        if (candidate / "data").is_dir():
            return candidate / "data"
    return None


def resolve_url() -> str:
    env = os.environ.get("SCRIBE_URL")
    if env:
        return env.strip().rstrip("/")
    data_dir = _scribe_data_dir()
    if data_dir is not None:
        url_file = data_dir / "url"
        if url_file.is_file():
            text = url_file.read_text(encoding="utf-8").strip()
            if text:
                return text.rstrip("/")
    return DEFAULT_URL


def resolve_token() -> Optional[str]:
    env = os.environ.get("SCRIBE_TOKEN")
    if env:
        return env.strip()
    data_dir = _scribe_data_dir()
    if data_dir is not None:
        token_file = data_dir / "mcp-token"
        if token_file.is_file():
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                return token
    return None


class ScribeClient:
    """Thin, read-only wrapper over Scribe's Hoard `/api/agent/call`."""

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
                "No token found for Scribe's Hoard: open it once so it writes data/mcp-token, "
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
            raise ScribeUnavailable(f"Scribe's Hoard is not reachable at {self.base_url} ({error}).") from error
        if response.status_code == 401:
            raise ScribeUnavailable("Scribe's Hoard rejected the token; it may have restarted since it was read.")
        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = {}
            raise ScribeUnavailable(body.get("error") or f"Scribe's Hoard returned HTTP {response.status_code}.")
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
        """Every page of a session's transcript, concatenated into plain
        `[mm:ss] speaker: text` lines, up to `max_total_chars` (Scribe's own
        pagination is honored; this stops asking for more pages once the
        budget is spent, same as a human paging through a long meeting)."""
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
