"""Teacher tools for the assistant (Faustus / MCP): classes, exam generation, rubrics,
batch correction, grades and class analysis. Student data stays local: these tools
only read and write the teacher store and the user's own bank."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field

from .. import bank
from ..hashing import slugify
from ..hoard_link import atomic
from ..tooling import Tool, ann
from . import analysis, assess, core, generate, jobs, rubrics
from .pdf import exam_pdf
from .store import new_id, teacher_store

QType = Literal["TEST", "DESARROLLO", "COMPLETAR", "PRACTICO"]
SYN = "\nSinónimos: "
EXAM_DESC = "Teacher exam: id or title (prefix ok)."
BATCH_DESC = "Grading batch id, or the exam (id/title): its newest batch."
CLASS_DESC = "Class: id, name or course ('2ºB', '2B')."


class Empty(BaseModel):
    pass


class ClassesArgs(BaseModel):
    cls: Optional[str] = Field(None, alias="class", max_length=200, description=CLASS_DESC + " Omit to list all.")

    model_config = {"populate_by_name": True}


class ClassCreateArgs(BaseModel):
    name: str = Field(..., min_length=1, max_length=120, description="Group name, e.g. '2º B'.")
    course: Optional[str] = Field(None, max_length=120, description="Course/level, e.g. '2º Bachillerato'.")
    year: Optional[str] = Field(None, max_length=20, description="Academic year, e.g. '2026-2027'.")
    subjects: list[str] = Field(default_factory=list, max_length=20, description="Subjects taught to it (name/id).")


class StudentsAddArgs(BaseModel):
    cls: str = Field(..., alias="class", min_length=1, max_length=200, description=CLASS_DESC)
    students: list[str] = Field(default_factory=list, max_length=200, description="Display names or aliases.")
    roster: Optional[str] = Field(None, max_length=100_000,
                                  description="Pasted list or CSV (header nombre/apellidos/email/alias optional).")

    model_config = {"populate_by_name": True}


class HeaderIn(BaseModel):
    centre: Optional[str] = Field(None, max_length=200)
    course: Optional[str] = Field(None, max_length=200)
    date: Optional[str] = Field(None, max_length=40)
    instructions: Optional[str] = Field(None, max_length=4000)
    duration_min: Optional[int] = Field(None, ge=1, le=600)


class DifficultyMix(BaseModel):
    easy: float = Field(0, ge=0, le=100)
    medium: float = Field(0, ge=0, le=100)
    hard: float = Field(0, ge=0, le=100)


class ExamGenerateArgs(BaseModel):
    subject: Optional[str] = Field(None, max_length=200, description="Subject; optional when the class has one or the bank has one.")
    topics: list[str] = Field(default_factory=list, max_length=40, description="Topics (title, id or number '3'); empty = all.")
    n: Optional[int] = Field(None, ge=1, le=100, description="Total questions, split over `types` (default 2/3 TEST, 1/3 DESARROLLO).")
    types: Optional[list[QType]] = Field(None, description="Types to use with n.")
    counts: Optional[dict[QType, int]] = Field(None, description="Exact number per type, e.g. {TEST: 8, DESARROLLO: 2}.")
    difficulty: Optional[DifficultyMix] = Field(None, description="Percentages of easy/medium/hard (bank difficulty 1-2/3/4-5).")
    source: Literal["bank", "generate", "mixed"] = Field("mixed", description="bank only, model only, or bank first then model.")
    versions: int = Field(1, ge=1, le=4, description="Versions A..D: shuffled question order and options.")
    points_by_type: Optional[dict[QType, float]] = Field(None, description="Points per question by type (default 1 objective, 2 open).")
    test_penalty: float = Field(0, ge=0, le=1, description="Fraction of a TEST question's points lost per wrong answer.")
    title: Optional[str] = Field(None, max_length=200)
    header: Optional[HeaderIn] = None
    cls: Optional[str] = Field(None, alias="class", max_length=200, description=CLASS_DESC)
    wait_s: int = Field(0, ge=0, le=150, description="Seconds to wait for the generation job (at most 150).")

    model_config = {"populate_by_name": True}


class ExamRef(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    with_answers: bool = Field(True, description="Include answers and answer keys.")


class DraftsReviewArgs(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    accept: Union[Literal["all"], list[str]] = Field(default_factory=list, description="Draft ids to approve, or 'all'.")
    reject: list[str] = Field(default_factory=list, description="Draft ids to reject.")


class ExportPdfArgs(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    versions: Optional[list[str]] = Field(None, description="Labels to print (default all).")
    with_key: bool = True
    with_rubrics: bool = True


class RubricProposeArgs(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    question: str = Field(..., min_length=1, max_length=100, description="Question id or position in version A.")
    save: bool = Field(False, description="Save the proposal as the question's rubric (editable later).")


class LevelIn(BaseModel):
    id: Optional[str] = Field(None, max_length=40)
    descriptor: str = Field(..., min_length=1, max_length=600)
    points: float = Field(..., ge=0, le=1000)


class CriterionIn(BaseModel):
    id: Optional[str] = Field(None, max_length=40)
    name: str = Field(..., min_length=1, max_length=200)
    weight: float = Field(1, ge=0, le=1000)
    levels: list[LevelIn] = Field(..., min_length=2, max_length=8)


class RubricSetArgs(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    question: Optional[str] = Field(None, max_length=100, description="Question id or position; omit for an exam-wide rubric.")
    criteria: list[CriterionIn] = Field(..., min_length=1, max_length=10)
    title: Optional[str] = Field(None, max_length=200)


class BatchCreateArgs(BaseModel):
    exam: str = Field(..., min_length=1, max_length=200, description=EXAM_DESC)
    cls: str = Field(..., alias="class", min_length=1, max_length=200, description=CLASS_DESC)
    title: Optional[str] = Field(None, max_length=200)

    model_config = {"populate_by_name": True}


class SubmitAnswersArgs(BaseModel):
    batch: str = Field(..., min_length=1, max_length=200, description=BATCH_DESC)
    student: Optional[str] = Field(None, max_length=200, description="Student name/alias or submission id.")
    version: Optional[str] = Field(None, max_length=2, description="The student's version (A, B…).")
    answers: Optional[dict[str, Union[str, list[str], dict[str, str]]]] = Field(
        None, description="By printed position ('1', 'p3') or question id: TEST letters ('b', 'a,c'), COMPLETAR 'x; y', open text.")
    grid: Optional[str] = Field(None, max_length=200_000, description="CSV/TSV for many students: alumno;version;1;2;…")


class GradingRunArgs(BaseModel):
    batch: str = Field(..., min_length=1, max_length=200, description=BATCH_DESC)
    students: list[str] = Field(default_factory=list, max_length=200, description="Only these students (names/ids).")
    force: bool = Field(False, description="Grade again even unchanged answers or confirmed students.")
    wait_s: int = Field(30, ge=0, le=150)


class ReviewArgs(BaseModel):
    batch: str = Field(..., min_length=1, max_length=200, description=BATCH_DESC)
    student: Optional[str] = Field(None, max_length=200)


class ConfirmArgs(BaseModel):
    batch: str = Field(..., min_length=1, max_length=200, description=BATCH_DESC)
    student: str = Field(..., min_length=1, max_length=200, description="Student name/alias or submission id.")
    accept_proposals: Union[bool, list[str]] = Field(True, description="Accept the model's proposals (all, none, or these question ids).")
    overrides: Optional[dict[str, Union[float, str, dict[str, Any]]]] = Field(
        None, description="By position/question id: points, or {levels:{criterionId: levelId}, comment}.")
    comment: Optional[str] = Field(None, max_length=2000, description="Teacher's comment for the student.")
    confirm: bool = Field(True, description="Confirm the grade when nothing is pending.")


class ReportArgs(BaseModel):
    batch: str = Field(..., min_length=1, max_length=200, description=BATCH_DESC)
    save_csv: bool = Field(False, description="Also write the CSV under data/teacher/exports.")


class AnalysisArgs(BaseModel):
    cls: str = Field(..., alias="class", min_length=1, max_length=200, description=CLASS_DESC)
    exam: Optional[str] = Field(None, max_length=200, description="Only this exam.")
    include_unconfirmed: bool = False

    model_config = {"populate_by_name": True}


class ReinforceArgs(BaseModel):
    cls: str = Field(..., alias="class", min_length=1, max_length=200, description=CLASS_DESC)
    exam: Optional[str] = Field(None, max_length=200, description="Exam whose results drive it (default the latest).")
    student: Optional[str] = Field(None, max_length=200, description="One student; omit for the whole class.")
    n: int = Field(15, ge=1, le=100)

    model_config = {"populate_by_name": True}


class JobArgs(BaseModel):
    id: str = Field(..., min_length=1, max_length=100)
    wait_s: int = Field(0, ge=0, le=150)


# ---------------------------------------------------------------- helpers

def _exports_dir(services: Any) -> Path:
    path = Path(services.config.data_dir) / "teacher" / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _subject_for(services: Any, ref: Optional[str], klass: Optional[dict]) -> dict:
    if ref and ref.strip():
        return services.resolve_subject(ref)
    if klass and len(klass.get("subjectIds") or []) == 1:
        found = services.store.get("subject", klass["subjectIds"][0])
        if found:
            return found
    subjects = services.store.list("subject")
    if len(subjects) == 1:
        return subjects[0]
    raise ValueError("Say which subject (asignatura) the exam is for: " + ", ".join(s.get("name") or s["id"] for s in subjects))


def split_n(n: int, types: Optional[list[str]]) -> dict[str, int]:
    types = list(dict.fromkeys(types or ["TEST", "DESARROLLO"]))
    if types == ["TEST", "DESARROLLO"]:
        open_n = n // 3
        return {"TEST": n - open_n, "DESARROLLO": open_n}
    out = {t: 0 for t in types}
    for i in range(n):
        out[types[i % len(types)]] += 1
    return out


def _question_in_exam(exam: dict, ref: str) -> str:
    ids = [i["questionId"] for i in exam.get("items") or []]
    if ref in ids:
        return ref
    base = core.find_version(exam, "A")
    m = re.fullmatch(r"(?:p|q|pregunta)?\s*(\d+)", ref.strip().lower())
    if m and 1 <= int(m.group(1)) <= len(base.get("questionOrder") or []):
        return base["questionOrder"][int(m.group(1)) - 1]
    raise LookupError(f"«{ref}» is not a question of the exam (use its id or its position in version A).")


def _class_view(services: Any, klass: dict, with_students: bool) -> dict:
    store = teacher_store(services)
    names = {s["id"]: s.get("name") for s in services.store.list("subject")}
    out = {"id": klass["id"], "name": klass.get("name"), "course": klass.get("course"), "year": klass.get("year"),
           "subjects": [names.get(s, s) for s in klass.get("subjectIds") or []],
           "students": len(store.list("student", classId=klass["id"])),
           "batches": [{"id": b["id"], "title": b.get("title"), "status": b.get("status")}
                       for b in store.list("gradingBatch", classId=klass["id"])]}
    if with_students:
        out["roster"] = [{"id": s["id"], "displayName": s.get("displayName"), "email": s.get("email")}
                         for s in assess.students_of(services, klass["id"])]
    return out


# ---------------------------------------------------------------- runners

def run_classes(services: Any, args: ClassesArgs) -> dict:
    store = teacher_store(services)
    if args.cls:
        return {"class": _class_view(services, assess.find_class(services, args.cls), True)}
    classes = sorted(store.list("class"), key=lambda c: (c.get("year") or "", c.get("name") or ""))
    return {"count": len(classes), "classes": [_class_view(services, c, False) for c in classes]}


def run_class_create(services: Any, args: ClassCreateArgs) -> dict:
    subjects = [services.resolve_subject(s)["id"] for s in args.subjects]
    store = teacher_store(services)
    for c in store.list("class"):
        if slugify(c.get("name") or "") == slugify(args.name) and (c.get("year") or "") == (args.year or ""):
            return {"class": _class_view(services, c, True), "existing": True}
    klass = store.put("class", {"id": new_id(), "name": args.name.strip(), "course": (args.course or "").strip() or None,
                                "year": (args.year or "").strip() or None, "subjectIds": subjects})
    return {"class": _class_view(services, klass, True), "existing": False}


def run_students_add(services: Any, args: StudentsAddArgs) -> dict:
    klass = assess.find_class(services, args.cls)
    store = teacher_store(services)
    incoming: list[dict] = []
    skipped: list[str] = []
    if args.roster:  # first: a roster line may carry the email a bare name lacks
        parsed = core.parse_roster(args.roster)
        incoming += parsed["students"]
        skipped += parsed["skipped"]
    incoming += [{"displayName": s.strip()} for s in args.students if s.strip()]
    if not incoming:
        raise ValueError("Give students (names) or a roster to import.")
    current = assess.students_of(services, klass["id"])
    known = {core.normalize_text(s.get("displayName") or "") for s in current}
    order = max([s.get("order") or 0 for s in current] or [-1]) + 1
    added = []
    for s in incoming:
        key = core.normalize_text(s["displayName"])
        if key in known:
            skipped.append(s["displayName"])
            continue
        known.add(key)
        record = {"id": new_id(), "classId": klass["id"], "displayName": s["displayName"][:120], "order": order}
        if s.get("email"):
            record["email"] = s["email"][:200]
        store.put("student", record)
        order += 1
        added.append(record["displayName"])
    return {"class": klass.get("name"), "added": added, "skipped": skipped,
            "students": len(store.list("student", classId=klass["id"]))}


def run_exam_generate(services: Any, args: ExamGenerateArgs) -> dict:
    klass = assess.find_class(services, args.cls) if args.cls else None
    subject = _subject_for(services, args.subject, klass)
    topic_ids = [services.resolve_topic(subject["id"], t)["id"] for t in args.topics]
    if args.counts:
        counts = {k: int(v) for k, v in args.counts.items()}
    elif args.n:
        counts = split_n(args.n, args.types)
    else:
        raise ValueError("Give n (number of questions) or counts per type.")
    header = None
    if args.header:
        h = args.header
        header = {"centre": h.centre or "", "course": h.course or "", "date": h.date or "",
                  "instructions": h.instructions or "", "durationMin": h.duration_min}
    spec = {"subjectId": subject["id"], "topicIds": topic_ids, "counts": counts, "source": args.source,
            "versions": args.versions, "testPenalty": args.test_penalty,
            "difficulty": args.difficulty.model_dump() if args.difficulty and sum(args.difficulty.model_dump().values()) else None}
    if args.points_by_type:
        spec["pointsByType"] = {k: float(v) for k, v in args.points_by_type.items()}
    res = generate.create_exam(services, spec, title=args.title, header=header, class_id=klass["id"] if klass else None)
    job = res["job"]
    if job and args.wait_s:
        job = jobs.wait(services, job["id"], args.wait_s) or job
    exam = teacher_store(services).get("teacherExam", res["exam"]["id"]) or res["exam"]
    out = {"exam": generate.exam_view(services, exam), "job": job, "shortfall": res["shortfall"]}
    notes = list(exam.get("notes") or [])
    if job and job["status"] in jobs.ACTIVE:
        notes.append(f"Generating questions in the background: teacher_job {job['id']}, then exam_get to review drafts.")
    if job and job["status"] == "done" and exam.get("drafts"):
        notes.append("Generated questions are DRAFTS: show them with their citations and approve with exam_drafts_review.")
    if job and job.get("note"):
        notes.append(job["note"])
    out["notes"] = notes
    return out


def run_exam_get(services: Any, args: ExamRef) -> dict:
    exam = generate.find_exam(services, args.exam)
    out = {"exam": generate.exam_view(services, exam, args.with_answers)}
    if exam.get("jobId"):
        out["job"] = jobs.get(services, exam["jobId"])
    store = teacher_store(services)
    out["rubrics"] = [{"id": r["id"], "questionId": r.get("questionId"), "title": r.get("title"),
                       "criteria": len(r.get("criteria") or [])} for r in store.list("rubric", examId=exam["id"])]
    out["batches"] = [{"id": b["id"], "title": b.get("title"), "status": b.get("status")}
                      for b in store.list("gradingBatch", examId=exam["id"])]
    return out


def run_drafts_review(services: Any, args: DraftsReviewArgs) -> dict:
    exam = generate.find_exam(services, args.exam)
    accept = [d["id"] for d in exam.get("drafts") or [] if d.get("status") == "pending"] if args.accept == "all" else args.accept
    res = generate.review_drafts(services, exam["id"], accept, args.reject)
    return {"exam": generate.exam_view(services, res["exam"], False), "added": res["added"],
            "alreadyInBank": res["existing"], "rejected": res["rejected"],
            "invalid": res["invalid"]}  # TEST drafts whose options are broken: rejected, never in the bank


def run_export_pdf(services: Any, args: ExportPdfArgs) -> dict:
    exam = generate.find_exam(services, args.exam)
    if not exam.get("items"):
        raise ValueError("The exam has no questions yet.")
    questions = generate.questions_by_id(services, [i["questionId"] for i in exam["items"]])
    subject = services.store.get("subject", exam["subjectId"]) or {}
    rubs = {r["id"]: r for r in teacher_store(services).list("rubric", examId=exam["id"])}
    data = exam_pdf(exam, questions, subject.get("name") or "", rubs, versions=args.versions, with_key=args.with_key,
                    with_rubrics=args.with_rubrics)
    name = f"{slugify(exam.get('title') or 'examen')[:60] or 'examen'}-{exam['id'][:8]}.pdf"
    path = _exports_dir(services) / name
    atomic.write_bytes_atomic(path, data)
    return {"path": str(path), "url": f"/api/teacher/files/{name}", "bytes": len(data),
            "versions": args.versions or [v["label"] for v in exam.get("versions") or []],
            "note": "Formulas appear as LaTeX source in this PDF; the app's 'Imprimir PDF' renders them."}


def run_rubric_propose(services: Any, args: RubricProposeArgs) -> dict:
    exam = generate.find_exam(services, args.exam)
    qid = _question_in_exam(exam, args.question)
    question = services.store.get("question", qid)
    if question is None:
        raise LookupError("The question is no longer in the bank.")
    points = float(next(i for i in exam["items"] if i["questionId"] == qid).get("points") or 0)
    res = rubrics.propose(services, question, points)
    out = {"questionId": qid, **res}
    if args.save:
        out["saved"] = rubrics.save(services, exam, res["rubric"], question_id=qid)
    return out


def run_rubric_set(services: Any, args: RubricSetArgs) -> dict:
    exam = generate.find_exam(services, args.exam)
    qid = _question_in_exam(exam, args.question) if args.question else None
    rubric = {"criteria": [c.model_dump(exclude_none=True) for c in args.criteria], "origin": "manual"}
    return {"rubric": rubrics.save(services, exam, rubric, question_id=qid, title=args.title)}


def run_batch_create(services: Any, args: BatchCreateArgs) -> dict:
    exam = generate.find_exam(services, args.exam)
    klass = assess.find_class(services, args.cls)
    if not exam.get("items"):
        raise ValueError("The exam has no questions yet.")
    res = assess.create_batch(services, exam, klass, args.title)
    return {**res, "note": "Versions are assigned alternately by roster order; change them with grading_submit_answers."}


def run_submit_answers(services: Any, args: SubmitAnswersArgs) -> dict:
    batch = assess.find_batch(services, args.batch)
    if args.grid:
        return {"batchId": batch["id"], **assess.import_grid(services, batch, args.grid)}
    if not args.student:
        raise ValueError("Give the student (or a grid for many students).")
    sub = assess.submission_of(services, batch, args.student)
    res = assess.set_answers(services, batch, sub, args.answers or {}, args.version)
    return {"batchId": batch["id"], "submissionId": res["submission"]["id"], "version": res["submission"].get("version"),
            "answers": len(res["submission"].get("answers") or {}), "unknown": res["unknown"]}


def run_grading_run(services: Any, args: GradingRunArgs) -> dict:
    batch = assess.find_batch(services, args.batch)
    student_ids = []
    for ref in args.students:
        student_ids.append(assess.submission_of(services, batch, ref)["studentId"])
    job = jobs.create(services, "grading_run", {"batchId": batch["id"], "studentIds": student_ids, "force": args.force})
    if args.wait_s:
        job = jobs.wait(services, job["id"], args.wait_s) or job
    out = {"batchId": batch["id"], "job": job}
    if job["status"] in jobs.ACTIVE:
        out["note"] = f"Grading in the background: teacher_job {job['id']}, then grading_review."
    else:
        out["note"] = ("Proposals only: nothing is final. Show grading_review to the teacher and confirm with "
                       "grading_confirm what they accept.") + (f" {job['note']}" if job.get("note") else "")
    return out


def run_review(services: Any, args: ReviewArgs) -> dict:
    return assess.review(services, assess.find_batch(services, args.batch), args.student)


def run_confirm(services: Any, args: ConfirmArgs) -> dict:
    batch = assess.find_batch(services, args.batch)
    res = assess.confirm(services, batch, args.student, accept_proposals=args.accept_proposals,
                         overrides=args.overrides, comment=args.comment, finalize=args.confirm)
    sub = res["submission"]
    return {"submissionId": sub["id"], "confirmed": res["confirmed"], "result": res["result"],
            "pending": res["pending"], "feedback": sub.get("feedback")}


def run_report(services: Any, args: ReportArgs) -> dict:
    batch = assess.find_batch(services, args.batch)
    out = assess.report(services, batch)
    if args.save_csv:
        name = f"notas-{slugify(batch.get('title') or 'entrega')[:60]}-{batch['id'][:8]}.csv"
        path = _exports_dir(services) / name
        atomic.write_text_atomic(path, out["csv"], encoding="utf-8-sig")
        out["path"] = str(path)
        out["url"] = f"/api/teacher/files/{name}"
    return out


def run_analysis(services: Any, args: AnalysisArgs) -> dict:
    return analysis.class_analysis(services, args.cls, args.exam, args.include_unconfirmed)


def run_reinforce(services: Any, args: ReinforceArgs) -> dict:
    klass = assess.find_class(services, args.cls)
    store = teacher_store(services)
    batches = store.list("gradingBatch", classId=klass["id"])
    if args.exam:
        exam = generate.find_exam(services, args.exam)
        batches = [b for b in batches if b["examId"] == exam["id"]]
    if not batches:
        raise LookupError("This class has no grading batch to learn from yet.")
    batch = max(batches, key=lambda b: b.get("createdAt") or "")
    return analysis.reinforce(services, batch, args.student, args.n)


def run_job(services: Any, args: JobArgs) -> dict:
    job = jobs.wait(services, args.id, args.wait_s) if args.wait_s else jobs.get(services, args.id)
    if job is None:
        raise LookupError(f"No teacher job {args.id}.")
    return {"job": job}


TEACHER_TOOLS: list[Tool] = [
    Tool("teacher_classes", "Teacher: list classes (grupos) with students and grading batches. Keywords: clases, alumnos."
         "\nWith class: one class and its roster. Student data is local to this PC."
         + SYN + "mis clases, grupos, lista de alumnos, quién está en 2ºB.", ClassesArgs, ann(True), run_classes),
    Tool("teacher_class_create", "Teacher: create a class (group) with course, year and subjects (write). Keywords: crear clase."
         "\nIdempotent on name + year." + SYN + "crear clase, nuevo grupo, añadir grupo.", ClassCreateArgs,
         ann(False, False, True), run_class_create),
    Tool("teacher_students_add", "Teacher: add students to a class by name or a pasted roster/CSV (write). Keywords: alumnos."
         "\nOnly a display name or alias and an optional email; duplicates are skipped."
         + SYN + "añadir alumnos, importar lista de clase, matricular.", StudentsAddArgs, ann(False, False, True),
         run_students_add),
    Tool("exam_generate", "Teacher: build an exam from the bank and/or the model with citations, versions A/B (write). Keywords: examen."
         "\nsource mixed (default) takes bank questions first and drafts the rest from the subject's indexed sources "
         "in a background job; drafts carry their passage (file, page) and need exam_drafts_review. Saves a practice "
         "copy as an Exam too." + SYN + "hazme un examen, generar examen, examen del tema 3, dos versiones, modelo A y B.",
         ExamGenerateArgs, ann(False, False, False), run_exam_generate),
    Tool("exam_get", "Teacher: an exam with its questions, points, versions, answer keys and drafts. Keywords: ver examen."
         "\nAlso its rubrics, batches and generation job." + SYN + "ver examen, solucionario, plantilla de respuestas.",
         ExamRef, ann(True), run_exam_get),
    Tool("exam_drafts_review", "Teacher: approve generated question drafts into the bank and the exam, or reject (write). Keywords: aprobar."
         "\naccept 'all' or ids; approved drafts get a 'Fuente: file, p. N' line and the 'profesor' tag."
         + SYN + "aprobar preguntas, aceptar borradores, descartar preguntas generadas.", DraftsReviewArgs,
         ann(False, False, True), run_drafts_review),
    Tool("exam_export_pdf", "Teacher: printable PDF of an exam: each version, answer key and rubrics. Keywords: imprimir examen."
         "\nWritten under data/teacher/exports and served at the returned url." + SYN + "imprimir examen, pdf del examen, exportar examen.",
         ExportPdfArgs, ann(False, False, True), run_export_pdf),
    Tool("rubric_propose", "Teacher: draft a rubric for an open question with the local model (template if none). Keywords: rúbrica."
         "\nReturns the draft; save=true stores it. Always editable with rubric_set."
         + SYN + "proponer rúbrica, criterios de corrección, hazme una rúbrica.", RubricProposeArgs,
         ann(False, False, False), run_rubric_propose),
    Tool("rubric_set", "Teacher: save a rubric (criteria, weights, level points) for a question or the exam (write). Keywords: rúbrica"
         "\nReplaces the question's (or exam-wide) rubric." + SYN + "guardar rúbrica, editar rúbrica, criterios.",
         RubricSetArgs, ann(False, False, True), run_rubric_set),
    Tool("grading_batch_create", "Teacher: start correcting an exam for a class: one submission per student (write). Keywords: entregas."
         "\nVersions alternate by roster order." + SYN + "corregir examen de la clase, nuevas entregas, recoger exámenes.",
         BatchCreateArgs, ann(False, False, False), run_batch_create),
    Tool("grading_submit_answers", "Teacher: enter a student's answers or a CSV grid of many students (write). Keywords: respuestas."
         "\nBy printed position of the student's version: TEST letters, COMPLETAR 'x; y', open text."
         + SYN + "meter respuestas, pasar notas del test, plantilla de respuestas de los alumnos.", SubmitAnswersArgs,
         ann(False, False, True), run_submit_answers),
    Tool("grading_run", "Teacher: grade open answers against the rubric with the local model, as a job (write). Keywords: corregir."
         "\nProposals per criterion with justification, verified literal quotes and confidence; nothing final until "
         "grading_confirm. no_model status when no model." + SYN + "corrige las entregas, corregir con la rúbrica, evaluar respuestas.",
         GradingRunArgs, ann(False, False, False), run_grading_run),
    Tool("grading_review", "Teacher: per student and question: answer, auto score, model proposal, decision. Keywords: revisar."
         "\nThe side-by-side view of the app as data." + SYN + "revisar corrección, ver propuestas, cómo lo ha hecho cada alumno.",
         ReviewArgs, ann(True), run_review),
    Tool("grading_confirm", "Teacher: accept proposals or override points and confirm a student's grade (write). Keywords: confirmar nota."
         "\nOnly on the teacher's say-so. Confirmed: grade 0-10, band and feedback (strengths, mistakes, topics to review)."
         + SYN + "confirmar nota, poner nota, aceptar corrección, cambiar la nota de.", ConfirmArgs,
         ann(False, False, True), run_confirm),
    Tool("grades_report", "Teacher: the grades of a batch (points, grade, band) and a CSV. Keywords: notas, calificaciones."
         "\nsave_csv writes it under data/teacher/exports." + SYN + "notas de la clase, acta, exportar notas, calificaciones.",
         ReportArgs, ann(True), run_report),
    Tool("class_analysis", "Teacher: how a class did: success per question and topic, common mistakes, grades. Keywords: análisis."
         "\nworstTopic answers 'qué tema ha ido peor'. Only confirmed grades unless include_unconfirmed."
         + SYN + "qué tema ha ido peor, análisis de la clase, distribución de notas, fallos más comunes.", AnalysisArgs,
         ann(True), run_analysis),
    Tool("class_reinforce", "Teacher: practice set from the weak topics, for the class or one student (write). Keywords: refuerzo."
         "\nSaved as an Exam (practice, flashcards, SM-2); its name never includes the student."
         + SYN + "reforzar, repaso de los temas flojos, ejercicios de refuerzo.", ReinforceArgs,
         ann(False, False, False), run_reinforce),
    Tool("teacher_job", "Teacher: status of a background job (exam generation or grading). Keywords: progreso."
         "\nstatus queued, running, done, no_model, no_sources or error, with progress and result."
         + SYN + "cómo va la corrección, ha terminado, progreso.", JobArgs, ann(True), run_job),
]
