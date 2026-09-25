/**
 * generateSubjectGuide.ts
 *
 * Genera una guía de contribution pack filtrada para una sola asignatura.
 * Se usa para inyectar en los prompts del AI con los slugs exactos.
 */

import { db } from '@/data/db';
import { slugify } from '@/domain/normalize';

/**
 * Generates a contribution guide section for a single subject.
 * Much lighter than the full guide — only includes the relevant subject and its topics.
 */
export async function generateSubjectGuide(subjectId: string): Promise<string> {
  const subject = await db.subjects.get(subjectId);
  if (!subject) return '';

  const topics = await db.topics
    .where('subjectId')
    .equals(subjectId)
    .sortBy('order');

  const subjectKey = slugify(subject.name);

  const topicRows = topics
    .map((t, i) => `| ${i + 1} | ${t.title} | \`${slugify(t.title)}\` |`)
    .join('\n');

  const topicKeyList = topics
    .map((t) => `  - "${slugify(t.title)}" → ${t.title}`)
    .join('\n');

  return `
══════════════════════════════════════════
SLUGS OBLIGATORIOS — REFERENCIA EXACTA
══════════════════════════════════════════

ASIGNATURA: ${subject.name}
subjectKey: "${subjectKey}"

TEMAS VÁLIDOS (topicKey → nombre):
${topicKeyList}

TABLA DE REFERENCIA:
| # | Tema | topicKey |
|---|------|----------|
${topicRows}

REGLAS DE SLUGS:
- Usa EXACTAMENTE los topicKey listados arriba. No los inventes ni parafrasees.
- Cada pregunta DEBE tener un campo "topicKey" con uno de los slugs de esta tabla.
- Si una pregunta abarca varios temas, usa el tema principal en "topicKey".
- Si no puedes determinar el tema, usa el primer topicKey de la lista.

FORMATO DE CADA PREGUNTA (JSON):
{
  "type": "TEST" | "DESARROLLO" | "COMPLETAR" | "PRACTICO",
  "prompt": "Enunciado en Markdown. LaTeX: $...$ inline, $$...$$ bloque",
  "options": [{"id":"a","text":"..."}],           // solo TEST (3-5 opciones)
  "correctOptionIds": ["a"],                       // solo TEST
  "modelAnswer": "Respuesta modelo completa",      // DESARROLLO/PRACTICO
  "keywords": ["término1", "término2"],            // DESARROLLO/PRACTICO
  "numericAnswer": "42.5",                          // solo PRACTICO
  "clozeText": "El {{algoritmo}} usa {{heurística}}",  // solo COMPLETAR
  "blanks": [{"id":"b1","accepted":["algoritmo"]}],     // solo COMPLETAR
  "explanation": "Explicación de la respuesta",
  "difficulty": 3,
  "origin": "examen_anterior" | "test" | "clase" | "alumno",
  "tags": ["etiqueta1"],
  "topicKey": "slug-del-tema"
}

REGLAS POR TIPO:
- TEST: IDs de opciones "a","b","c","d","e". correctOptionIds obligatorio.
- DESARROLLO: modelAnswer y keywords muy recomendados.
- COMPLETAR: clozeText con {{huecos}} y blanks con accepted[] (incluir variantes sin tilde).
  Blanks se numeran "b1","b2","b3"...
- PRACTICO: numericAnswer con el resultado, modelAnswer con el desarrollo paso a paso.

FORMATO TEXTO:
- Markdown completo: **negrita**, *cursiva*, \`código\`, listas, tablas
- LaTeX: $f(x)=x^2$ inline, $$\\sum_{i=1}^{n} x_i$$ bloque
- Matrices: \\begin{bmatrix}...\\end{bmatrix}
- difficulty: 1=muy fácil, 2=fácil, 3=medio, 4=difícil, 5=muy difícil
`.trim();
}
