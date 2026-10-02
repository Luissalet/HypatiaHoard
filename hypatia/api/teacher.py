"""/api/teacher/* — the teacher role for the app: sync of the teacher store with the
app's IndexedDB, background jobs (question generation, grading), rubric drafts,
photo transcription, and the files the tools export."""

from __future__ import annotations

import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..teacher import assess, jobs, rubrics
from ..teacher.store import teacher_store
from .deps import services

router = APIRouter(prefix="/api/teacher")


class RecordIn(BaseModel):
    kind: str = Field(..., max_length=40)
    id: str = Field(..., min_length=1, max_length=200)
    updatedAt: str = Field(..., max_length=40)
    deleted: bool = False
    data: Optional[dict[str, Any]] = None


class PushBody(BaseModel):
    records: list[RecordIn] = Field(default_factory=list, max_length=5000)


class JobBody(BaseModel):
    kind: Literal["exam_generate", "grading_run"]
    params: dict[str, Any] = Field(default_factory=dict)


class ProposeBody(BaseModel):
    question: dict[str, Any]
    points: float = Field(1, ge=0, le=1000)


class TranscribeBody(BaseModel):
    image: str = Field(..., min_length=10, max_length=20_000_000, description="Base64 PNG/JPEG (no data: prefix needed).")


@router.get("/sync/state")
def sync_state(request: Request):
    store = teacher_store(services(request))
    return {"rev": store.current_rev(), "counts": store.counts()}


@router.get("/sync/pull")
def sync_pull(request: Request, since: int = Query(0, ge=0)):
    store = teacher_store(services(request))
    with store.db.lock:
        rev = store.current_rev()
        records = store.changed_since(since)
    return {"rev": rev, "records": records}


@router.post("/sync/push")
def sync_push(request: Request, body: PushBody):
    store = teacher_store(services(request))
    return store.push([r.model_dump() for r in body.records])


@router.post("/jobs")
def job_create(request: Request, body: JobBody):
    svc = services(request)
    store = teacher_store(svc)
    if body.kind == "exam_generate":
        exam = store.get("teacherExam", str(body.params.get("examId") or ""))
        if exam is None:
            raise HTTPException(404, "The exam is not on the server yet: sync and try again.")
        counts = {k: int(v) for k, v in (body.params.get("counts") or {}).items()
                  if k in ("TEST", "DESARROLLO", "COMPLETAR", "PRACTICO") and int(v) > 0}
        if not counts:
            raise HTTPException(400, "Nothing to generate.")
        job = jobs.create(svc, "exam_generate", {"examId": exam["id"], "counts": counts})
        store.put("teacherExam", {**exam, "jobId": job["id"]})
        return job
    batch = store.get("gradingBatch", str(body.params.get("batchId") or ""))
    if batch is None:
        raise HTTPException(404, "The batch is not on the server yet: sync and try again.")
    params = {"batchId": batch["id"], "studentIds": list(body.params.get("studentIds") or []),
              "questionIds": list(body.params.get("questionIds") or []), "force": bool(body.params.get("force"))}
    return jobs.create(svc, "grading_run", params)


@router.get("/jobs")
def job_list(request: Request, active: bool = False):
    return {"jobs": jobs.list_jobs(services(request), active_only=active)}


@router.get("/jobs/{job_id}")
def job_get(request: Request, job_id: str):
    job = jobs.get(services(request), job_id)
    if job is None:
        raise HTTPException(404, "No such job.")
    return job


@router.post("/rubrics/propose")
def rubric_propose(request: Request, body: ProposeBody):
    return rubrics.propose(services(request), body.question, body.points)


@router.post("/transcribe")
def transcribe(request: Request, body: TranscribeBody):
    image = re.sub(r"^data:[^;]+;base64,", "", body.image.strip())
    return assess.transcribe(services(request), image)


_SAFE = re.compile(r"^[\w.\-]+\.(pdf|csv)$")


@router.get("/files/{name}")
def exported_file(request: Request, name: str):
    if not _SAFE.match(name):
        raise HTTPException(404, "No such file.")
    base = (services(request).config.data_dir / "teacher" / "exports").resolve()
    path = (base / name).resolve()
    if not path.is_file() or base not in path.parents:
        raise HTTPException(404, "No such file.")
    media = "application/pdf" if name.endswith(".pdf") else "text/csv; charset=utf-8"
    return FileResponse(path, media_type=media, filename=name)
