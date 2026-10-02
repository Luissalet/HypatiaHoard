/**
 * teacherExams.ts — construir y mantener un examen del profesor en la app.
 *
 * Mismo algoritmo que hypatia/teacher/generate.py: selección sembrada del banco por
 * tipo y dificultad, versiones A/B…, copia practicable (entidad Exam). Lo que tenga
 * que redactar el modelo lo hace el servidor como trabajo (teacherClient.startGeneration).
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { examRepo, questionRepo, topicRepo } from './repos';
import { putRecord, teacherExamRepo } from './teacherRepo';
import type { Question, QuestionType } from '@/domain/models';
import type { DifficultyMix, ExamHeader, ExamSpec, TeacherExam } from '@/domain/teacher';
import { buildVersions, round2, seededShuffle } from '@/domain/teacherCore';
import { computeContentHash } from '@/domain/hashing';
import { slugify } from '@/domain/normalize';

export const QTYPES: QuestionType[] = ['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO'];
export const DEFAULT_POINTS: Record<QuestionType, number> = { TEST: 1, COMPLETAR: 1, DESARROLLO: 2, PRACTICO: 2 };
export const TYPE_LABEL: Record<QuestionType, string> = {
  TEST: 'test', DESARROLLO: 'desarrollo', COMPLETAR: 'completar', PRACTICO: 'práctico',
};

export function difficultyBucket(q: Pick<Question, 'difficulty'>): 'easy' | 'medium' | 'hard' {
  const d = q.difficulty;
  if (typeof d === 'number') {
    if (d <= 2) return 'easy';
    if (d >= 4) return 'hard';
  }
  return 'medium';
}

function allocation(n: number, mix?: DifficultyMix | null): Record<string, number> {
  if (!mix || n <= 0) return { any: n };
  const total = ['easy', 'medium', 'hard'].reduce((s, k) => s + Math.max(0, Number(mix[k as keyof DifficultyMix] || 0)), 0) || 1;
  // Python round(): banker's rounding; Math.round differs only on exact .5 — rounding half to even keeps both equal.
  const r = (x: number) => { const f = Math.floor(x); const d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
  let easy = Math.min(r((n * Math.max(0, mix.easy || 0)) / total), n);
  const hard = Math.min(r((n * Math.max(0, mix.hard || 0)) / total), n - easy);
  easy = Math.min(easy, n);
  return { easy, medium: n - easy - hard, hard };
}

/** Preguntas por tipo y dificultad (sembrado con el id del examen); devuelve también lo que falta. */
export function selectFromBank(
  questions: Question[], topicIds: string[], counts: Partial<Record<QuestionType, number>>,
  mix: DifficultyMix | null | undefined, seed: string, exclude: Set<string> = new Set(),
): { chosen: Question[]; shortfall: Partial<Record<QuestionType, number>> } {
  let pool0 = questions;
  if (topicIds.length) {
    const wanted = new Set(topicIds);
    pool0 = pool0.filter((q) => wanted.has(q.topicId) || (q.topicIds ?? []).some((t) => wanted.has(t)));
  }
  const chosen: Question[] = [];
  const shortfall: Partial<Record<QuestionType, number>> = {};
  for (const type of QTYPES) {
    const n = Math.trunc(counts[type] ?? 0);
    if (n <= 0) continue;
    const pool = seededShuffle(
      pool0.filter((q) => q.type === type && !exclude.has(q.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      `${seed}:pick:${type}`,
    );
    const taken: Question[] = [];
    for (const [bucket, k] of Object.entries(allocation(n, mix))) {
      const cands = pool.filter((q) => !taken.includes(q) && (bucket === 'any' || difficultyBucket(q) === bucket));
      taken.push(...cands.slice(0, k));
    }
    if (taken.length < n) taken.push(...pool.filter((q) => !taken.includes(q)).slice(0, n - taken.length));
    if (taken.length < n) shortfall[type] = n - taken.length;
    chosen.push(...taken);
  }
  return { chosen, shortfall };
}

export function pointsFor(spec: Pick<ExamSpec, 'pointsByType'>, type: QuestionType): number {
  const given = spec.pointsByType?.[type];
  const v = given === undefined || given === null || !Number.isFinite(Number(given)) ? DEFAULT_POINTS[type] : Number(given);
  return round2(Math.max(0, v));
}

/** Reconstruye versiones y mantiene al día la copia practicable (Exam del banco). */
export async function refreshExam(exam: TeacherExam): Promise<TeacherExam> {
  const ids = exam.items.map((i) => i.questionId);
  const qs = ids.length ? await questionRepo.getManyByIds(ids) : [];
  const byId: Record<string, Question> = {};
  for (const q of qs) byId[q.id] = q;
  const next: TeacherExam = { ...exam, versions: buildVersions(exam.id, ids, byId, exam.spec.versions || 1) };
  if (ids.length) {
    const practice = exam.practiceExamId ? await examRepo.getById(exam.practiceExamId) : undefined;
    if (practice) {
      if (practice.questionIds.join() !== ids.join() || practice.name !== exam.title) {
        await examRepo.update(practice.id, { questionIds: ids, name: exam.title });
      }
    } else {
      const created = await examRepo.create({
        subjectId: exam.subjectId, name: exam.title, questionIds: ids,
        description: `Examen del profesor (${ids.length} preguntas).`,
      });
      next.practiceExamId = created.id;
    }
  }
  return next;
}

export interface NewExamInput {
  spec: ExamSpec;
  title?: string;
  header?: Partial<ExamHeader>;
  classId?: string | null;
}

/** Crea el examen con las preguntas del banco; devuelve lo que queda por generar con el modelo. */
export async function createTeacherExam(input: NewExamInput): Promise<{ exam: TeacherExam; toGenerate: Partial<Record<QuestionType, number>>; shortfall: Partial<Record<QuestionType, number>> }> {
  const { spec } = input;
  const id = uuidv4();
  const subject = await db.subjects.get(spec.subjectId);
  if (!subject) throw new Error('La asignatura no existe.');
  const topics = await topicRepo.getBySubject(spec.subjectId);
  const titles = new Map(topics.map((t) => [t.id, t.title]));
  const label = spec.topicIds.length ? spec.topicIds.map((t) => titles.get(t) ?? t).join(', ') : subject.name;
  const counts: Partial<Record<QuestionType, number>> = {};
  for (const t of QTYPES) counts[t] = Math.max(0, Math.trunc(spec.counts[t] ?? 0));
  const cleanSpec: ExamSpec = { ...spec, counts, versions: Math.max(1, Math.min(4, Math.trunc(spec.versions || 1))) };
  let items: TeacherExam['items'] = [];
  let shortfall: Partial<Record<QuestionType, number>> = {};
  const notes: string[] = [];
  if (spec.source === 'bank' || spec.source === 'mixed') {
    const bank = await questionRepo.getBySubject(spec.subjectId);
    const picked = selectFromBank(bank, spec.topicIds, counts, spec.difficulty, id);
    shortfall = picked.shortfall;
    items = picked.chosen.map((q) => ({ questionId: q.id, points: pointsFor(cleanSpec, q.type) }));
  }
  const toGenerate = spec.source === 'generate' ? counts : spec.source === 'mixed' ? shortfall : {};
  if (spec.source === 'bank' && Object.keys(shortfall).length) {
    notes.push('Faltan preguntas en el banco: ' + Object.entries(shortfall).map(([t, n]) => `${n} de ${TYPE_LABEL[t as QuestionType]}`).join(', ') + '.');
  }
  let exam: TeacherExam = {
    id, subjectId: spec.subjectId, title: input.title?.trim() || `Examen · ${label}`, status: 'draft',
    classId: input.classId ?? null,
    header: { centre: '', course: '', date: '', instructions: '', durationMin: null, ...(input.header ?? {}) },
    spec: cleanSpec, items, versions: [], drafts: [], notes, createdAt: '', updatedAt: '',
  };
  exam = await refreshExam(exam);
  exam = await putRecord('teacherExam', { ...exam, createdAt: undefined } as unknown as TeacherExam);
  return { exam, toGenerate, shortfall };
}

/** Guarda cambios de ítems (puntos, orden, quitar/añadir) y rehace versiones. */
export async function saveExamItems(exam: TeacherExam, items: TeacherExam['items']): Promise<TeacherExam> {
  return teacherExamRepo.save(await refreshExam({ ...exam, items }));
}

function sourceLine(cites: TeacherExam['drafts'][number]['citations']): string {
  const parts = cites.slice(0, 3).map((c) => `${c.filename ?? ''}${c.page ? `, p. ${c.page}` : ''}`);
  return parts.length ? `Fuente: ${parts.join('; ')}` : '';
}

/** Aprueba borradores (entran al banco y al examen) o los rechaza. */
export async function reviewDrafts(exam: TeacherExam, accept: string[], reject: string[]): Promise<{ exam: TeacherExam; added: number }> {
  const acceptSet = new Set(accept);
  const rejectSet = new Set(reject);
  const items = [...exam.items];
  let added = 0;
  const drafts = [];
  for (const d0 of exam.drafts) {
    const d = { ...d0 };
    if (acceptSet.has(d.id) && d.status === 'pending') {
      let topicId = d.topicId ?? null;
      if (!topicId || !(await topicRepo.getById(topicId))) {
        const topics = await topicRepo.getBySubject(exam.subjectId);
        const general = topics.find((t) => slugify(t.title) === 'general');
        topicId = general?.id ?? (await topicRepo.create({ subjectId: exam.subjectId, title: 'General', order: await topicRepo.getNextOrder(exam.subjectId) })).id;
      }
      const line = sourceLine(d.citations ?? []);
      const data = {
        ...d.question,
        subjectId: exam.subjectId, topicId: topicId!, origin: 'test' as const,
        explanation: [d.question.explanation, line].filter(Boolean).join('\n\n') || undefined,
        tags: [...new Set([...(d.question as { tags?: string[] }).tags ?? [], 'profesor'])].sort(),
      };
      const hash = await computeContentHash(data, slugify((await topicRepo.getById(topicId!))?.title ?? ''));
      const dup = (await db.questions.where('contentHash').equals(hash).toArray()).find((q) => q.subjectId === exam.subjectId);
      const q = dup ?? (await questionRepo.create(data));
      if (!dup) added++;
      d.status = 'approved';
      d.questionId = q.id;
      if (!items.some((i) => i.questionId === q.id)) items.push({ questionId: q.id, points: d.points || DEFAULT_POINTS[q.type] });
    } else if (rejectSet.has(d.id) && d.status === 'pending') {
      d.status = 'rejected';
    }
    drafts.push(d);
  }
  const saved = await teacherExamRepo.save(await refreshExam({ ...exam, items, drafts }));
  return { exam: saved, added };
}
