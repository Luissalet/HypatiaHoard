import type { Question, UserAnswer } from './models';
import { normalizeText } from './normalize';

/**
 * Auto-score a TEST question.
 * Correct if selected option set === correct option set.
 */
export function scoreTest(question: Question, answer: UserAnswer): 'CORRECT' | 'WRONG' {
  const correct = new Set(question.correctOptionIds ?? []);
  const selected = new Set(answer.selectedOptionIds ?? []);
  if (correct.size !== selected.size) return 'WRONG';
  for (const id of correct) {
    if (!selected.has(id)) return 'WRONG';
  }
  return 'CORRECT';
}

/**
 * Auto-score a COMPLETAR question.
 * Each blank must match one of its accepted answers (after normalization).
 */
export function scoreCompletar(question: Question, answer: UserAnswer): 'CORRECT' | 'WRONG' {
  const blanks = question.blanks ?? [];
  const blankAnswers = answer.blankAnswers ?? {};

  for (const blank of blanks) {
    const userInput = normalizeText(blankAnswers[blank.id] ?? '');
    const accepted = blank.accepted.map((a) => normalizeText(a));
    if (!accepted.includes(userInput)) return 'WRONG';
  }
  return 'CORRECT';
}

/**
 * Main scoring entry point.
 * Returns null for DESARROLLO (manual correction required).
 */
export function scoreAnswer(question: Question, answer: UserAnswer): 'CORRECT' | 'WRONG' | null {
  switch (question.type) {
    case 'TEST':
      return scoreTest(question, answer);
    case 'COMPLETAR':
      return scoreCompletar(question, answer);
    case 'DESARROLLO':
    case 'PRACTICO':
      // Manual correction only (PRACTICO is similar to DESARROLLO)
      return answer.manualResult ?? null;
    default:
      return null;
  }
}

/**
 * Check how many keyword hints match the user's free text (for DESARROLLO indicator).
 */
export function keywordMatchCount(question: Question, freeText: string): number {
  const keywords = question.keywords ?? [];
  const normalized = normalizeText(freeText);
  return keywords.filter((kw) => normalized.includes(normalizeText(kw))).length;
}
