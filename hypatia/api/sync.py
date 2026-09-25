"""/api/sync/* — the PWA's sync with the server (see hypatia/sync.py)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from .. import sync
from .deps import services

router = APIRouter(prefix="/api/sync")


class DeleteIn(BaseModel):
    kind: str = Field(..., max_length=40)
    id: str = Field(..., min_length=1, max_length=200)
    deletedAt: str | None = Field(None, max_length=40)


class PushBody(BaseModel):
    backup: dict[str, Any]
    deletes: list[DeleteIn] = Field(default_factory=list)
    deviceId: str | None = Field(None, max_length=200)


@router.get("/state")
def state(request: Request):
    return sync.state(services(request).store)


@router.get("/pull")
def pull(request: Request, since: int = Query(0, ge=0)):
    svc = services(request)
    return sync.pull(svc.store, since, svc.now_iso())


@router.post("/push")
def push(request: Request, body: PushBody):
    svc = services(request)
    try:
        return sync.push(svc.store, body.backup, [d.model_dump() for d in body.deletes], body.deviceId, svc.now_iso())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/images/{filename}")
def image(request: Request, filename: str):
    found = services(request).store.image(filename)
    if found is None:
        raise HTTPException(404, "No such image.")
    mime, data = found
    return Response(content=data, media_type=mime, headers={"Cache-Control": "no-cache"})
