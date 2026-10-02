/**
 * FSRS-5 scheduler (Free Spaced Repetition Scheduler) with day granularity.
 * Same maths as hypatia/fsrs.py (tests/test_fsrs.py runs both and compares).
 *
 * Each review updates stability S (days until recall drops to 90 %) and
 * difficulty D (1-10); the next review lands on the day the predicted recall
 * falls to the desired retention (0.9 by default). Cards with only SM-2 state
 * start from it (S = interval, D from the ease factor), so switching scheduler
 * never resets a bank.
 */
import type { ReviewGrade } from './spacedRepetition';

export const FSRS_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
] as const;
const W = FSRS_W;
const DECAY = -0.5;
const FACTOR = 19 / 81;
export const FSRS_RATING: Record<ReviewGrade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const MAX_INTERVAL = 36500;
export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.97;
export const DEFAULT_RETENTION = 0.9;
export type Scheduler = 'sm2' | 'fsrs';

export interface FsrsInput {
  seen?: number;
  interval?: number;
  repetitions?: number;
  easeFactor?: number;
  lastSeenAt?: string;
  fsrsStability?: number;
  fsrsDifficulty?: number;
}

export interface FsrsStep {
  easeFactor: number;
  interval: number;
  repetitions: number;
  fsrsStability: number;
  fsrsDifficulty: number;
  nextReviewAt: string;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const clampD = (d: number) => Math.min(10, Math.max(1, d));

export function clampRetention(value: unknown): number {
  const r = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(r)) return DEFAULT_RETENTION;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, r));
}

export function retrievability(elapsedDays: number, stability: number): number {
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

export function nextInterval(stability: number, retention = DEFAULT_RETENTION): number {
  const days = (stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL, Math.max(1, Math.round(days)));
}

const initStability = (rating: number) => Math.max(0.1, W[rating - 1]);
const initDifficulty = (rating: number) => clampD(W[4] - Math.exp(W[5] * (rating - 1)) + 1);

function nextDifficulty(d: number, rating: number): number {
  const delta = -W[6] * (rating - 3);
  const damped = d + (delta * (10 - d)) / 9;
  return clampD(W[7] * initDifficulty(4) + (1 - W[7]) * damped);
}

function stabilityAfterRecall(d: number, s: number, r: number, rating: number): number {
  const hard = rating === 2 ? W[15] : 1;
  const easy = rating === 4 ? W[16] : 1;
  const inc = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy;
  return s * (1 + inc);
}

function stabilityAfterForget(d: number, s: number, r: number): number {
  const sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return Math.min(s, sf);
}

const stabilitySameDay = (s: number, rating: number) => s * Math.exp(W[17] * (rating - 3 + W[18]));

/** SM-2 ease 2.5 -> D 6.2; 1.3 -> 10; 2.9 -> 4.6. */
export function difficultyFromEase(ease: unknown): number {
  const ef = Number(ease);
  return clampD(11 - 4 * ((ease === null || ease === undefined || !Number.isFinite(ef) ? 2.5 : ef) - 1.3));
}

/** Days since the epoch of a 'YYYY-MM-DD…' string (UTC), or null. */
function dayNumber(iso?: string): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

const isoDay = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

export function fsrsStep(stats: FsrsInput | undefined, grade: ReviewGrade, now: Date = new Date(),
                         retention: number = DEFAULT_RETENTION): FsrsStep {
  const st = stats ?? {};
  const rating = FSRS_RATING[grade];
  const ret = clampRetention(retention);
  const today = Math.floor(now.getTime() / 86400000);
  let s: number | null = typeof st.fsrsStability === 'number' && st.fsrsStability > 0 ? st.fsrsStability : null;
  let d: number | null = s !== null && typeof st.fsrsDifficulty === 'number' ? st.fsrsDifficulty : null;
  if (s === null || d === null) {
    if (st.seen && st.interval) {
      s = Math.max(0.1, Number(st.interval));
      d = difficultyFromEase(st.easeFactor);
    } else {
      s = null;
      d = null;
    }
  }
  let newS: number;
  let newD: number;
  if (s === null || d === null) {
    newS = initStability(rating);
    newD = initDifficulty(rating);
  } else {
    const last = dayNumber(st.lastSeenAt);
    const elapsed = last !== null ? today - last : Math.max(1, Math.round(s));
    if (elapsed <= 0) newS = stabilitySameDay(s, rating);
    else {
      const r = retrievability(elapsed, s);
      newS = rating === 1 ? stabilityAfterForget(d, s, r) : stabilityAfterRecall(d, s, r, rating);
    }
    newD = nextDifficulty(d, rating);
  }
  newS = Math.min(MAX_INTERVAL, Math.max(0.1, newS));
  const interval = nextInterval(newS, ret);
  return {
    easeFactor: st.easeFactor ?? 2.5,
    interval,
    repetitions: rating === 1 ? 0 : (st.repetitions ?? 0) + 1,
    fsrsStability: r4(newS),
    fsrsDifficulty: r4(newD),
    nextReviewAt: isoDay(today + interval),
  };
}

/** Days until the next review for each possible grade. */
export function fsrsPreview(stats: FsrsInput | undefined, now: Date = new Date(),
                            retention = DEFAULT_RETENTION): Record<ReviewGrade, number> {
  return {
    again: fsrsStep(stats, 'again', now, retention).interval,
    hard: fsrsStep(stats, 'hard', now, retention).interval,
    good: fsrsStep(stats, 'good', now, retention).interval,
    easy: fsrsStep(stats, 'easy', now, retention).interval,
  };
}
