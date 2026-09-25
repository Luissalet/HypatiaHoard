/**
 * Anki import utilities.
 * Anki exports .tsv files with columns: front, back, tags (optional)
 * This creates DESARROLLO questions from Anki cards.
 */

export interface AnkiCard {
  front: string;
  back: string;
  tags: string[];
}

/**
 * Parse an Anki .tsv export file.
 * Format: front\tback\ttags (tags are space-separated within the field)
 * Lines starting with # are comments.
 */
export function parseAnkiTsv(content: string): AnkiCard[] {
  const lines = content.split('\n');
  const cards: AnkiCard[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;

    const front = parts[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // strip HTML
    const back = parts[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const tagStr = parts[2] ?? '';
    const tags = tagStr ? tagStr.split(' ').filter(Boolean) : [];

    if (front && back) {
      cards.push({ front, back, tags });
    }
  }

  return cards;
}
