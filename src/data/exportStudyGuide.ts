import { db } from './db';
import { subjectRepo, topicRepo } from './repos';
import type { Question, Topic } from '@/domain/models';

export async function generateStudyGuide(subjectId: string): Promise<string> {
  const subject = await subjectRepo.getById(subjectId);
  if (!subject) return '';

  const topics = await topicRepo.getBySubject(subjectId);
  const questions = await db.questions.where('subjectId').equals(subjectId).toArray();

  // Filter: only questions with at least 1 attempt and ratio < 70%, or starred
  const weak = questions.filter(q =>
    (q.stats.seen > 0 && (q.stats.correct / q.stats.seen) < 0.7) || q.starred
  );

  // Sort by fail ratio (worst first)
  weak.sort((a, b) => {
    const ratioA = a.stats.seen > 0 ? a.stats.correct / a.stats.seen : 0;
    const ratioB = b.stats.seen > 0 ? b.stats.correct / b.stats.seen : 0;
    return ratioA - ratioB;
  });

  // Group by topic
  const topicMap = new Map<string, Topic>();
  topics.forEach(t => topicMap.set(t.id, t));

  const byTopic = new Map<string, Question[]>();
  for (const q of weak) {
    const key = q.topicId;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key)!.push(q);
  }

  // Generate markdown
  let md = `# Resumen de estudio — ${subject.name}\n\n`;
  md += `> Generado el ${new Date().toLocaleDateString('es-ES')}. `;
  md += `${weak.length} preguntas débiles o marcadas como difíciles.\n\n`;

  for (const [topicId, qs] of byTopic) {
    const topic = topicMap.get(topicId);
    md += `## ${topic?.title ?? 'Sin tema'}\n\n`;

    for (const q of qs) {
      const ratio = q.stats.seen > 0
        ? Math.round((q.stats.correct / q.stats.seen) * 100)
        : 0;

      md += `### ${q.starred ? '★ ' : ''}${q.type} — ${ratio}% acierto (${q.stats.correct}/${q.stats.seen})\n\n`;
      md += `**Enunciado:**\n${q.prompt}\n\n`;

      // Answer by type
      if (q.type === 'TEST' && q.options && q.correctOptionIds) {
        md += `**Respuesta correcta:**\n`;
        const correctIds = new Set(q.correctOptionIds);
        for (const opt of q.options) {
          const mark = correctIds.has(opt.id) ? '✅' : '❌';
          md += `- ${mark} ${opt.text}\n`;
        }
        md += '\n';
      } else if (q.type === 'COMPLETAR' && q.clozeText && q.blanks) {
        md += `**Huecos:**\n`;
        for (const blank of q.blanks) {
          md += `- \`{{${blank.id}}}\` → ${blank.accepted.join(' / ')}\n`;
        }
        md += '\n';
      } else if (q.modelAnswer) {
        md += `**Respuesta modelo:**\n${q.modelAnswer}\n\n`;
      }

      if (q.explanation) {
        md += `**Explicación:**\n${q.explanation}\n\n`;
      }

      if (q.notes) {
        md += `**📝 Mis notas:**\n${q.notes}\n\n`;
      }

      md += `---\n\n`;
    }
  }

  return md;
}

export function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
