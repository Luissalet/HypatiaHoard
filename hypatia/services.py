"""Wiring of database, record store, Hoard Link factory and clock (the shared contract)."""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from .backend import load_link_config
from .config import Config
from .db import Database
from .hashing import normalize_text, slugify
from .store import RecordStore

log = logging.getLogger("hypatia")


def js_iso(moment: datetime) -> str:
    """`Date.prototype.toISOString()`: 'YYYY-MM-DDTHH:MM:SS.mmmZ' in UTC."""
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def read_or_create_token(config: Config) -> str:
    """The MCP bearer token (data/mcp-token): kept across restarts, created 0600 if missing."""
    config.data_dir.mkdir(parents=True, exist_ok=True)
    path = config.token_path
    if path.is_file():
        token = path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    token = secrets.token_hex(32)
    path.write_text(token, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token


_TOPIC_NUMBER = re.compile(r"^(?:tema|topic|t)?\s*#?\s*(\d+)$", re.IGNORECASE)


class Services:
    """Everything the API and the agent tools call through. `clock` is injectable
    (a function returning a tz-aware UTC datetime) so tests never depend on wall time."""

    def __init__(self, config: Config, clock: Callable[[], datetime] | None = None):
        self.config = config
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        config.data_dir.mkdir(parents=True, exist_ok=True)
        self.token = read_or_create_token(config)
        self.db = Database(config.db_path)
        self.store = RecordStore(self.db, self.now_iso)
        self.started_at = self.now_iso()
        self._stopped = False

    # ---------- clock ----------
    def now(self) -> datetime:
        moment = self.clock()
        return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)

    def now_iso(self) -> str:
        return js_iso(self.now())

    def today(self) -> str:
        return self.now().astimezone(timezone.utc).strftime("%Y-%m-%d")

    # ---------- models ----------
    def link(self):
        """A fresh Hoard Link for this data folder (tests monkeypatch this)."""
        from .hoard_link import Link

        return Link(load_link_config(self.config.data_dir))

    def run_async(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """Run a coroutine to completion from sync code, from any thread
        (including one that already runs an event loop)."""
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        box: dict[str, Any] = {}

        def runner() -> None:
            try:
                box["value"] = asyncio.run(coro)
            except BaseException as error:  # noqa: BLE001 - re-raised in the caller
                box["error"] = error

        thread = threading.Thread(target=runner, name="hypatia-run-async", daemon=True)
        thread.start()
        thread.join()
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def with_link(self, fn: Callable[[Any], Coroutine[Any, Any, Any]]) -> Any:
        """`fn(link)` on a fresh Link that is closed afterwards."""
        async def go():
            link = self.link()
            try:
                return await fn(link)
            finally:
                close = getattr(link, "aclose", None)
                if close is not None:
                    try:
                        await close()
                    except Exception:  # noqa: BLE001
                        pass
        return self.run_async(go())

    # ---------- resolution of names the assistant passes ----------
    def resolve_subject(self, ref: str) -> dict:
        ref = (ref or "").strip()
        subjects = self.store.list("subject")
        if not subjects:
            raise LookupError("There are no subjects yet (the PWA has not synced or nothing was created).")
        for match in (
            lambda s: s.get("id") == ref,
            lambda s: s.get("name") == ref,
            lambda s: normalize_text(s.get("name") or "") == normalize_text(ref),
            lambda s: slugify(s.get("name") or "") == slugify(ref),
        ):
            found = [s for s in subjects if match(s)]
            if len(found) == 1:
                return found[0]
        slug = slugify(ref)
        if slug:
            found = [s for s in subjects if slugify(s.get("name") or "").startswith(slug)]
            if len(found) == 1:
                return found[0]
            if not found:
                found = [s for s in subjects if slug in slugify(s.get("name") or "")]
                if len(found) == 1:
                    return found[0]
        names = ", ".join(sorted(s.get("name") or s["id"] for s in subjects))
        raise LookupError(f"No single subject matches «{ref}». Subjects: {names}.")

    def topics_of(self, subject_id: str) -> list[dict]:
        return sorted(self.store.list("topic", subject_id), key=lambda t: (t.get("order") or 0, t.get("title") or ""))

    def resolve_topic(self, subject_id: str, ref: str) -> dict:
        ref = (ref or "").strip()
        topics = self.topics_of(subject_id)
        for t in topics:
            if t.get("id") == ref:
                return t
        slug = slugify(ref)
        found = [t for t in topics if slugify(t.get("title") or "") == slug] if slug else []
        if len(found) == 1:
            return found[0]
        number = _TOPIC_NUMBER.match(ref)
        if number and topics:
            n = int(number.group(1))
            if 1 <= n <= len(topics):
                return topics[n - 1]
        if slug:
            found = [t for t in topics if slugify(t.get("title") or "").startswith(slug)]
            if len(found) == 1:
                return found[0]
        titles = "; ".join(f"{i}. {t.get('title')}" for i, t in enumerate(topics, 1)) or "(none)"
        raise LookupError(f"No single topic matches «{ref}». Topics: {titles}.")

    # ---------- lifecycle ----------
    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self.db.close()
