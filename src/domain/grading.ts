import type { Deliverable, SubjectGradingConfig } from './models';
import { isDeliverableCompleted } from './models';

export const DEFAULT_GRADING_CONFIG: Omit<SubjectGradingConfig, 'id'> = {
  continuousWeight: 0.4,
  maxContinuousPoints: 10,
  testContinuousPoints: 0.1,
};

export interface GradeBreakdown {
  /** Sum of all contributions before cap */
  rawContinuous: number;
  /** rawContinuous capped at maxContinuousPoints */
  cappedContinuous: number;
  /** Points added to final from continuous: cappedContinuous * continuousWeight */
  continuousContribution: number;
  /** Points added to final from exam: examGrade * (1 - continuousWeight) */
  examContribution: number | null;
  /** Final grade (null if no exam grade yet) */
  finalGrade: number | null;
  /** Raw points still achievable from incomplete deliverables (capped to what fits) */
  remainingPotential: number;
  /** Best possible final if all remaining deliverables are perfect */
  bestCaseGrade: number | null;
}

/**
 * Calculates the raw continuous score from deliverables.
 * - Tests: contribute `continuousPoints` flat when done/submitted (binary completion)
 * - Activities: contribute `(grade / 10) * continuousPoints` when graded
 *   (having a grade implies the activity was returned and scored — status not required)
 * - Exams / otros: do not contribute to continuous score
 */
export function calcContinuousRaw(deliverables: Deliverable[]): number {
  return deliverables.reduce((sum, d) => {
    if (d.type === 'test') {
      if (!isDeliverableCompleted(d.status)) return sum;
      // If graded, use proportional contribution like activities; otherwise flat points
      if (d.grade != null) return sum + (d.grade / 10) * d.continuousPoints;
      return sum + d.continuousPoints;
    }
    if (d.type === 'activity' && d.grade != null) {
      return sum + (d.grade / 10) * d.continuousPoints;
    }
    return sum;
  }, 0);
}

/**
 * Full grade breakdown for a subject.
 *
 * Example flow:
 *   rawContinuous = 12 pts
 *   cappedContinuous = min(12, 10) = 10
 *   continuousContribution = 10 * 0.4 = 4
 *   examContribution = 7.5 * 0.6 = 4.5
 *   finalGrade = 4 + 4.5 = 8.5
 */
export function calcGradeBreakdown(
  config: SubjectGradingConfig,
  deliverables: Deliverable[],
): GradeBreakdown {
  const rawContinuous = calcContinuousRaw(deliverables);
  const cappedContinuous = Math.min(rawContinuous, config.maxContinuousPoints);
  const continuousContribution = cappedContinuous * config.continuousWeight;

  const examContribution =
    config.examGrade != null
      ? config.examGrade * (1 - config.continuousWeight)
      : null;

  const finalGrade =
    examContribution != null ? examContribution + continuousContribution : null;

  // Potential = tests not yet completed or completed without grade + activities not yet graded
  const potentialFromIncomplete = deliverables
    .filter((d) =>
      (d.type === 'test' && (!isDeliverableCompleted(d.status) || d.grade == null)) ||
      (d.type === 'activity' && d.grade == null)
    )
    .reduce((sum, d) => sum + d.continuousPoints, 0);

  const remainingPotential = Math.max(
    0,
    Math.min(potentialFromIncomplete, config.maxContinuousPoints - rawContinuous),
  );

  const bestRaw = Math.min(rawContinuous + potentialFromIncomplete, config.maxContinuousPoints);
  const bestContinuousContribution = bestRaw * config.continuousWeight;
  const bestCaseGrade =
    config.examGrade != null
      ? config.examGrade * (1 - config.continuousWeight) + bestContinuousContribution
      : null;

  return {
    rawContinuous,
    cappedContinuous,
    continuousContribution,
    examContribution,
    finalGrade,
    remainingPotential,
    bestCaseGrade,
  };
}

/** Round to 2 decimal places for display */
export function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}