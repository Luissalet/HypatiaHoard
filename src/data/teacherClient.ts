/**
 * teacherClient.ts — llamadas del rol Profesor al servidor local (modo Hypatia):
 * trabajos largos (generar preguntas, corregir un lote), propuesta de rúbrica y
 * transcripción de fotos. Fuera del modo Hypatia todo devuelve «no disponible».
 */

import { hoardJson } from './hoardClient';
import { isHoardMode } from './hoardMode';
import { teacherSyncNow } from './teacherSync';
import type { QuestionType } from '@/domain/models';
import type { Question } from '@/domain/models';
import type { RubricCriterion } from '@/domain/teacher';

export type JobStatus = 'queued' | 'running' | 'done' | 'no_model' | 'no_sources' | 'error' | 'cancelled';

export interface TeacherJob {
  id: string;
  kind: 'exam_generate' | 'grading_run';
  status: JobStatus;
  progress: { done?: number; total?: number; label?: string };
  result: Record<string, unknown> | null;
  error: string | null;
  note: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export const FINAL_JOB: JobStatus[] = ['done', 'no_model', 'no_sources', 'error', 'cancelled'];

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function needServer(): void {
  if (!isHoardMode()) throw new Error('Esto necesita Hypatia (el servidor local con un modelo).');
}

/** Sube lo pendiente y lanza la generación de preguntas citadas para un examen. */
export async function startGeneration(examId: string, counts: Partial<Record<QuestionType, number>>): Promise<TeacherJob> {
  needServer();
  await teacherSyncNow();
  return hoardJson<TeacherJob>('/teacher/jobs', json({ kind: 'exam_generate', params: { examId, counts } }));
}

/** Sube lo pendiente y lanza la corrección de las respuestas abiertas del lote. */
export async function startGrading(batchId: string, opts: { studentIds?: string[]; force?: boolean } = {}): Promise<TeacherJob> {
  needServer();
  await teacherSyncNow();
  return hoardJson<TeacherJob>('/teacher/jobs', json({ kind: 'grading_run', params: { batchId, ...opts } }));
}

export async function getJob(id: string): Promise<TeacherJob> {
  needServer();
  return hoardJson<TeacherJob>(`/teacher/jobs/${encodeURIComponent(id)}`);
}

/** Sondea un trabajo hasta que acaba; `onProgress` en cada vuelta. Trae los resultados al terminar. */
export async function waitJob(id: string, onProgress?: (job: TeacherJob) => void, signal?: { cancelled: boolean }): Promise<TeacherJob> {
  for (;;) {
    const job = await getJob(id);
    onProgress?.(job);
    if (FINAL_JOB.includes(job.status)) {
      await teacherSyncNow();
      return job;
    }
    if (signal?.cancelled) return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export interface RubricProposal {
  status: 'ok' | 'no_model' | 'invalid';
  rubric: { criteria: RubricCriterion[]; origin: 'llm' | 'template' };
  model: string | null;
  note: string | null;
}

export async function proposeRubric(question: Partial<Question>, points: number): Promise<RubricProposal> {
  needServer();
  return hoardJson<RubricProposal>('/teacher/rubrics/propose', json({ question, points }));
}

export interface Transcription { status: 'ok' | 'no_model' | 'error'; text: string | null; model: string | null; note: string | null }

export async function transcribeImage(file: Blob): Promise<Transcription> {
  needServer();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return hoardJson<Transcription>('/teacher/transcribe', json({ image: base64 }));
}
