"""/api/bank/* — subjects, topics and questions over HTTP (same logic as the tools)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from .. import agent_tools as tools
from .. import bank
from .deps import services

router = APIRouter(prefix="/api/bank")


def _run(fn, *args):
    try:
        return fn(*args)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.get("/subjects")
def subjects(request: Request):
    return {"subjects": bank.list_subjects(services(request))}


@router.get("/subjects/{subject_id}/topics")
def topics(request: Request, subject_id: str):
    return _run(tools.run_topics_list, services(request), tools.SubjectArg(subject=subject_id))


@router.get("/questions")
def questions(request: Request, subject: str | None = None, topic: str | None = None, q: str | None = None,
              type: str | None = None, limit: int = Query(50, ge=1, le=500)):
    if type is not None and type not in bank.QUESTION_TYPES:
        raise HTTPException(400, f"type must be one of {', '.join(bank.QUESTION_TYPES)}.")
    args = tools.QuestionsSearchArgs(q=q, subject=subject, topic=topic, type=type, limit=min(limit, 200))
    return _run(tools.run_questions_search, services(request), args)


@router.post("/questions")
def add_questions(request: Request, body: tools.QuestionsAddArgs):
    return _run(tools.run_questions_add, services(request), body)


@router.patch("/questions/{question_id}")
def update_question(request: Request, question_id: str, body: dict[str, Any]):
    args = tools.QuestionUpdateArgs.model_validate({**body, "id": question_id})
    return _run(tools.run_question_update, services(request), args)


@router.delete("/questions/{question_id}")
def delete_question(request: Request, question_id: str):
    return _run(tools.run_question_delete, services(request), tools.QuestionDeleteArgs(id=question_id))
