/**
 * planClient.ts
 *
 * Client for the study plan of the local Hypatia's Hoard server (POST /api/study/plan): every day
 * until the exam with its reviews, new cards, timed mocks and final review. Hoard mode only.
 */

import { hoardJson } from './hoardClient';

export type PlanDayKind = 'study' | 'mock' | 'final' | 'rest' | 'exam';

export interface PlanDay {
  date: string;
  weekday: string;
  inDays: number;
  kind: PlanDayKind;
  minutes: number;
  newCards: number;
  reviews: number;
  topics: string[];
  tasks: string[];
  overload?: boolean;
}

export interface PlanSettings {
  examDate: string;
  minutesPerDay: number;
  restDays: number[];
  mockQuestions: number;
  mockMinutes: number;
}

export interface StudyPlan {
  subject: { id: string; name: string };
  settings: PlanSettings;
  saved: boolean;
  today: string;
  daysLeft: number;
  studyDays: number;
  totals: { questions: number; seen: number; unseen: number; dueNow: number; seenPct: number; mocks: number; peakMinutes: number };
  weakTopics: { topicId: string; topic: string; accuracy: number | null; score: number }[];
  todayPlan: { kind: PlanDayKind; questionIds: string[]; reviewIds: string[]; newIds: string[]; mock: boolean };
  days: PlanDay[];
  warnings: string[];
  feasible: boolean;
}

export interface PlanRequest {
  subject: string;
  exam_date?: string;
  minutes_per_day?: number;
  rest_days?: number[];
  mock_questions?: number;
  mock_minutes?: number;
  save?: boolean;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return hoardJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function getStudyPlan(req: PlanRequest): Promise<StudyPlan> {
  return post<StudyPlan>('/study/plan', { save: false, ...req });
}

export function clearStudyPlan(subject: string): Promise<{ removed: boolean }> {
  return post('/study/plan/clear', { subject });
}

/** A mock exam weighted to the weak topics (not saved as an exam): the server ids of its questions. */
export async function mockExamIds(subject: string, n: number): Promise<string[]> {
  const r = await post<{ questions: { id: string }[] }>('/study/mock-exam', { subject, n, save: false });
  return (r.questions ?? []).map((q) => q.id);
}
