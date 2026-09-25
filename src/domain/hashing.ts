import type { Question, ContributionQuestion } from './models';
import { normalizeText } from './normalize';

/**
 * Compute a stable content hash for a question.
 * Used to detect duplicates when merging contribution packs.
 * Based on: type + normalized prompt + normalized options/answers.
 *
 * NOTE: topicKey is intentionally EXCLUDED from the hash so the same
 * question filed under slightly different topics is still detected as
 * a duplicate.  correctOptionIds are resolved to their normalised option
 * texts so that packs using different ID schemes still match.
 */
export async function computeContentHash(
  q: Pick<Question, 'type' | 'prompt' | 'options' | 'correctOptionIds' | 'modelAnswer' | 'clozeText' | 'blanks'>,
  _topicKey?: string,              // kept for call-site compat, no longer used in hash
): Promise<string> {
  const parts: string[] = [
    q.type,
    normalizeText(q.prompt),
  ];

  if (q.type === 'TEST') {
    // Sort option texts for order-independent comparison
    const optionTexts = (q.options ?? [])
      .map((o) => normalizeText(o.text, true))
      .sort()
      .join('|');
    parts.push(optionTexts);

    // Resolve correctOptionIds → normalised texts of correct options (order-independent)
    const correctIds = new Set(q.correctOptionIds ?? []);
    const correctTexts = (q.options ?? [])
      .filter((o) => correctIds.has(o.id))
      .map((o) => normalizeText(o.text, true))
      .sort()
      .join('|');
    parts.push(correctTexts);
  } else if (q.type === 'DESARROLLO' || q.type === 'PRACTICO') {
    parts.push(normalizeText(q.modelAnswer ?? ''));
  } else if (q.type === 'COMPLETAR') {
    parts.push(normalizeText(q.clozeText ?? ''));
    const blanksStr = (q.blanks ?? [])
      .map((b) => b.accepted.map((a) => normalizeText(a, true)).sort().join(','))
      .join('|');
    parts.push(blanksStr);
  }

  const raw = parts.join('::');
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return 'sha256:' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute hash for a contribution question (uses subjectKey+topicKey as context).
 */
export async function computeContributionHash(q: ContributionQuestion): Promise<string> {
  return computeContentHash(q, q.topicKey);
}
