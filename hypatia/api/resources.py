"""PUT /api/resources/upload — a file attached in the app, saved under resources/<subject slug>/."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from .. import resources
from .deps import services

router = APIRouter(prefix="/api/resources")


@router.put("/upload")
async def upload(request: Request, subject: str = Query(..., min_length=1, max_length=200),
                 filename: str = Query(..., min_length=1, max_length=255),
                 category: str = Query("Temas", max_length=20)):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > resources.MAX_BYTES:
        raise HTTPException(413, "El archivo supera 200 MB")
    buf = bytearray()
    async for part in request.stream():
        buf.extend(part)
        if len(buf) > resources.MAX_BYTES:
            raise HTTPException(413, "El archivo supera 200 MB")
    base = services(request).config.resources_dir
    try:
        return await run_in_threadpool(resources.save_file, base, subject, category, filename, bytes(buf))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
