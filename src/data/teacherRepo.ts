/**
 * teacherRepo.ts — persistencia del rol Profesor en IndexedDB (Dexie v9).
 *
 * Cada escritura sella `updatedAt`, apunta el registro en la cola de pendientes
 * (localStorage) y avisa a la UI (`hypatia-teacher-changed`). En modo Hypatia,
 * teacherSync.ts sube esos pendientes al servidor local y trae lo que cambiaron
 * allí las herramientas de Faustus o los trabajos de corrección.
 */

import { v4 as uuidv4 } from 'uuid';
import type Dexie from 'dexie';
import { db } from './db';
import type {
  GradeScale, GradingBatch, GradingProposal, Rubric, Submission, TeacherClass, TeacherExam, TeacherKind,
  TeacherSettings, TeacherStudent,
} from '@/domain/teacher';
import { DEFAULT_SCALE, normalizeScale, matchStudent } from '@/domain/teacherCore';
import { normalizeText } from '@/domain/normalize';
import {
  TEACHER_DELETES_KEY, TEACHER_KIND_TABLE, TEACHER_PENDING_KEY, addDelete, parseDeletes, parseList, pendingKey,
} from './teacherSyncCore';

export const TEACHER_CHANGED = 'hypatia-teacher-changed';

const now = () => new Date().toISOString();

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* modo privado / cuota */ }
}

export function readPending(): string[] { return parseList(lsGet(TEACHER_PENDING_KEY)); }
export function writePending(list: string[]): void { lsSet(TEACHER_PENDING_KEY, JSON.stringify([...new Set(list)])); }
export function readDeletes() { return parseDeletes(lsGet(TEACHER_DELETES_KEY)); }
export function writeDeletes(list: ReturnType<typeof readDeletes>): void { lsSet(TEACHER_DELETES_KEY, JSON.stringify(list)); }

let scheduler: (() => void) | null = null;
/** teacherSync.ts registra aquí su «sincroniza pronto» (solo en modo Hypatia). */
export function setTeacherSyncScheduler(fn: (() => void) | null): void { scheduler = fn; }

export function notifyTeacherChanged(): void {
  try { window.dispatchEvent(new CustomEvent(TEACHER_CHANGED)); } catch { /* sin DOM (tests) */ }
}

function changed(): void {
  notifyTeacherChanged();
  scheduler?.();
}

export function tableOf(kind: TeacherKind): Dexie.Table<{ id: string; updatedAt?: string }, string> {
  return (db as unknown as Record<string, Dexie.Table<{ id: string; updatedAt?: string }, string>>)[TEACHER_KIND_TABLE[kind]];
}

/** Guarda un registro: sella fechas, lo marca como pendiente de subir y avisa. */
export async function putRecord<T extends { id: string }>(kind: TeacherKind, obj: T): Promise<T & { createdAt: string; updatedAt: string }> {
  const stamp = now();
  const prev = obj as unknown as { createdAt?: string };
  const record = { ...obj, createdAt: prev.createdAt || stamp, updatedAt: stamp };
  await tableOf(kind).put(record);
  writePending([...readPending(), pendingKey(kind, obj.id)]);
  changed();
  return record;
}

/** Borra un registro y deja el borrado en cola para el servidor. */
export async function deleteRecord(kind: TeacherKind, id: string, notify = true): Promise<void> {
  await tableOf(kind).delete(id);
  writePending(readPending().filter((k) => k !== pendingKey(kind, id)));
  writeDeletes(addDelete(readDeletes(), { kind, id, deletedAt: now() }));
  if (notify) changed();
}

// ─── Clases y alumnos ────────────────────────────────────────────────────────

export const classRepo = {
  async list(): Promise<TeacherClass[]> {
    const all = await db.teacherClasses.toArray();
    return all.sort((a, b) => (a.year ?? '').localeCompare(b.year ?? '') || a.name.localeCompare(b.name, 'es'));
  },
  get: (id: string) => db.teacherClasses.get(id),
  async create(data: Pick<TeacherClass, 'name' | 'course' | 'year' | 'subjectIds'>): Promise<TeacherClass> {
    return putRecord('class', { id: uuidv4(), ...data } as TeacherClass);
  },
  async update(id: string, patch: Partial<TeacherClass>): Promise<void> {
    const current = await db.teacherClasses.get(id);
    if (current) await putRecord('class', { ...current, ...patch, id });
  },
  /** Borra la clase con sus alumnos y sus entregas. */
  async delete(id: string): Promise<void> {
    for (const s of await db.teacherStudents.where('classId').equals(id).toArray()) await deleteRecord('student', s.id, false);
    for (const b of await db.gradingBatches.where('classId').equals(id).toArray()) await batchRepo.delete(b.id, false);
    await deleteRecord('class', id);
  },
};

export const studentRepo = {
  async byClass(classId: string): Promise<TeacherStudent[]> {
    const all = await db.teacherStudents.where('classId').equals(classId).toArray();
    return all.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.displayName.localeCompare(b.displayName, 'es'));
  },
  /** Añade alumnos (nombre visible o alias, email opcional); omite los repetidos. */
  async addMany(classId: string, entries: { displayName: string; email?: string }[]): Promise<{ added: string[]; skipped: string[] }> {
    const current = await this.byClass(classId);
    const known = new Set(current.map((s) => normalizeText(s.displayName)));
    let order = Math.max(-1, ...current.map((s) => s.order ?? 0)) + 1;
    const added: string[] = [];
    const skipped: string[] = [];
    for (const e of entries) {
      const name = e.displayName.replace(/\s+/g, ' ').trim().slice(0, 120);
      const key = normalizeText(name);
      if (!name || known.has(key)) { if (name) skipped.push(name); continue; }
      known.add(key);
      const student = { id: uuidv4(), classId, displayName: name, order: order++ } as TeacherStudent;
      if (e.email?.includes('@')) student.email = e.email.trim().slice(0, 200);
      await putRecord('student', student);
      added.push(name);
    }
    return { added, skipped };
  },
  async update(id: string, patch: Partial<TeacherStudent>): Promise<void> {
    const current = await db.teacherStudents.get(id);
    if (current) await putRecord('student', { ...current, ...patch, id });
  },
  delete: (id: string) => deleteRecord('student', id),
};

// ─── Exámenes, rúbricas ──────────────────────────────────────────────────────

export const teacherExamRepo = {
  async list(): Promise<TeacherExam[]> {
    const all = await db.teacherExams.toArray();
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  get: (id: string) => db.teacherExams.get(id),
  save: (exam: TeacherExam) => putRecord('teacherExam', exam),
  /** Borra el examen del profesor con sus rúbricas y entregas (la copia practicable se queda). */
  async delete(id: string): Promise<void> {
    for (const r of await db.rubrics.where('examId').equals(id).toArray()) await deleteRecord('rubric', r.id, false);
    for (const b of await db.gradingBatches.where('examId').equals(id).toArray()) await batchRepo.delete(b.id, false);
    await deleteRecord('teacherExam', id);
  },
};

export const rubricRepo = {
  byExam: (examId: string) => db.rubrics.where('examId').equals(examId).toArray(),
  get: (id: string) => db.rubrics.get(id),
  /** La rúbrica de la pregunta, o la del examen entero. */
  async forQuestion(exam: TeacherExam, questionId: string): Promise<Rubric | undefined> {
    const item = exam.items.find((i) => i.questionId === questionId);
    if (item?.rubricId) {
      const own = await db.rubrics.get(item.rubricId);
      if (own) return own;
    }
    const all = await db.rubrics.where('examId').equals(exam.id).toArray();
    return all.find((r) => r.questionId === questionId) ?? all.find((r) => !r.questionId);
  },
  /** Guarda (o sustituye) la rúbrica de una pregunta o del examen y la enlaza desde el ítem. */
  async save(exam: TeacherExam, data: Pick<Rubric, 'criteria' | 'title' | 'origin'>, questionId: string | null): Promise<Rubric> {
    const existing = (await db.rubrics.where('examId').equals(exam.id).toArray()).find((r) => (r.questionId ?? null) === questionId);
    const rubric = await putRecord('rubric', {
      ...(existing ?? {}), id: existing?.id ?? uuidv4(), subjectId: exam.subjectId, examId: exam.id, questionId,
      scope: questionId ? 'question' : 'exam', title: data.title, criteria: data.criteria, origin: data.origin,
    } as Rubric);
    if (questionId) {
      const fresh = (await db.teacherExams.get(exam.id)) ?? exam;
      await putRecord('teacherExam', { ...fresh, items: fresh.items.map((i) => (i.questionId === questionId ? { ...i, rubricId: rubric.id } : i)) });
    }
    return rubric;
  },
  delete: (id: string) => deleteRecord('rubric', id),
};

// ─── Entregas ────────────────────────────────────────────────────────────────

export const batchRepo = {
  async list(): Promise<GradingBatch[]> {
    return (await db.gradingBatches.toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  get: (id: string) => db.gradingBatches.get(id),
  /** Una entrega por alumno; versiones alternas por orden de lista. */
  async create(exam: TeacherExam, klass: TeacherClass, title?: string): Promise<GradingBatch> {
    const batch = await putRecord('gradingBatch', {
      id: uuidv4(), examId: exam.id, classId: klass.id, title: title || `${exam.title} · ${klass.name}`, status: 'open',
    } as GradingBatch);
    const labels = exam.versions.length ? exam.versions.map((v) => v.label) : ['A'];
    const students = await studentRepo.byClass(klass.id);
    for (let i = 0; i < students.length; i++) {
      await putRecord('submission', {
        id: uuidv4(), batchId: batch.id, studentId: students[i].id, version: labels[i % labels.length],
        answers: {}, decisions: {}, confirmed: false,
      } as unknown as Submission);
    }
    return batch;
  },
  /** Añade entregas para alumnos que entraron en la clase después de crear el lote. */
  async addMissingStudents(batch: GradingBatch, exam: TeacherExam): Promise<number> {
    const subs = await submissionRepo.byBatch(batch.id);
    const have = new Set(subs.map((s) => s.studentId));
    const labels = exam.versions.length ? exam.versions.map((v) => v.label) : ['A'];
    let n = 0;
    for (const st of await studentRepo.byClass(batch.classId)) {
      if (have.has(st.id)) continue;
      await putRecord('submission', {
        id: uuidv4(), batchId: batch.id, studentId: st.id, version: labels[(subs.length + n) % labels.length],
        answers: {}, decisions: {}, confirmed: false,
      } as unknown as Submission);
      n++;
    }
    return n;
  },
  save: (batch: GradingBatch) => putRecord('gradingBatch', batch),
  async delete(id: string, notify = true): Promise<void> {
    for (const s of await db.submissions.where('batchId').equals(id).toArray()) await deleteRecord('submission', s.id, false);
    for (const p of await db.gradingProposals.where('batchId').equals(id).toArray()) await deleteRecord('proposal', p.id, false);
    await deleteRecord('gradingBatch', id, notify);
  },
};

export const submissionRepo = {
  byBatch: (batchId: string) => db.submissions.where('batchId').equals(batchId).toArray(),
  get: (id: string) => db.submissions.get(id),
  save: (s: Submission) => putRecord('submission', s),
};

export const proposalRepo = {
  byBatch: (batchId: string) => db.gradingProposals.where('batchId').equals(batchId).toArray(),
  idFor: (submissionId: string, questionId: string) => `${submissionId}::${questionId}`,
  get: (submissionId: string, questionId: string) => db.gradingProposals.get(`${submissionId}::${questionId}`),
};

export const teacherSettingsRepo = {
  async getScale(): Promise<GradeScale> {
    const row = await db.teacherSettings.get('default');
    return normalizeScale(row?.scale ?? DEFAULT_SCALE);
  },
  async saveScale(scale: GradeScale): Promise<void> {
    const row = await db.teacherSettings.get('default');
    await putRecord('teacherSettings', { ...(row ?? {}), id: 'default', scale: normalizeScale(scale) } as TeacherSettings);
  },
};

/** Alumno de la clase para un nombre de una rejilla/CSV. */
export { matchStudent };
