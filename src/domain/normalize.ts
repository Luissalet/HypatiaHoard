/**
 * Normalize text for comparison: trim, lowercase, collapse spaces,
 * optionally remove diacritics.
 */
export function normalizeText(text: string, removeDiacritics = true): string {
  let s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (removeDiacritics) {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return s;
}

/**
 * Slugify a string: lowercase, no accents, replace spaces with hyphens.
 * Used for subjectKey and topicKey in contribution packs.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}
