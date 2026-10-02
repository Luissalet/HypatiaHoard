/**
 * teacherBatch.ts — corrección de un lote en la app: contexto (examen, preguntas,
 * alumnos, entregas, propuestas, rúbricas, escala), decisiones del profesor,
 * confirmación con nota y feedback, y la práctica de refuerzo de los temas flojos.
 * Misma lógica que hypatia/teacher/assess.py y analysis.py (vía teacherCore).
 */

import { db } from './db';
import { examRepo, keyConceptRepo, topicRepo } from './repos';
import { batchRepo, proposalRepo, rubricRepo, studentRepo, submissionRepo, teacherExamRepo, teacherSettingsRepo } from './teacherRepo';
import type { KeyConcept, Question } from '@/domain/models';
import type {
  Decision, GradeScale, GradingBatch, GradingProposal, Rubric, Submission, TeacherExam, TeacherStudent,
} from '@/domain/teacher';
import { OPEN_TYPES, analyze, feedback, itemPoints, round2, submissionResult } from '@/domain/teacherCore';

export interface BatchContext {
  batch: GradingBatch;
  exam: TeacherExam;
  questions: Record<string, Question>;
  topics: Record<string, string>;
  concepts: KeyConcept[];
  students: Record<string, TeacherStudent>;
  roster: TeacherStudent[];
  submissions: Submission[];
  proposals: Record<string, GradingProposal>;
  rubrics: Record<string, Rubric>;
  scale: GradeScale;
}

export async function loadBatchContext(batchId: string): Promise<BatchContext | null> {
  const batch = await batchRepo.get(batchId);
  if (!batch) return null;
  const exam = await teacherExamRepo.get(batch.examId);
  if (!exam) return null;
  const ids = exam.items.map((i) => i.questionId);
  const qs = ids.length ? await db.questions.where('id').anyOf(ids).toArray() : [];
  const questions: Record<string, Question> = {};
  for (const q of qs) questions[q.id] = q;
  const topics: Record<string, string> = {};
  for (const t of await topicRepo.getBySubject(exam.subjectId)) topics[t.id] = t.title;
  const roster = await studentRepo.byClass(batch.classId);
  const students: Record<string, TeacherStudent> = {};
  for (const s of roster) students[s.id] = s;
  const submissions = (await submissionRepo.byBatch(batch.id)).sort((a, b) =>
    (students[a.studentId]?.order ?? 1e9) - (students[b.studentId]?.order ?? 1e9));
  const proposals: Record<string, GradingProposal> = {};
  for (const p of await proposalRepo.byBatch(batch.id)) proposals[p.id] = p;
  const rubrics: Record<string, Rubric> = {};
  for (const r of await rubricRepo.byExam(exam.id)) rubrics[r.id] = r;
  return {
    batch, exam, questions, topics, concepts: await keyConceptRepo.getBySubject(exam.subjectId), students, roster,
    submissions, proposals, rubrics, scale: await teacherSettingsRepo.getScale(),
  };
}

export function rubricFor(ctx: BatchContext, questionId: string): Rubric | undefined {
  const item = ctx.exam.items.find((i) => i.questionId === questionId);
  if (item?.rubricId && ctx.rubrics[item.rubricId]) return ctx.rubrics[item.rubricId];
  const all = Object.values(ctx.rubrics);
  return all.find((r) => r.questionId === questionId) ?? all.find((r) => !r.questionId);
}

export function proposalFor(ctx: BatchContext, sub: Submission, questionId: string): GradingProposal | undefined {
  return ctx.proposals[`${sub.id}::${questionId}`];
}

/** Decisión a partir de la propuesta del modelo (el profesor la acepta con un clic). */
export function decisionFromProposal(p: GradingProposal): Decision | null {
  if (p.points === null || p.points === undefined) return null;
  return {
    points: p.points, rubricId: p.rubricId, source: 'proposal', comment: p.comment ?? null, at: new Date().toISOString(),
    criteria: p.criteria.map((c) => ({ criterionId: c.criterionId, levelId: c.levelId, points: c.points, maxPoints: c.maxPoints })),
  };
}

export async function setDecision(sub: Submission, questionId: string, decision: Decision | null): Promise<Submission> {
  return submissionRepo.update(sub.id, (fresh) => {
    const decisions = { ...(fresh.decisions ?? {}) };
    if (decision) decisions[questionId] = { ...decision, at: decision.at ?? new Date().toISOString() };
    else delete decisions[questionId];
    return { ...fresh, decisions, confirmed: false, result: undefined, feedback: undefined };
  });
}

/** Acepta todas las propuestas válidas de un alumno que aún no tengan decisión. */
export async function acceptAllProposals(ctx: BatchContext, sub: Submission): Promise<Submission> {
  return submissionRepo.update(sub.id, (fresh) => {
    const decisions = { ...(fresh.decisions ?? {}) };
    for (const item of ctx.exam.items) {
      const q = ctx.questions[item.questionId];
      if (!q || !OPEN_TYPES.includes(q.type) || decisions[q.id]) continue;
      const p = proposalFor(ctx, fresh, q.id);
      const d = p ? decisionFromProposal(p) : null;
      if (d) decisions[q.id] = d;
    }
    return { ...fresh, decisions };
  });
}

/** Confirma la nota si no queda nada pendiente (nota, banda y feedback quedan guardados). */
export async function confirmSubmission(ctx: BatchContext, sub: Submission, comment?: string): Promise<Submission> {
  const saved = await submissionRepo.update(sub.id, (fresh) => {
    const result = submissionResult(ctx.exam, ctx.questions, fresh, ctx.scale);
    if (!result.complete) throw new Error(`Faltan ${result.pending.length} preguntas por puntuar.`);
    const fb = feedback(ctx.exam, ctx.questions, ctx.topics, ctx.concepts, fresh, ctx.rubrics);
    return {
      ...fresh, confirmed: true, confirmedAt: new Date().toISOString(), result, feedback: fb,
      ...(comment !== undefined ? { comment } : {}),
    };
  });
  const all = await submissionRepo.byBatch(ctx.batch.id);
  if (all.length && all.every((s) => (s.id === saved.id ? true : s.confirmed))) {
    await batchRepo.save({ ...ctx.batch, status: 'closed' });
  }
  return saved;
}

export async function unconfirmSubmission(sub: Submission): Promise<Submission> {
  return submissionRepo.update(sub.id, (fresh) => ({ ...fresh, confirmed: false, result: undefined, feedback: undefined }));
}

export function batchAnalysis(ctx: BatchContext, includeUnconfirmed = false) {
  return analyze(ctx.exam, ctx.questions, ctx.topics, ctx.submissions, ctx.rubrics, ctx.scale, includeUnconfirmed);
}

/** Temas por debajo del umbral, de la clase o de un alumno. */
export function weakTopics(ctx: BatchContext, sub?: Submission, threshold = 0.6): { topicId: string; topic: string | null; success: number }[] {
  if (!sub) {
    return batchAnalysis(ctx, true).topics
      .filter((t) => t.success !== null && t.success < threshold && t.topicId)
      .map((t) => ({ topicId: t.topicId!, topic: t.topic, success: t.success! }));
  }
  const acc = new Map<string, [number, number]>();
  for (const r of itemPoints(ctx.exam, ctx.questions, sub)) {
    if (r.points === null || !r.maxPoints || !r.topicId) continue;
    const a = acc.get(r.topicId) ?? [0, 0];
    a[0] += Math.max(0, r.points);
    a[1] += r.maxPoints;
    acc.set(r.topicId, a);
  }
  return [...acc.entries()]
    .map(([topicId, [got, max]]) => ({ topicId, topic: ctx.topics[topicId] ?? null, success: round2(got / max) }))
    .filter((t) => t.success < threshold)
    .sort((a, b) => a.success - b.success || (a.topic ?? '').localeCompare(b.topic ?? ''));
}

/**
 * Práctica de refuerzo como Exam del banco (practicar, tarjetas, SM-2). Su nombre
 * nunca lleva el del alumno: viaja con los datos de estudio (sincronización, Gist).
 */
export async function createReinforcement(ctx: BatchContext, sub?: Submission, n = 15): Promise<{ examId: string | null; name?: string; weak: ReturnType<typeof weakTopics> }> {
  const weak = weakTopics(ctx, sub);
  if (!weak.length) return { examId: null, weak };
  const rank = new Map(weak.map((t, i) => [t.topicId, i]));
  const inExam = new Set(ctx.exam.items.map((i) => i.questionId));
  const pool = (await db.questions.where('subjectId').equals(ctx.exam.subjectId).toArray())
    .filter((q) => rank.has(q.topicId) || (q.topicIds ?? []).some((t) => rank.has(t)));
  pool.sort((a, b) => Number(!inExam.has(a.id)) - Number(!inExam.has(b.id))
    || (rank.get(a.topicId) ?? 99) - (rank.get(b.topicId) ?? 99) || (a.stats?.seen ?? 0) - (b.stats?.seen ?? 0) || (a.id < b.id ? -1 : 1));
  const chosen = pool.slice(0, Math.max(1, n)).map((q) => q.id);
  if (!chosen.length) return { examId: null, weak };
  const klass = await db.teacherClasses.get(ctx.batch.classId);
  const who = sub ? 'individual' : klass?.name ?? 'clase';
  const name = `Refuerzo · ${who} · ${weak.slice(0, 3).map((t) => t.topic ?? '?').join(', ')}`.slice(0, 160);
  const exam = await examRepo.create({
    subjectId: ctx.exam.subjectId, name, questionIds: chosen,
    description: `Práctica de refuerzo de ${weak.length} temas flojos tras «${ctx.exam.title}».`,
  });
  if (sub) await submissionRepo.update(sub.id, (fresh) => ({ ...fresh, reinforceExamId: exam.id }));
  return { examId: exam.id, name, weak };
}
