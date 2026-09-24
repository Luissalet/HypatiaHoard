"""Test doubles for cards_suggest (see CLAUDE... no: see hypatia/suggest.py):
a fake Scribe's Hoard ASGI app (the family HTTP contract, not the real app)
and small helpers to build a `ChatResult`. Not a test module itself --
pytest only collects files matching test_*.py.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from hypatia.hoard_link import ChatResult, Usage
from hypatia.scribe_client import ScribeClient

FAKE_SCRIBE_TOKEN = "scribe-fake-token"


def chat_text(text: str, model: str = "fake-qwen") -> ChatResult:
    return ChatResult(text=text, model=model, provider="fake", usage=Usage(), elapsed_ms=5.0)


def make_fake_scribe_app(sessions: list[dict[str, Any]], transcripts: dict[str, list[dict[str, Any]]],
                          token: str = FAKE_SCRIBE_TOKEN) -> FastAPI:
    """A tiny stand-in for Scribe's Hoard `/api/agent/*` (never the real app).

    `sessions`: session briefs as `scribe_sessions` would return them (id,
    title, started_at, ...). `transcripts`: session id -> list of segment
    dicts (t, start_s, end_s, speaker, text); paginated 2 segments per page
    so pagination (`next_from_s`) is actually exercised.
    """
    app = FastAPI()

    @app.get("/api/agent/tools")
    def tools():
        return {"instructions": "fake scribe", "tools": []}

    @app.post("/api/agent/call")
    def call(request: Request, body: dict[str, Any]):
        header = request.headers.get("authorization", "")
        given = header[7:].strip() if header.startswith("Bearer ") else ""
        if given != token:
            raise HTTPException(401, "Invalid token.")
        name = body.get("name")
        args = body.get("arguments") or {}
        if name == "scribe_sessions":
            rows = sessions
            q = (args.get("q") or "").lower()
            if q:
                rows = [s for s in rows if q in s["title"].lower()]
            return {"total": len(rows), "sessions": rows[: args.get("limit", 20)]}
        if name == "scribe_transcript":
            sid = args["session_id"]
            if sid not in transcripts:
                raise HTTPException(404, f"Unknown session: {sid}")
            segs = transcripts[sid]
            from_s = args.get("from_s") or 0
            page = [s for s in segs if s["start_s"] >= from_s][:2]
            next_from = None
            if page:
                idx = segs.index(page[-1]) + 1
                if idx < len(segs):
                    next_from = segs[idx]["start_s"]
            session = next((s for s in sessions if s["id"] == sid), {"id": sid, "title": sid, "started_at": ""})
            return {"session": session, "status": "done", "notes": "", "segments": page, "next_from_s": next_from,
                    "note": ""}
        raise HTTPException(404, f"Unknown tool: {name}")

    return app


def make_fake_scribe_client(sessions: list[dict[str, Any]], transcripts: dict[str, list[dict[str, Any]]],
                             token: str = FAKE_SCRIBE_TOKEN, unauthorized: bool = False) -> ScribeClient:
    app = make_fake_scribe_app(sessions, transcripts, token)
    test_client = TestClient(app)  # keeps the app alive for the transport's lifetime
    return ScribeClient(base_url="http://scribe.test", token=(token + "x" if unauthorized else token),
                         transport=test_client._transport)
