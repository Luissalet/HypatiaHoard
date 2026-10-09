/**
 * pageCards.ts
 *
 * Page cards: an HTML lesson in the spaced-repetition schedule, reviewed whole.
 * A page card is a DESARROLLO question carrying `pageHtml` (sanitized) and the tag
 * 'pagina' (same shape as the server's hypatia/pages.py), so scheduling (SM-2 / FSRS),
 * sync, stats and due counts need no special case.
 */

import type { Question } from '@/domain/models';
import { sanitizeHtml, htmlToText, htmlTitle, MAX_PAGE_HTML } from '@/utils/sanitizeHtml';

export const PAGE_TAG = 'pagina';
const MAX_TEXT = 16_000;

export type PageCardData = Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>;

export function isPageCard(q: Pick<Question, 'pageHtml'>): boolean {
  return !!q.pageHtml;
}

/** Sanitizes `rawHtml` and builds the question data. Throws Error with a Spanish message when it can't be a card. */
export function buildPageCardData(subjectId: string, topicId: string, title: string, rawHtml: string): PageCardData {
  const clean = sanitizeHtml(rawHtml);
  const text = htmlToText(clean);
  if (!text && !clean.includes('<img')) throw new Error('La página no tiene contenido visible tras limpiarla.');
  if (clean.length > MAX_PAGE_HTML) {
    throw new Error(`La página es demasiado grande (${clean.length} caracteres; el límite es ${MAX_PAGE_HTML}).`);
  }
  const name = (title.trim() || htmlTitle(rawHtml) || '').replace(/\s+/g, ' ').slice(0, 300);
  if (!name) throw new Error('La tarjeta de página necesita un título.');
  return {
    subjectId,
    topicId,
    type: 'DESARROLLO',
    prompt: name,
    modelAnswer: text.slice(0, MAX_TEXT) || name,
    pageHtml: clean,
    origin: 'alumno',
    tags: [PAGE_TAG],
  };
}

/** Reads a local .html/.htm file as text (UTF-8). */
export async function readHtmlFile(file: File): Promise<{ title: string; html: string }> {
  if (file.size > 6_000_000) throw new Error('El archivo es demasiado grande (máximo 6 MB).');
  const html = await file.text();
  return { title: htmlTitle(html) ?? file.name.replace(/\.[^.]+$/, ''), html };
}
