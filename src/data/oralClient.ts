/**
 * oralClient.ts
 *
 * Client for the oral cards of the local Hypatia's Hoard server: the question is read aloud,
 * the answer is recorded (or uploaded, or typed), transcribed and compared by meaning, and the
 * grade enters the spaced-repetition schedule. Routes under /api/study/oral. Hoard mode only.
 */

import { hoardFetch, hoardJson } from './hoardClient';
import type { ReviewGrade } from './lessonsClient';

export interface OralAudio {
  name: string;
  url: string;
  bytes: number;
  duration_s: number | null;
  text: string;
}

export interface OralCard {
  id: string;
  type: string;
  prompt: string;
  spoken: string;
  subjectId: string | null;
  subject: string | null;
  topic: string | null;
  options?: { id: string; letter: string; text: string }[];
  clozeText?: string;
  audio: OralAudio | null;
}

export interface OralNext {
  card: OralCard | null;
  remaining: number;
  asked: number;
  note: string | null;
}

export interface OralStatus {
  tts: boolean;
  stt: 'funes' | 'prospero' | 'local' | null;
  llm: boolean;
  voice: string;
}

export type OralVerdict = 'correct' | 'partial' | 'wrong' | null;

export interface OralResult {
  questionId: string;
  prompt: string;
  heard: boolean;
  transcript: string;
  recorded: boolean;
  action?: 'repeat' | 'skip' | 'stop';
  error?: string;
  note?: string;
  verdict?: OralVerdict;
  score?: number | null;
  covered?: string[];
  missing?: string[];
  feedback?: string | null;
  grade?: ReviewGrade | null;
  expected?: string;
  explanation?: string | null;
  needsSelfGrade?: boolean;
  feedbackSpoken?: string;
  feedbackAudio?: OralAudio | null;
  review?: { result: string; nextReviewAt: string | null; intervalDays: number | null; scheduler: string };
  transcription?: { via: string; language: string | null; duration_s: number | null };
  next?: OralNext;
}

export interface OralScope {
  subject?: string;
  exclude: string[];
  record: boolean;
}

const post = <T,>(path: string, body: unknown) =>
  hoardJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getOralStatus = () => hoardJson<OralStatus>('/study/oral/status');

export const nextOralCard = (scope: Pick<OralScope, 'subject' | 'exclude'>) =>
  post<OralNext>('/study/oral/next', { subject: scope.subject || null, exclude: scope.exclude });

/** A typed (or already transcribed) answer. */
export const answerOralText = (id: string, transcript: string, scope: OralScope) =>
  post<OralResult>('/study/oral/answer', {
    id, transcript, subject: scope.subject || null, exclude: scope.exclude, record: scope.record,
  });

/** A recorded or uploaded answer: the audio is the request body. */
export async function answerOralAudio(id: string, audio: Blob, filename: string, scope: OralScope): Promise<OralResult> {
  const params = new URLSearchParams({ id, record: String(scope.record), exclude: scope.exclude.join(','), filename });
  if (scope.subject) params.set('subject', scope.subject);
  const res = await hoardFetch(`/study/oral/answer-audio?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'application/octet-stream' },
    body: audio,
  });
  return (await res.json()) as OralResult;
}

/** Same origin: the audio element can play it directly. */
export const oralAudioSrc = (audio: OralAudio) => audio.url;
