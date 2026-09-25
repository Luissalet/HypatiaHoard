/**
 * ankiExport.ts
 *
 * Exports questions in Anki-compatible TSV (text) format.
 * Compatible with Anki's import feature using the "Basic" (or "Cloze") note type.
 *
 * Format per line: Front[TAB]Back[TAB]Tags
 *
 * Usage in Anki:
 *   File → Import → select .txt → separator: Tab → fields: Front, Back, Tags
 */

import type { Question, Topic } from '@/domain/models';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeTag(text: string): string {
  return text.replace(/\s+/g, '_').replace(/[^\w\-]/g, '').slice(0, 50);
}

/**
 * Generates Anki-importable TSV content from a list of questions.
 * @param questions   Full question objects
 * @param topics      Topics for the subject (to resolve topicId → title)
 * @param subjectName Subject name (used as deck name and tag)
 * @param selectedIds Optional set of IDs to export; if omitted, exports all
 */
export function exportToAnkiTsv(
  questions: Question[],
  topics: Topic[],
  subjectName: string,
  selectedIds?: Set<string>,
): string {
  const topicMap = new Map(topics.map((t) => [t.id, t.title]));

  const toExport = selectedIds
    ? questions.filter((q) => selectedIds.has(q.id))
    : questions;

  const lines: string[] = [
    '#separator:tab',
    '#html:true',
    `#deck:${subjectName}`,
    '#notetype:Basic',
    '',
  ];

  for (const q of toExport) {
    const topicName = topicMap.get(q.topicId) ?? '';

    let front = '';
    let back = '';

    switch (q.type) {
      case 'TEST': {
        front = `<p><b>${escapeHtml(q.prompt)}</b></p>`;
        if (q.options && q.options.length > 0) {
          front += '<ol type="A">';
          for (const opt of q.options) {
            front += `<li>${escapeHtml(opt.text)}</li>`;
          }
          front += '</ol>';
        }
        const correctOpts = (q.options ?? []).filter((o) =>
          q.correctOptionIds?.includes(o.id),
        );
        if (correctOpts.length > 0) {
          back = correctOpts
            .map((o) => `<b style="color:#2e7d32">✓ ${escapeHtml(o.text)}</b>`)
            .join('<br>');
        }
        if (q.explanation) {
          back += `${back ? '<br><br>' : ''}<i>${escapeHtml(q.explanation)}</i>`;
        }
        break;
      }

      case 'DESARROLLO':
      case 'PRACTICO': {
        front = `<p><b>${escapeHtml(q.prompt)}</b></p>`;
        if (q.numericAnswer) {
          front += `<p><i>Calcula el resultado numérico.</i></p>`;
        }
        back = q.modelAnswer ? `<p>${escapeHtml(q.modelAnswer)}</p>` : '';
        if (q.numericAnswer) {
          back += `<p><b>Resultado: ${escapeHtml(q.numericAnswer)}</b></p>`;
        }
        if (q.keywords && q.keywords.length > 0) {
          back += `<p><small>Palabras clave: ${q.keywords.map(escapeHtml).join(', ')}</small></p>`;
        }
        if (q.explanation && q.explanation !== q.modelAnswer) {
          back += `<p><i>${escapeHtml(q.explanation)}</i></p>`;
        }
        break;
      }

      case 'COMPLETAR': {
        front = `<p><b>${escapeHtml(q.prompt)}</b></p>`;
        if (q.clozeText) {
          // Show the cloze text with blanks highlighted
          const highlighted = escapeHtml(q.clozeText).replace(
            /___/g,
            '<b style="color:#e65100">[___]</b>',
          );
          front += `<p>${highlighted}</p>`;
        }
        // Back: filled-in cloze
        if (q.clozeText && q.blanks && q.blanks.length > 0) {
          let filled = escapeHtml(q.clozeText);
          for (const blank of q.blanks) {
            const answer = blank.accepted[0] ?? '?';
            filled = filled.replace(
              '___',
              `<b style="color:#2e7d32"><u>${escapeHtml(answer)}</u></b>`,
            );
          }
          back = `<p>${filled}</p>`;
        }
        if (q.explanation) {
          back += `<p><i>${escapeHtml(q.explanation)}</i></p>`;
        }
        break;
      }
    }

    // Build Anki tags: subject + topic + type + user-defined tags
    const tags = [
      sanitizeTag(subjectName),
      topicName ? sanitizeTag(topicName) : '',
      q.type,
      ...(q.tags ?? []).map(sanitizeTag),
    ]
      .filter(Boolean)
      .join(' ');

    // Escape tabs and newlines within field content (Anki would break otherwise)
    const safeFront = front.replace(/\t/g, '  ').replace(/\r?\n/g, ' ');
    const safeBack = back.replace(/\t/g, '  ').replace(/\r?\n/g, ' ');

    lines.push(`${safeFront}\t${safeBack}\t${tags}`);
  }

  return lines.join('\n');
}

/** Downloads the TSV content as a UTF-8 .txt file. */
export function downloadAnkiFile(content: string, filename: string): void {
  // BOM so Excel / Anki recognizes UTF-8 correctly
  const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
