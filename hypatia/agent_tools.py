"""Tools exposed to the assistant. One list drives /api/agent/* and mcp_server.py:
the study tools defined here, the notebook tools (hypatia.notebook, optional) and
two Hypatia-compatibility aliases used by Faustus's `hoard-study-cards` skill."""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, Field

from . import bank, grading, study, suggest
from .services import Services
from .tooling import Tool, ann

try:  # Agent B's notebook package; the study tools work without it.
    from .notebook import NOTEBOOK_TOOLS
except ImportError:  # pragma: no cover - depends on the checkout
    NOTEBOOK_TOOLS = []

AGENT_INSTRUCTIONS = """Hypatia's Hoard is the user's exam-prep bank (the same data as the Exam Coach PWA at http://127.0.0.1:5187, synced both ways): subjects, topics, questions (TEST, DESARROLLO, COMPLETAR, PRACTICO) with spaced repetition, key concepts, deliverables, and a notebook of the user's own sources (PDFs, notes) with citations.
Quizzing: call cards_due (or exam_mock for a mock exam), show ONLY the prompt (and the options for TEST), wait for the user's real answer, then grade it: answer_grade for TEST/COMPLETAR (deterministic) or DESARROLLO/PRACTICO (model rubric; if it returns no verdict, compare with modelAnswer yourself), then call card_review once with the prompt you showed (and the id) and the grade the answer earns: again if wrong, blank, "no me acuerdo" or about something else; hard if partly right; good if right; easy only if instant and complete. Then say what the model answer said.
Never reveal the answer before the user has answered. Never call card_review without a real answer from the user in this conversation. Never invent questions, grades or sources.
Adding questions: only from material the user has (their notes, a notebook source, what they said). Prefer questions_suggest (shows drafts; nothing saved) and save only what the user accepts with questions_suggest_accept. If a tool returns `material` and a `note` instead of drafts/answers, no local model was available: do the work yourself from that material.
Notebook: cite passages with [n] exactly as the tools number them, never cite a source you were not given, and prefer notebook_search (cheap, passages with citations) when you can compose the answer yourself; use notebook_ask/studio_generate when the user wants the app to generate it.
Never read the data folder or the database directly; use these tools only."""

QType = Literal["TEST", "DESARROLLO", "COMPLETAR", "PRACTICO"]
Grade = Union[int, str]


class Empty(BaseModel):
    pass


class SubjectArg(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description="Subject name, slug, unique prefix or id.")


class OptionalSubject(BaseModel):
    subject: str | None = Field(None, max_length=200, description="Subject name, slug, prefix or id; omit for all.")


class QuestionsSearchArgs(BaseModel):
    q: str | None = Field(None, max_length=500, description="Words to find (diacritics-insensitive); omit to list.")
    subject: str | None = Field(None, max_length=200)
    topic: str | None = Field(None, max_length=200, description="Topic title, id or number ('3', 'tema 3').")
    type: QType | None = None
    limit: int = Field(20, ge=1, le=200)
    with_answers: bool = Field(True, description="Include the answers (false when quizzing).")


class QuestionRef(BaseModel):
    id: str | None = Field(None, max_length=100, description="Question id.")
    prompt: str | None = Field(None, max_length=8000, description="The exact prompt, when there is no id.")
    subject: str | None = Field(None, max_length=200, description="Subject, to disambiguate a prompt.")


class OptionIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=20)
    text: str = Field(..., min_length=1, max_length=4000)


class BlankIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)
    accepted: list[str] = Field(..., min_length=1, max_length=20)


class QuestionIn(BaseModel):
    """ExtractedQuestion (src/services/aiEngine.ts)."""

    type: QType
    prompt: str = Field(..., min_length=1, max_length=8000, description="Markdown (LaTeX allowed).")
    options: list[OptionIn] | None = Field(None, max_length=10, description="TEST: options with ids 'a','b',...")
    correctOptionIds: list[str] | None = Field(None, max_length=10, description="TEST: ids of the correct options.")
    modelAnswer: str | None = Field(None, max_length=16000, description="DESARROLLO/PRACTICO: the model answer.")
    keywords: list[str] | None = Field(None, max_length=30)
    numericAnswer: str | None = Field(None, max_length=200, description="PRACTICO: expected numeric result.")
    clozeText: str | None = Field(None, max_length=8000, description="COMPLETAR: text with {{blank1}} markers.")
    blanks: list[BlankIn] | None = Field(None, max_length=30)
    explanation: str | None = Field(None, max_length=8000)
    difficulty: int | None = Field(None, ge=1, le=5)
    origin: Literal["test", "examen_anterior", "clase", "alumno"] | None = None
    tags: list[str] | None = Field(None, max_length=30)


class QuestionsAddArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description="Existing subject (name, slug, prefix or id).")
    topic: str | None = Field(None, max_length=200, description="Topic title/id/number; a new title is created; omit for 'General'.")
    questions: list[QuestionIn] = Field(..., min_length=1, max_length=100)


class QuestionUpdateArgs(BaseModel):
    id: str = Field(..., min_length=1, max_length=100)
    prompt: str | None = Field(None, min_length=1, max_length=8000)
    options: list[OptionIn] | None = Field(None, max_length=10)
    correctOptionIds: list[str] | None = Field(None, max_length=10)
    modelAnswer: str | None = Field(None, max_length=16000)
    keywords: list[str] | None = Field(None, max_length=30)
    numericAnswer: str | None = Field(None, max_length=200)
    clozeText: str | None = Field(None, max_length=8000)
    blanks: list[BlankIn] | None = Field(None, max_length=30)
    explanation: str | None = Field(None, max_length=8000)
    difficulty: int | None = Field(None, ge=1, le=5)
    tags: list[str] | None = Field(None, max_length=30)
    notes: str | None = Field(None, max_length=8000, description="The user's personal note.")
    starred: bool | None = Field(None, description="Marked as difficult by the user.")
    topic: str | None = Field(None, max_length=200, description="Move to this topic (title, id or number).")


class QuestionDeleteArgs(BaseModel):
    id: str = Field(..., min_length=1, max_length=100)


class CardsDueArgs(BaseModel):
    subject: str | None = Field(None, max_length=200, description="Subject; omit for every subject.")
    deck: str | None = Field(None, max_length=200, description="Alias of subject (Hypatia compatibility).")
    topic: str | None = Field(None, max_length=200)
    limit: int = Field(10, ge=1, le=100)


class CardReviewArgs(BaseModel):
    id: str | int | None = Field(None, description="The question id from cards_due.")
    prompt: str | None = Field(None, max_length=8000, description="The prompt you showed. Always give it: it wins over the id.")
    front: str | None = Field(None, max_length=8000, description="Alias of prompt (Hypatia compatibility).")
    grade: Grade = Field(..., description="again (wrong/blank/'no me acuerdo'), hard (partly right), good (right), easy (instant and complete); or 0-3.")
    subject: str | None = Field(None, max_length=200, description="Subject, to disambiguate a prompt.")
    deck: str | None = Field(None, max_length=200, description="Alias of subject.")


class AnswerGradeArgs(BaseModel):
    id: str | None = Field(None, max_length=100)
    prompt: str | None = Field(None, max_length=8000, description="The prompt shown, when there is no id.")
    subject: str | None = Field(None, max_length=200)
    answer: str | list[str] | dict[str, str] = Field(..., description="The user's answer: free text; TEST: letters/ids/texts ('a, c'); COMPLETAR: text per blank (list or {blankId: text}).")


class WeakTopicsArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    limit: int = Field(10, ge=1, le=100)


class ExamMockArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    n: int = Field(20, ge=1, le=100, description="Number of questions.")
    topic: str | None = Field(None, max_length=200)
    types: list[QType] | None = None
    save: bool = Field(True, description="Save it as an exam the PWA can practice ('Simulacro <date>').")


class KeyConceptsArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    topic: str | None = Field(None, max_length=200)
    category: Literal["formula", "definition", "remark"] | None = None
    q: str | None = Field(None, max_length=200, description="Words that must appear in title or content.")
    limit: int = Field(50, ge=1, le=500)


class KeyConceptAddArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    topic: str | None = Field(None, max_length=200)
    category: Literal["formula", "definition", "remark"]
    title: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., min_length=1, max_length=16000, description="Markdown with LaTeX.")
    tags: list[str] | None = Field(None, max_length=30)


class TextSource(BaseModel):
    kind: Literal["text"]
    text: str = Field(..., min_length=1, max_length=200_000)


class ScribeSource(BaseModel):
    kind: Literal["scribe"]
    session_id: str | None = Field(None, max_length=100)
    since: str | None = Field(None, max_length=40)
    until: str | None = Field(None, max_length=40)


class SourcesSource(BaseModel):
    kind: Literal["sources"]
    query: str | None = Field(None, max_length=500, description="Words to focus on within the subject's sources.")


class QuestionsSuggestArgs(BaseModel):
    source: Union[TextSource, ScribeSource, SourcesSource] = Field(..., discriminator="kind")
    subject: str = Field(..., min_length=1, max_length=200)
    topic: str | None = Field(None, max_length=200)
    n: int = Field(8, ge=1, le=30)
    types: list[QType] | None = Field(None, description="Allowed types; default TEST and DESARROLLO.")
    language: Literal["es", "en", "auto"] = "es"


class QuestionsSuggestAcceptArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    topic: str | None = Field(None, max_length=200)
    drafts: list[QuestionIn] = Field(..., min_length=1, max_length=100)


class DeliverablesArgs(BaseModel):
    subject: str | None = Field(None, max_length=200)
    days: int = Field(30, ge=1, le=365)


class CardIn(BaseModel):
    front: str = Field(..., min_length=1, max_length=8000)
    back: str = Field(..., min_length=1, max_length=16000)
    tags: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field("", max_length=1000)


class CardsAddArgs(BaseModel):
    deck: str = Field(..., min_length=1, max_length=200, description="Subject name; created if missing.")
    cards: list[CardIn] = Field(..., min_length=1, max_length=100)


# ---------- helpers ----------

def _subject(services: Services, ref: str | None) -> dict | None:
    return services.resolve_subject(ref) if ref and ref.strip() else None


def _topic(services: Services, subject: dict | None, ref: str | None) -> dict | None:
    if not ref or not ref.strip():
        return None
    if subject is None:
        raise ValueError("A topic needs its subject.")
    return services.resolve_topic(subject["id"], ref)


def _topic_for_write(services: Services, subject: dict, ref: str | None) -> dict:
    if ref and ref.strip():
        try:
            return services.resolve_topic(subject["id"], ref)
        except LookupError:
            pass
    return bank.ensure_topic(services, subject["id"], ref)


def _question(services: Services, id: str | None, prompt: str | None, subject_ref: str | None) -> dict:
    if id:
        q = services.store.get("question", str(id))
        if q is not None:
            return q
    subject = _subject(services, subject_ref)
    if prompt and prompt.strip():
        found = bank.find_by_prompt(services, prompt, subject["id"] if subject else None)
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise ValueError(f"{len(found)} questions have that prompt; give the id or the subject.")
    raise LookupError(f"No question {'with id ' + str(id) if id else 'with that prompt'}.")


def _dump(items: list[BaseModel]) -> list[dict]:
    return [i.model_dump(exclude_none=True) for i in items]


# ---------- study tools ----------

def run_subjects_list(services: Services, _: Empty) -> dict:
    return {"subjects": bank.list_subjects(services)}


def run_topics_list(services: Services, args: SubjectArg) -> dict:
    subject = services.resolve_subject(args.subject)
    return {"subject": subject["name"], "subjectId": subject["id"], "topics": bank.list_topics(services, subject["id"])}


def run_questions_search(services: Services, args: QuestionsSearchArgs) -> dict:
    subject = _subject(services, args.subject)
    topic = _topic(services, subject, args.topic)
    hits = bank.search_questions(services, args.q, subject["id"] if subject else None, topic["id"] if topic else None,
                                 args.type, args.limit)
    titles = bank.topic_titles(services, subject["id"] if subject else None)
    return {"query": args.q, "count": len(hits), "questions": [bank.brief(h, args.with_answers, titles) for h in hits]}


def run_question_get(services: Services, args: QuestionRef) -> dict:
    q = _question(services, args.id, args.prompt, args.subject)
    return {"question": q}


def run_questions_add(services: Services, args: QuestionsAddArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    topic = _topic_for_write(services, subject, args.topic)
    out = []
    for item in _dump(args.questions):
        q, existing = bank.add_question(services, subject, topic, item)
        out.append({"id": q["id"], "existing": existing})
    return {"subject": subject["name"], "topic": topic.get("title"), "questions": out,
            "added": sum(1 for r in out if not r["existing"])}


def run_question_update(services: Services, args: QuestionUpdateArgs) -> dict:
    question = bank.get_question(services, args.id)
    patch = args.model_dump(exclude={"id", "topic"}, exclude_none=True)
    if args.topic:
        subject = services.store.get("subject", question.get("subjectId"))
        if subject is None:
            raise LookupError("The question's subject no longer exists.")
        patch["topicId"] = services.resolve_topic(subject["id"], args.topic)["id"]
    return {"question": bank.update_question(services, question, patch)}


def run_question_delete(services: Services, args: QuestionDeleteArgs) -> dict:
    bank.get_question(services, args.id)
    services.store.delete("question", args.id)
    return {"ok": True, "id": args.id}


def run_cards_due(services: Services, args: CardsDueArgs) -> dict:
    subject = _subject(services, args.subject or args.deck)
    topic = _topic(services, subject, args.topic)
    return study.due_queue(services, subject["id"] if subject else None, topic["id"] if topic else None, args.limit)


def run_card_review(services: Services, args: CardReviewArgs) -> dict:
    subject = _subject(services, args.subject or args.deck)
    question = study.pick_reviewed_question(services, str(args.id) if args.id is not None else None,
                                            args.prompt or args.front, subject["id"] if subject else None)
    return study.review(services, question, args.grade)


def run_answer_grade(services: Services, args: AnswerGradeArgs) -> dict:
    question = _question(services, args.id, args.prompt, args.subject)
    return grading.grade(services, question, args.answer)


def run_weak_topics(services: Services, args: WeakTopicsArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    return {"subject": subject["name"], "topics": study.weak_topics(services, subject["id"])[: args.limit]}


def run_exam_mock(services: Services, args: ExamMockArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    topic = _topic(services, subject, args.topic)
    return study.mock_exam(services, subject, args.n, topic["id"] if topic else None, args.types, args.save)


def run_study_stats(services: Services, args: OptionalSubject) -> dict:
    return study.stats(services, _subject(services, args.subject))


def run_key_concepts(services: Services, args: KeyConceptsArgs) -> dict:
    from .hashing import normalize_text

    subject = services.resolve_subject(args.subject)
    topic = _topic(services, subject, args.topic)
    items = services.store.list("keyConcept", subject["id"])
    if topic:
        items = [c for c in items if c.get("topicId") == topic["id"]]
    if args.category:
        items = [c for c in items if c.get("category") == args.category]
    if args.q:
        needle = normalize_text(args.q)
        items = [c for c in items if needle in normalize_text(f"{c.get('title', '')} {c.get('content', '')}")]
    items.sort(key=lambda c: (c.get("category") or "", c.get("order") or 0))
    keys = ("id", "category", "title", "content", "topicId", "tags")
    return {"subject": subject["name"], "count": len(items),
            "concepts": [{k: c[k] for k in keys if c.get(k) is not None} for c in items[: args.limit]]}


def run_key_concept_add(services: Services, args: KeyConceptAddArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    topic = _topic(services, subject, args.topic)
    concept, existing = bank.add_key_concept(services, subject, topic, args.category, args.title, args.content, args.tags)
    return {"concept": concept, "existing": existing}


def run_questions_suggest(services: Services, args: QuestionsSuggestArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    topic = _topic(services, subject, args.topic)
    try:
        return suggest.suggest(services, args.source.model_dump(), subject, topic, args.n,
                               list(args.types or ["TEST", "DESARROLLO"]), args.language)
    except suggest.SuggestInputError as error:
        raise ValueError(str(error)) from error


def run_questions_suggest_accept(services: Services, args: QuestionsSuggestAcceptArgs) -> dict:
    subject = services.resolve_subject(args.subject)
    topic = _topic_for_write(services, subject, args.topic)
    return suggest.accept(services, subject, topic, _dump(args.drafts))


def run_deliverables_upcoming(services: Services, args: DeliverablesArgs) -> dict:
    subject = _subject(services, args.subject)
    rows = study.upcoming_deliverables(services, subject["id"] if subject else None, args.days)
    return {"days": args.days, "count": len(rows), "deliverables": rows}


# ---------- Hypatia compatibility ----------

def run_cards_add(services: Services, args: CardsAddArgs) -> dict:
    subject, created = bank.ensure_subject(services, args.deck)
    topic = bank.ensure_topic(services, subject["id"], "Tarjetas")
    out = []
    for card in args.cards:
        data: dict[str, Any] = {"type": "DESARROLLO", "prompt": card.front, "modelAnswer": card.back, "origin": "alumno"}
        if card.tags:
            data["tags"] = card.tags
        if card.source.strip():
            data["explanation"] = f"Fuente: {card.source.strip()}"
        q, existing = bank.add_question(services, subject, topic, data)
        out.append({"id": q["id"], "existing": existing})
    return {"deck": subject["name"], "subjectCreated": created, "cards": out, "count": len(out)}


def run_decks_list(services: Services, _: Empty) -> dict:
    subjects = bank.list_subjects(services)
    return {"decks": [{"id": s["id"], "name": s["name"], "cards": s["questions"], "due_now": s["due"],
                       "new": s["neverSeen"]} for s in subjects], "subjects": subjects}


SYN = "\nSinónimos: "

STUDY_TOOLS: list[Tool] = [
    Tool("subjects_list", "List the user's subjects with question counts, due today, exam date. Keywords: asignaturas, materias."
         "\nEvery subject of the exam-prep bank (same data as the Exam Coach PWA): questions, topics, due today, never seen, examDate."
         + SYN + "asignaturas, materias, qué estudio, listar asignaturas, mis asignaturas.", Empty, ann(True), run_subjects_list),
    Tool("topics_list", "List the topics (temas) of a subject in order, with question counts. Keywords: temas, temario."
         "\nNumbered 1..n: the number can be used as the topic reference in other tools ('3' or 'tema 3')."
         + SYN + "temas, temario, índice, lista de temas.", SubjectArg, ann(True), run_topics_list),
    Tool("questions_search", "Search the question bank by words, subject, topic or type. Keywords: buscar preguntas, banco."
         "\nFull-text, diacritics-insensitive; without q it lists. Set with_answers=false when quizzing."
         + SYN + "buscar pregunta, dónde tengo esto, preguntas del tema, banco de preguntas.", QuestionsSearchArgs, ann(True),
         run_questions_search),
    Tool("question_get", "Get one question with its answer, stats and notes, by id or exact prompt. Keywords: ver pregunta."
         "\nReturns the full stored record (options, correctOptionIds, modelAnswer, blanks, explanation, stats, notes)."
         + SYN + "ver pregunta, detalle de pregunta, respuesta de la pregunta.", QuestionRef, ann(True), run_question_get),
    Tool("questions_add", "Add exam questions to a subject (write): TEST, DESARROLLO, COMPLETAR, PRACTICO. Keywords: añadir preguntas."
         "\nExtractedQuestion shape. Idempotent per subject on the content hash (duplicates come back existing: true). "
         "The subject must exist; an unknown topic title is created. Only from material the user has."
         + SYN + "añadir pregunta, crear pregunta, nueva pregunta, guardar preguntas.", QuestionsAddArgs, ann(False, False, True),
         run_questions_add),
    Tool("question_update", "Edit a question's text, options, answer, tags, notes, starred or topic (write). Keywords: editar pregunta."
         "\nOnly the given fields change; the content hash is recomputed; syncs to the PWA."
         + SYN + "editar pregunta, corregir pregunta, marcar difícil, nota personal, mover de tema.", QuestionUpdateArgs,
         ann(False, False, True), run_question_update),
    Tool("question_delete", "Permanently delete a question (write, destructive). Keywords: borrar pregunta, eliminar."
         "\nThe deletion syncs to every device." + SYN + "borrar pregunta, eliminar pregunta, quitar pregunta.",
         QuestionDeleteArgs, ann(False, True, True), run_question_delete),
    Tool("cards_due", "Questions due for review now, to quiz the user in chat. Keywords: examíname, repaso, pendientes."
         "\nOverdue first, then never seen, then last failed. Includes the answers FOR YOU: show only the prompt (and options), "
         "never the answer, until the user has answered." + SYN + "repasar, pregúntame, quiz, examíname, qué me toca hoy, tarjetas pendientes.",
         CardsDueArgs, ann(True), run_cards_due),
    Tool("card_review", "Grade the question the user just answered: again/hard/good/easy (write). Keywords: calificar, acierto."
         "\nUpdates stats and SM-2 schedule like the PWA. Pass the prompt you showed (it wins over the id). Call exactly once per "
         "real answer; never grade on the user's behalf. Returns the next due question."
         + SYN + "calificar, he acertado, he fallado, lo sabía, no lo sabía, siguiente pregunta.", CardReviewArgs,
         ann(False, False, False), run_card_review),
    Tool("answer_grade", "Check the user's answer to a question: verdict, score, feedback. Keywords: corregir respuesta."
         "\nTEST/COMPLETAR deterministic; DESARROLLO/PRACTICO with a local model rubric (without one: matched keywords + "
         "modelAnswer for you to judge). Returns suggestedGrade for card_review. Saves nothing."
         + SYN + "corregir, evaluar respuesta, está bien mi respuesta, nota, puntuar.", AnswerGradeArgs, ann(True, False, False),
         run_answer_grade),
    Tool("weak_topics", "Rank a subject's topics by weakness: accuracy, failed, overdue, never seen. Keywords: puntos débiles."
         "\nScore 0-100 (higher = weaker) per topic." + SYN + "temas flojos, qué me cuesta, dónde fallo, puntos débiles, qué repasar.",
         WeakTopicsArgs, ann(True), run_weak_topics),
    Tool("exam_mock", "Build a mock exam weighted to weak topics and save it for the PWA (write). Keywords: simulacro, examen."
         "\nReturns the questions WITHOUT answers for a chat exam and saves an exam 'Simulacro <date>' (save=false to skip)."
         + SYN + "simulacro, examen de prueba, hazme un examen, test de práctica.", ExamMockArgs, ann(False, False, False),
         run_exam_mock),
    Tool("study_stats", "Study statistics per subject: seen %, accuracy, due today, streak, days to exam. Keywords: progreso."
         "\nAlso upcoming deliverables per subject." + SYN + "estadísticas, cómo voy, racha, progreso, cuánto falta para el examen.",
         OptionalSubject, ann(True), run_study_stats),
    Tool("key_concepts", "List a subject's key concepts: formulas, definitions, remarks. Keywords: conceptos clave, fórmulas."
         "\nFilter by topic, category or words." + SYN + "conceptos clave, fórmulas, definiciones, chuleta, resumen de fórmulas.",
         KeyConceptsArgs, ann(True), run_key_concepts),
    Tool("key_concept_add", "Add a key concept (formula, definition or remark) to a subject (write). Keywords: añadir concepto."
         "\nIdempotent on the concept hash within the subject." + SYN + "añadir fórmula, guardar definición, nuevo concepto clave.",
         KeyConceptAddArgs, ann(False, False, True), run_key_concept_add),
    Tool("questions_suggest", "Draft exam questions from text, a transcript or notebook sources (nothing saved). Keywords: proponer."
         "\nSource kind text | scribe (session_id or since/until) | sources (the subject's indexed notebook, optional query). "
         "Returns drafts to show the user, or `material` + `note` when no model is available (then draft them yourself)."
         + SYN + "sugerir preguntas, genera preguntas, preguntas de mis apuntes, preguntas de la clase.", QuestionsSuggestArgs,
         ann(False, False, False), run_questions_suggest),
    Tool("questions_suggest_accept", "Save the question drafts the user accepted (write). Keywords: guardar sugeridas, aceptar."
         "\nSame effect as questions_add (dedupe by content hash)." + SYN + "acepta las preguntas, guarda las sugeridas.",
         QuestionsSuggestAcceptArgs, ann(False, False, True), run_questions_suggest_accept),
    Tool("deliverables_upcoming", "Upcoming deliverables (activities, tests, exams) with due dates. Keywords: entregas, plazos."
         "\nPending items due within `days`, soonest first." + SYN + "entregas, qué tengo que entregar, plazos, fechas límite.",
         DeliverablesArgs, ann(True), run_deliverables_upcoming),
]

COMPAT_TOOLS: list[Tool] = [
    Tool("cards_add", "Alias of questions_add (Hypatia compatibility): add flashcards as DESARROLLO questions (write)."
         "\n{deck, cards:[{front, back, tags, source}]}: deck = subject (created if missing), topic 'Tarjetas', front = prompt, "
         "back = modelAnswer." + SYN + "añadir tarjeta, crear tarjeta, flashcard, memorizar esto.", CardsAddArgs,
         ann(False, False, True), run_cards_add),
    Tool("decks_list", "Alias of subjects_list (Hypatia compatibility): subjects as decks with counts and due now."
         "\nSame data as subjects_list." + SYN + "mazos, barajas, listar mazos.", Empty, ann(True), run_decks_list),
]

TOOLS: list[Tool] = STUDY_TOOLS + list(NOTEBOOK_TOOLS) + COMPAT_TOOLS
TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


def tool_catalog() -> list[dict]:
    return [{"name": t.name, "description": t.description, "annotations": t.annotations,
             "inputSchema": t.input_model.model_json_schema(by_alias=True)} for t in TOOLS]


def call_tool(services: Services, name: str, arguments: dict | None) -> Any:
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        raise KeyError(f"Unknown tool: {name}")
    return tool.run(services, tool.input_model.model_validate(arguments or {}))
