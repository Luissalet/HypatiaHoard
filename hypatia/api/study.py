"""/api/study/* — due queue, review, grading, weak topics, mock exam, stats."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from .. import agent_tools as tools
from .. import oral
from .deps import services

router = APIRouter(prefix="/api/study")


def _run(fn, request: Request, args):
    try:
        return fn(services(request), args)
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/calendar/export")
def calendar_export(request: Request, body: tools.StudyCalendarArgs):
    return _run(tools.run_study_calendar_export, request, body)


@router.post("/plan")
def study_plan(request: Request, body: tools.StudyPlanArgs):
    return _run(tools.run_study_plan, request, body)


@router.post("/plan/clear")
def study_plan_clear(request: Request, body: tools.StudyPlanClearArgs):
    return _run(tools.run_study_plan_clear, request, body)


@router.post("/due")
def due(request: Request, body: tools.CardsDueArgs):
    return _run(tools.run_cards_due, request, body)


@router.post("/review")
def review(request: Request, body: tools.CardReviewArgs):
    return _run(tools.run_card_review, request, body)


@router.post("/pages")
def page_add(request: Request, body: tools.PageCardAddArgs):
    return _run(tools.run_page_card_add, request, body)


@router.post("/pages/list")
def pages_list(request: Request, body: tools.PagesListArgs):
    return _run(tools.run_pages_list, request, body)


@router.post("/lessons")
def lesson_create(request: Request, body: tools.LessonFromDocumentArgs):
    return _run(tools.run_lesson_from_document, request, body)


@router.post("/lessons/get")
def lesson_get(request: Request, body: tools.LessonRef):
    return _run(tools.run_lesson_get, request, body)


@router.post("/lessons/mastery")
def lesson_mastery(request: Request, body: tools.ConceptMasteryArgs):
    return _run(tools.run_concept_mastery, request, body)


@router.post("/lessons/delete")
def lesson_delete(request: Request, body: tools.LessonDeleteArgs):
    return _run(tools.run_lesson_delete, request, body)


@router.post("/grade")
def grade(request: Request, body: tools.AnswerGradeArgs):
    return _run(tools.run_answer_grade, request, body)


@router.get("/oral/status")
def oral_status(request: Request):
    return oral.status(services(request))


@router.post("/oral/next")
def oral_next(request: Request, body: tools.OralCardNextArgs):
    return _run(tools.run_oral_card_next, request, body)


@router.post("/oral/answer")
def oral_answer(request: Request, body: tools.OralCardAnswerArgs):
    return _run(tools.run_oral_card_answer, request, body)


@router.post("/oral/answer-audio")
async def oral_answer_audio(request: Request, id: str = Query(..., min_length=1, max_length=100),
                            subject: str | None = Query(None, max_length=200), topic: str | None = Query(None, max_length=200),
                            record: bool = Query(True), speak_feedback: bool = Query(True),
                            language: str = Query("es", max_length=12), exclude: str = Query("", max_length=80000),
                            filename: str = Query("", max_length=300)):
    """The recorded answer as the request body (what the microphone button and «Subir audio» send)."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > oral.MAX_ANSWER_BYTES:
        raise HTTPException(413, "El audio supera 40 MB.")
    buf = bytearray()
    async for part in request.stream():
        buf.extend(part)
        if len(buf) > oral.MAX_ANSWER_BYTES:
            raise HTTPException(413, "El audio supera 40 MB.")
    content_type = request.headers.get("content-type", "")

    def work() -> dict:
        try:
            path = oral.save_answer_audio(bytes(buf), content_type, filename)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        try:
            args = tools.OralCardAnswerArgs(id=id, subject=subject, topic=topic, audio_path=str(path), record=record,
                                            speak_feedback=speak_feedback, language=language,
                                            exclude=[part for part in exclude.split(",") if part])
            return _run(tools.run_oral_card_answer, request, args)
        finally:
            path.unlink(missing_ok=True)

    return await run_in_threadpool(work)


@router.post("/oral/speak")
def oral_speak(request: Request, body: tools.OralSpeakArgs):
    return _run(tools.run_oral_speak, request, body)


@router.get("/oral/audio/{name}")
def oral_audio(request: Request, name: str):
    path = oral.audio_file(services(request), name)
    if path is None:
        raise HTTPException(404, "No existe ese audio.")
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "private, max-age=86400"})


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
