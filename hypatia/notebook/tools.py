"""Notebook tools for the assistant (Faustus / MCP). Each degrades without a model."""

from __future__ import annotations

import time
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from ..tooling import Tool, ann
from . import ask as ask_mod
from . import retrieval, sources, studio, tutor, worker
from .llm import NoModel
from .schema import rows

StudioKind = Literal["study_guide", "briefing", "faq", "glossary", "timeline", "mindmap", "podcast"]

SUBJECT_DESC = "Subject (asignatura) id, name or slug."
TOPIC_DESC = "Optional topic (tema): id, title, or number like '3' / 'tema 3'."


class NotebookSourcesArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)


class SourceAddArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    path: str = Field(..., min_length=1, max_length=2000,
                      description="Local file or folder (PDF, MD, TXT, DOCX), read in place; folders recursively.")
    wait_s: int = Field(20, ge=0, le=120, description="Seconds to wait for indexing to finish (0 = return at once).")


class NotebookSearchArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    query: str = Field(..., min_length=1, max_length=2000)
    topic: Optional[str] = Field(None, max_length=200, description=TOPIC_DESC)
    source_ids: Optional[list[str]] = Field(None, max_length=50)
    k: int = Field(8, ge=1, le=20, description="How many passages.")


class NotebookAskArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    question: str = Field(..., min_length=1, max_length=4000)
    topic: Optional[str] = Field(None, max_length=200, description=TOPIC_DESC)
    source_ids: Optional[list[str]] = Field(None, max_length=50)
    chat_id: Optional[str] = Field(None, max_length=100, description="Continue an existing notebook chat.")


class StudioGenerateArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    kind: StudioKind = Field(..., description="study_guide, briefing, faq, glossary, timeline, mindmap or podcast.")
    topic: Optional[str] = Field(None, max_length=200, description=TOPIC_DESC)
    source_ids: Optional[list[str]] = Field(None, max_length=50)
    instructions: Optional[str] = Field(None, max_length=2000, description="Extra guidance (focus, level, length).")
    add_as_source: bool = Field(False, description="Also add the result as a notebook source when done.")
    wait_s: int = Field(30, ge=0, le=120, description="Seconds to wait for the job (0 = return the job id at once).")


class StudioGetArgs(BaseModel):
    id: str = Field(..., min_length=1, max_length=100)


class StudioListArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    kind: Optional[StudioKind] = None


class TutorTurnArgs(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200, description=SUBJECT_DESC)
    message: str = Field(..., min_length=1, max_length=4000, description="The student's message or answer.")
    topic: Optional[str] = Field(None, max_length=200, description=TOPIC_DESC)
    chat_id: Optional[str] = Field(None, max_length=100, description="Tutor chat to continue (from the last turn).")


# ---------------------------------------------------------------- runners

def run_notebook_sources(services: Any, args: NotebookSourcesArgs) -> dict[str, Any]:
    subject = services.resolve_subject(args.subject)
    items = sources.list_sources(services, subject["id"])
    return {"subject": {"id": subject["id"], "name": subject.get("name")}, "sources": items,
            "indexed": sum(1 for s in items if s["status"] == "indexed"),
            "pending": sum(1 for s in items if s["status"] == "pending")}


def _wait_sources(services: Any, ids: list[str], wait_s: float) -> None:
    deadline = time.monotonic() + wait_s
    while ids and time.monotonic() < deadline:
        found = rows(services, f"SELECT status FROM sources WHERE id IN ({','.join('?' * len(ids))})", ids)
        if all(r["status"] != "pending" for r in found):
            return
        time.sleep(0.25)


def run_source_add(services: Any, args: SourceAddArgs) -> dict[str, Any]:
    subject = services.resolve_subject(args.subject)
    try:
        result = sources.add_paths(services, subject["id"], args.path)
    except sources.SourceError as exc:
        return {"sources": [], "errors": [{"path": args.path, "error": str(exc)}]}
    ids = [s["id"] for s in result["sources"]]
    pending = [s["id"] for s in result["sources"] if s["status"] == "pending"]
    worker.submit_index(services, pending)
    if args.wait_s and pending:
        _wait_sources(services, pending, args.wait_s)
    listed = {s["id"]: s for s in sources.list_sources(services, subject["id"])}
    result["sources"] = [listed.get(i, {"id": i}) for i in ids]
    if any(s.get("status") == "pending" for s in result["sources"]):
        result["note"] = "Indexando en segundo plano; consulta notebook_sources en un momento."
    return result


def run_notebook_search(services: Any, args: NotebookSearchArgs) -> dict[str, Any]:
    subject = services.resolve_subject(args.subject)
    found = retrieval.search(services, subject["id"], args.query, topic=args.topic, source_ids=args.source_ids, k=args.k)
    out: dict[str, Any] = {"passages": [retrieval.public_passage(p) for p in found["passages"]]}
    if found["note"]:
        out["note"] = found["note"]
    return out


def run_notebook_ask(services: Any, args: NotebookAskArgs) -> dict[str, Any]:
    return ask_mod.ask(services, args.subject, args.question, topic=args.topic, source_ids=args.source_ids,
                       chat_id=args.chat_id)


def run_studio_generate(services: Any, args: StudioGenerateArgs) -> dict[str, Any]:
    res = studio.create(services, args.subject, args.kind, topic=args.topic, source_ids=args.source_ids,
                        instructions=args.instructions, add_as_source=args.add_as_source)
    item = res.get("item")
    if not item:
        return res
    if args.wait_s:
        item = studio.wait(services, item["id"], args.wait_s) or item
    out: dict[str, Any] = {"item": item}
    if item["status"] in ("queued", "running"):
        out["note"] = f"Sigue generándose; consulta studio_get con id {item['id']}."
    return out


def run_studio_get(services: Any, args: StudioGetArgs) -> dict[str, Any]:
    item = studio.get_item(services, args.id)
    if not item:
        raise LookupError(f"No existe el elemento de estudio {args.id}")
    return {"item": item}


def run_studio_list(services: Any, args: StudioListArgs) -> dict[str, Any]:
    subject = services.resolve_subject(args.subject)
    return {"items": studio.list_items(services, subject["id"], args.kind)}


def run_tutor_turn(services: Any, args: TutorTurnArgs) -> dict[str, Any]:
    try:
        return tutor.turn(services, args.subject, args.message, topic=args.topic, chat_id=args.chat_id)
    except NoModel as exc:  # pragma: no cover - turn() already degrades
        return {"reply": None, "note": exc.note()}


NOTEBOOK_TOOLS: list[Tool] = [
    Tool(
        "notebook_sources",
        "List a subject's notebook sources and index status (fuentes del cuaderno, PDFs, apuntes indexados).\n"
        "Lists the documents the notebook reads for a subject (repo resources, uploads, added paths, saved studio "
        "items) with status pending/indexed/error, pages and chunk counts.\n"
        "Sinónimos: fuentes, documentos, apuntes, temas en PDF, qué material hay, cuaderno, sources.",
        NotebookSourcesArgs, ann(True), run_notebook_sources,
    ),
    Tool(
        "source_add",
        "Add a local file or folder as notebook source (write; añadir fuente, PDF, apuntes, DOCX al cuaderno).\n"
        "Registers PDF/MD/TXT/DOCX files (a folder is scanned recursively) as sources of a subject; they are read "
        "in place (never copied) and indexed in the background; `wait_s` waits for indexing. Idempotent by content.\n"
        "Sinónimos: añadir fuente, subir apuntes, indexar PDF, importar documento, add source, cargar material.",
        SourceAddArgs, ann(False, False, True), run_source_add,
    ),
    Tool(
        "notebook_search",
        "Search a subject's sources, return cited passages (buscar en apuntes/fuentes con citas, retrieval only).\n"
        "Cheap retrieval (no model): best passages with [n], filename, page and snippet. Prefer it when you can "
        "compose the answer yourself; cite with [n] and never invent sources.\n"
        "Sinónimos: buscar en el temario, buscar en los PDF, dónde dice, pasajes, fragmentos, search notes.",
        NotebookSearchArgs, ann(True), run_notebook_search,
    ),
    Tool(
        "notebook_ask",
        "Answer a question from the subject's sources with [n] citations (preguntar a los apuntes, chat con fuentes).\n"
        "Grounded Q&A with a local model: answers only from retrieved passages, cites [n] and says when sources do "
        "not cover it; persisted as a notebook chat (chat_id to continue). Without a model returns `answer: null`, "
        "`passages` and a `note`: compose the answer yourself from them, citing [n].\n"
        "Sinónimos: pregunta sobre el tema, qué dicen los apuntes, explícame según el temario, ask sources.",
        NotebookAskArgs, ann(False, False, False), run_notebook_ask,
    ),
    Tool(
        "studio_generate",
        "Generate study guide, briefing, FAQ, glossary, timeline, mind map or podcast (write; guía, resumen, audio).\n"
        "Runs a background job over the subject's (or topic's) sources with citations; `wait_s` (≤120) waits for it, "
        "else poll studio_get. podcast = two-voice Spanish audio (script kept if no TTS). Without a model returns "
        "`item: null`, `material` and a `note`: write it yourself citing [n].\n"
        "Sinónimos: guía de estudio, documento informativo, preguntas frecuentes, glosario, cronología, mapa mental, "
        "pódcast, resumen en audio, esquema.",
        StudioGenerateArgs, ann(False, False, False), run_studio_generate,
    ),
    Tool(
        "studio_get",
        "Get a studio item (guide, FAQ, glossary, mind map, podcast) with status and content (ver resultado).\n"
        "Returns status queued/running/done/error, markdown content, structured data, citations and the audio URL "
        "for podcasts.\n"
        "Sinónimos: ver guía, resultado del estudio, estado del trabajo, abrir mapa mental, escuchar pódcast.",
        StudioGetArgs, ann(True), run_studio_get,
    ),
    Tool(
        "studio_list",
        "List generated studio items of a subject (listar guías, glosarios, mapas mentales, pódcasts generados).\n"
        "Newest first, without content (use studio_get for one).\n"
        "Sinónimos: materiales generados, mis guías, estudio, historial del cuaderno, studio items.",
        StudioListArgs, ann(True), run_studio_list,
    ),
    Tool(
        "tutor_turn",
        "One Socratic tutor turn on a subject/topic using weak questions and sources (tutor socrático, repaso guiado).\n"
        "Asks one question at a time, never gives the full answer first, evaluates the student's reply, and after 3 "
        "failed attempts on the same point explains with [n] citations. Pass the returned chat_id to continue. "
        "Without a model returns `reply: null`, `passages`, `weak` and a `note`: tutor yourself with the same rules.\n"
        "Sinónimos: tutor, profesor particular, pregúntame, hazme preguntas, repasar conmigo, método socrático.",
        TutorTurnArgs, ann(False, False, False), run_tutor_turn,
    ),
]
