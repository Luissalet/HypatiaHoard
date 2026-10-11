/**
 * lessonsClient.ts
 *
 * Client for the guided lessons of the local Hypatia's Hoard server ("enséñame este documento"):
 * POST /api/study/lessons, /lessons/get, /lessons/mastery, /lessons/delete plus the grading
 * routes /api/study/grade and /api/study/review. Hoard mode only (hoardJson refuses otherwise).
 */

import { hoardJson } from './hoardClient';

export type LessonLevel = 'sin ver' | 'débil' | 'en progreso' | 'dominado';
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

export interface LessonSection {
  n: number;
  title: string;
  chars: number;
  concepts: string[];
  /** Only in a preview (save = false). */
  text?: string;
}

export interface LessonConcept {
  id: string;
  name: string;
  summary: string;
  section: number;
  questionIds?: string[];
  /** Only in a preview: the drafted question. */
  question?: { type: string; prompt: string };
}

export interface Lesson {
  id: string;
  title: string;
  source: string;
  language: string;
  model: string | null;
  sections: LessonSection[];
  concepts: LessonConcept[];
  pageCardId?: string | null;
}

export interface CreateLessonResult {
  saved: boolean;
  existing: boolean;
  preview?: boolean;
  note: string | null;
  lesson: Lesson;
}

export interface LessonRow {
  id: string;
  title: string;
  source: string;
  sections: number;
  concepts: number;
  mastery: number;
  levels: Record<LessonLevel, number>;
}

export interface LessonQuestion {
  id: string;
  type: string;
  prompt: string;
  options?: { id: string; text: string }[];
  correctOptionIds?: string[];
  modelAnswer?: string;
  explanation?: string;
}

export interface LessonStep {
  step: 'read' | 'question';
  section: number;
  title?: string;
  conceptId?: string;
  concept?: string;
  level?: LessonLevel;
  question?: LessonQuestion;
}

export interface LessonFlow {
  lesson: Lesson;
  mastery: number;
  flow: LessonStep[];
}

export interface LessonSectionView {
  lesson: string;
  section: { n: number; title: string; text: string };
  concepts: { id: string; name: string; summary: string; level: LessonLevel }[];
  flow: LessonStep[];
}

export interface ConceptMasteryRow {
  conceptId: string;
  concept: string;
  section: number;
  questions: number;
  attempts: number;
  accuracy: number | null;
  mastery: number;
  level: LessonLevel;
  lastResult: string | null;
  nextReviewAt: string | null;
  dueNow: boolean;
  evidence: string;
}

export interface LessonMastery {
  lessonId: string;
  lesson: string;
  mastery: number;
  levels: Record<LessonLevel, number>;
  concepts: ConceptMasteryRow[];
  weakest: string[];
}

export interface GradeResult {
  verdict: 'correct' | 'partial' | 'wrong' | null;
  feedback: string | null;
  missing?: string[];
  suggestedGrade: ReviewGrade | null;
}

const post = <T,>(path: string, body: unknown) =>
  hoardJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const listLessons = (subject: string) =>
  post<{ count: number; lessons: LessonRow[] }>('/study/lessons/get', { subject }).then((r) => r.lessons);

export const createLesson = (params: {
  subject: string; text: string; title?: string; topic?: string; save?: boolean; use_model?: boolean; as_page_card?: boolean;
}) => post<CreateLessonResult>('/study/lessons', params);

export const getLessonFlow = (lesson: string) => post<LessonFlow>('/study/lessons/get', { lesson });

export const getLessonSection = (lesson: string, section: number, withAnswers = false) =>
  post<LessonSectionView>('/study/lessons/get', { lesson, section, with_answers: withAnswers });

export const getLessonMastery = (lesson: string) => post<LessonMastery>('/study/lessons/mastery', { lesson });

export const deleteLesson = (lesson: string, deleteQuestions = false) =>
  post<{ ok: boolean }>('/study/lessons/delete', { lesson, delete_questions: deleteQuestions });

export const gradeAnswer = (id: string, answer: string | string[]) => post<GradeResult>('/study/grade', { id, answer });

export const reviewQuestion = (id: string, grade: ReviewGrade) => post<{ result: string; nextReviewAt: string | null }>('/study/review', { id, grade });
