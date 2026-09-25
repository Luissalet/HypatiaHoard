"""/api/notebook/* (and /api/sources/upload) — the notebook over HTTP for the PWA.

The router has no prefix: every route carries its full path, because uploads live
at /api/sources/upload (see SPEC) while everything else is under /api/notebook.
"""

from __future__ import annotations

from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..notebook import ask as ask_mod
from ..notebook import chats, retrieval, sources, studio, tutor, worker
from ..notebook.schema import row

router = APIRouter()

StudioKind = Literal["study_guide", "briefing", "faq", "glossary", "timeline", "mindmap", "podcast"]


def _svc(request: Request) -> Any:
    return request.app.state.services


def _run(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except (ValueError, sources.SourceError) as error:
        raise HTTPException(400, str(error)) from error


# ---------------------------------------------------------------- sources

@router.put("/api/sources/upload")
@router.put("/api/notebook/sources/upload")
async def upload_source(request: Request, subject: str = Query(..., min_length=1),
                        filename: str = Query(..., min_length=1)):
    svc = _svc(request)
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > sources.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "El archivo supera 50 MB")
    buf = bytearray()
    async for part in request.stream():
        buf.extend(part)
        if len(buf) > sources.MAX_UPLOAD_BYTES:
            raise HTTPException(413, "El archivo supera 50 MB")

    def work() -> dict[str, Any]:
        subj = svc.resolve_subject(subject)
        src, change = sources.save_upload(svc, subj["id"], filename, bytes(buf))
        if src["status"] == "pending":
            worker.submit_index(svc, [src["id"]])
        return {"source": sources.public_source(src), "change": change}

    return await run_in_threadpool(_run, work)


@router.get("/api/notebook/sources")
def list_sources(request: Request, subject: str = Query(..., min_length=1)):
    svc = _svc(request)
    subj = _run(svc.resolve_subject, subject)
    return {"sources": sources.list_sources(svc, subj["id"])}


class RescanBody(BaseModel):
    subject: Optional[str] = Field(None, max_length=200)


@router.post("/api/notebook/sources/rescan")
def rescan(request: Request, body: RescanBody | None = None):
    svc = _svc(request)
    body = body or RescanBody()

    def work() -> dict[str, Any]:
        subjects = [svc.resolve_subject(body.subject)] if body.subject else list(svc.store.list("subject"))
        result = {}
        for subj in subjects:
            counts = sources.scan_subject(svc, subj)
            pending = counts.pop("pending", [])
            worker.submit_index(svc, pending)
            counts["queued"] = len(pending)
            result[subj["id"]] = counts
        return {"subjects": result}

    return _run(work)


@router.delete("/api/notebook/sources/{source_id}")
def delete_source(request: Request, source_id: str):
    if not sources.delete_source(_svc(request), source_id):
        raise HTTPException(404, "Fuente no encontrada")
    return {"deleted": True}


@router.post("/api/notebook/sources/{source_id}/reindex")
def reindex_source(request: Request, source_id: str):
    svc = _svc(request)
    found = row(svc, "SELECT id FROM sources WHERE id=?", (source_id,))
    if not found:
        raise HTTPException(404, "Fuente no encontrada")
    with svc.db.tx() as conn:
        conn.execute("UPDATE sources SET status='pending', sha256=NULL WHERE id=?", (source_id,))
    worker.submit_index(svc, [source_id])
    return {"queued": True}


# ---------------------------------------------------------------- search / ask

class SearchBody(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    query: str = Field(..., min_length=1, max_length=2000)
    topic: Optional[str] = Field(None, max_length=200)
    sourceIds: Optional[list[str]] = Field(None, max_length=50)
    k: int = Field(8, ge=1, le=20)


@router.post("/api/notebook/search")
def search(request: Request, body: SearchBody):
    svc = _svc(request)

    def work() -> dict[str, Any]:
        subj = svc.resolve_subject(body.subject)
        found = retrieval.search(svc, subj["id"], body.query, topic=body.topic, source_ids=body.sourceIds, k=body.k)
        return {"passages": [retrieval.public_passage(p) for p in found["passages"]], "note": found["note"]}

    return _run(work)


class AskBody(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    question: str = Field(..., min_length=1, max_length=4000)
    topic: Optional[str] = Field(None, max_length=200)
    sourceIds: Optional[list[str]] = Field(None, max_length=50)
    chatId: Optional[str] = Field(None, max_length=100)


@router.post("/api/notebook/ask")
def ask(request: Request, body: AskBody):
    return _run(ask_mod.ask, _svc(request), body.subject, body.question, topic=body.topic,
                source_ids=body.sourceIds, chat_id=body.chatId)


# ---------------------------------------------------------------- studio

class StudioBody(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    kind: StudioKind
    topic: Optional[str] = Field(None, max_length=200)
    sourceIds: Optional[list[str]] = Field(None, max_length=50)
    instructions: Optional[str] = Field(None, max_length=2000)
    addAsSource: bool = False


@router.post("/api/notebook/studio")
def studio_create(request: Request, body: StudioBody):
    return _run(studio.create, _svc(request), body.subject, body.kind, topic=body.topic, source_ids=body.sourceIds,
                instructions=body.instructions, add_as_source=body.addAsSource)


@router.get("/api/notebook/studio")
def studio_list(request: Request, subject: str = Query(..., min_length=1), kind: Optional[str] = None):
    svc = _svc(request)
    subj = _run(svc.resolve_subject, subject)
    return {"items": studio.list_items(svc, subj["id"], kind)}


@router.get("/api/notebook/studio/{item_id}")
def studio_get(request: Request, item_id: str):
    item = studio.get_item(_svc(request), item_id)
    if not item:
        raise HTTPException(404, "Elemento no encontrado")
    return {"item": item}


@router.delete("/api/notebook/studio/{item_id}")
def studio_delete(request: Request, item_id: str):
    if not studio.delete_item(_svc(request), item_id):
        raise HTTPException(404, "Elemento no encontrado")
    return {"deleted": True}


@router.get("/api/notebook/studio/{item_id}/audio")
def studio_audio(request: Request, item_id: str):
    path = studio.audio_path(_svc(request), item_id)
    if not path:
        raise HTTPException(404, "Este elemento no tiene audio")
    return FileResponse(path, media_type="audio/wav", filename=f"{item_id}.wav")


@router.post("/api/notebook/studio/{item_id}/to-concepts")
def studio_to_concepts(request: Request, item_id: str):
    return _run(studio.to_concepts, _svc(request), item_id)


@router.post("/api/notebook/studio/{item_id}/to-questions")
def studio_to_questions(request: Request, item_id: str):
    return _run(studio.to_questions, _svc(request), item_id)


@router.post("/api/notebook/studio/{item_id}/to-source")
def studio_to_source(request: Request, item_id: str):
    return {"source": _run(studio.add_as_source, _svc(request), item_id)}


# ---------------------------------------------------------------- tutor / chats

class TutorBody(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=4000)
    topic: Optional[str] = Field(None, max_length=200)
    chatId: Optional[str] = Field(None, max_length=100)


@router.post("/api/notebook/tutor")
def tutor_turn(request: Request, body: TutorBody):
    return _run(tutor.turn, _svc(request), body.subject, body.message, topic=body.topic, chat_id=body.chatId)


@router.get("/api/notebook/chats")
def chats_list(request: Request, subject: str = Query(..., min_length=1), mode: Optional[str] = None):
    svc = _svc(request)
    subj = _run(svc.resolve_subject, subject)
    return {"chats": chats.list_chats(svc, subj["id"], mode)}


@router.get("/api/notebook/chats/{chat_id}")
def chat_get(request: Request, chat_id: str):
    chat = chats.get_chat(_svc(request), chat_id)
    if not chat:
        raise HTTPException(404, "Chat no encontrado")
    return {"chat": chat}


@router.delete("/api/notebook/chats/{chat_id}")
def chat_delete(request: Request, chat_id: str):
    if not chats.delete_chat(_svc(request), chat_id):
        raise HTTPException(404, "Chat no encontrado")
    return {"deleted": True}
