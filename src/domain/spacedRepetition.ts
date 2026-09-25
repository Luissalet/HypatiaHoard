import type { Question } from './models';

export interface SM2Stats {
  easeFactor: number;
  interval: number;
  repetitions: number;
}

/** Self-graded recall (Hypatia's Hoard / Anki style). */
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

/** SM-2 quality for each grade: again/hard/good/easy → 0/3/4/5. */
export const GRADE_QUALITY: Record<ReviewGrade, number> = { again: 0, hard: 3, good: 4, easy: 5 };

/** Result recorded in stats for a grade: only 'again' counts as WRONG. */
export function gradeToResult(grade: ReviewGrade): 'CORRECT' | 'WRONG' {
  return grade === 'again' ? 'WRONG' : 'CORRECT';
}

/**
 * SM-2 step. By default q = 5 (CORRECT) or 0 (WRONG), as always.
 * Pass `quality` (0-5, e.g. GRADE_QUALITY[grade]) for the graded variant;
 * then `result` is ignored for the formula.
 */
export function calcNextReview(
  current: Partial<SM2Stats>,
  result: 'CORRECT' | 'WRONG',
  quality?: number,
): SM2Stats & { nextReviewAt: string } {
  const ef = current.easeFactor ?? 2.5;
  const reps = current.repetitions ?? 0;
  const q = quality !== undefined && Number.isFinite(quality)
    ? Math.max(0, Math.min(5, Math.round(quality)))
    : result === 'CORRECT' ? 5 : 0;

  let newEf = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  newEf = Math.max(1.3, newEf);

  let newInterval: number;
  let newReps: number;

  if (q < 3) {
    newInterval = 1;
    newReps = 0;
  } else {
    newReps = reps + 1;
    if (reps === 0) newInterval = 1;
    else if (reps === 1) newInterval = 6;
    else newInterval = Math.round((current.interval ?? 1) * newEf);
  }

  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + newInterval);

  return {
    easeFactor: newEf,
    interval: newInterval,
    repetitions: newReps,
    nextReviewAt: nextDate.toISOString().split('T')[0],
  };
}

export function sortByPriority(questions: Question[]): Question[] {
  const today = new Date().toISOString().split('T')[0];
  return [...questions].sort((a, b) => {
    const aDate = a.stats.nextReviewAt ?? '0000-00-00';
    const bDate = b.stats.nextReviewAt ?? '0000-00-00';
    const aOverdue = aDate <= today;
    const bOverdue = bDate <= today;
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    return aDate.localeCompare(bDate);
  });
}
