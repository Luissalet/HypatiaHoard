"""/api/study/* — due queue, review, grading, weak topics, mock exam, stats."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import agent_tools as tools
from .deps import services

router = APIRouter(prefix="/api/study")


def _run(fn, request: Request, args):
    try:
        return fn(services(request), args)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/due")
def due(request: Request, body: tools.CardsDueArgs):
    return _run(tools.run_cards_due, request, body)


@router.post("/review")
def review(request: Request, body: tools.CardReviewArgs):
    return _run(tools.run_card_review, request, body)


@router.post("/grade")
def grade(request: Request, body: tools.AnswerGradeArgs):
    return _run(tools.run_answer_grade, request, body)


@router.post("/weak-topics")
def weak_topics(request: Request, body: tools.WeakTopicsArgs):
    return _run(tools.run_weak_topics, request, body)


@router.post("/mock-exam")
def mock_exam(request: Request, body: tools.ExamMockArgs):
    return _run(tools.run_exam_mock, request, body)


@router.post("/stats")
def stats(request: Request, body: tools.OptionalSubject):
    return _run(tools.run_study_stats, request, body)


@router.post("/suggest")
def suggest(request: Request, body: tools.QuestionsSuggestArgs):
    return _run(tools.run_questions_suggest, request, body)


@router.post("/suggest/accept")
def suggest_accept(request: Request, body: tools.QuestionsSuggestAcceptArgs):
    return _run(tools.run_questions_suggest_accept, request, body)
