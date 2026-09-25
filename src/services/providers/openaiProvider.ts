/**
 * openaiProvider.ts
 *
 * Provider de OpenAI para extracción/generación de preguntas.
 * Llama directamente a la API de OpenAI con fetch().
 */

import { z } from 'zod';
import type { AIProvider, ExtractionParams, ExtractedQuestion } from '@/services/aiEngine';

// ─── Zod schema for validating LLM output ────────────────────────────────────

const ExtractedQuestionSchema = z.object({
  type: z.enum(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']),
  prompt: z.string().min(5),
  options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  correctOptionIds: z.array(z.string()).optional(),
  modelAnswer: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  numericAnswer: z.string().optional(),
  clozeText: z.string().optional(),
  blanks: z.array(z.object({ id: z.string(), accepted: z.array(z.string()) })).optional(),
  explanation: z.string().optional(),
  difficulty: z.number().min(1).max(5).optional(),
  origin: z.enum(['test', 'examen_anterior', 'clase', 'alumno']).optional(),
  tags: z.array(z.string()).optional(),
  topicKey: z.string().optional(),
});

const ExtractedQuestionsArraySchema = z.array(ExtractedQuestionSchema);

// ─── System prompt builder ───────────────────────────────────────────────────

function buildSystemPrompt(params: ExtractionParams): string {
  // If we have a full contribution guide, use it as the primary reference
  const guideSection = params.contributionGuide
    ? `\n\n${params.contributionGuide}`
    : '';

  const topicList = params.topics
    .map((t) => `  - topicKey: "${t.topicKey}" → ${t.topicTitle}`)
    .join('\n');

  const modeInstruction =
    params.mode === 'generate'
      ? `TAREA: Genera ${params.maxQuestions ?? 20} preguntas NUEVAS de estudio basadas en el contenido del documento. Las preguntas deben cubrir los conceptos clave, definiciones, fórmulas y aplicaciones prácticas del material. Varía los tipos de pregunta (TEST, DESARROLLO, COMPLETAR, PRACTICO) y los niveles de dificultad (1-5).`
      : `TAREA: Extrae TODAS las preguntas que ya existen en el documento. Identifica preguntas tipo test, preguntas de desarrollo, ejercicios prácticos y preguntas de completar. Mantén el texto original de las preguntas lo más fielmente posible. Si el documento es un examen, extrae cada pregunta como un elemento separado.`;

  const originHint =
    params.mode === 'generate'
      ? '"alumno" (generadas por IA)'
      : '"examen_anterior" (si es un examen) o "test" (si es un test de práctica) o "clase" (si son preguntas de clase)';

  return `Eres un especialista en extracción de contenido educativo. Tu trabajo es analizar documentos académicos y producir preguntas estructuradas en formato JSON.

ASIGNATURA: ${params.subjectName}
subjectKey: "${params.subjectKey}"

TEMAS VÁLIDOS (usa EXACTAMENTE estos topicKey):
${topicList}
${guideSection}

${modeInstruction}

FORMATO DE SALIDA — Devuelve ÚNICAMENTE un JSON array (sin markdown fences, sin explicaciones):

[
  {
    "type": "TEST",
    "prompt": "Texto de la pregunta en Markdown. Usa $...$ para LaTeX inline y $$...$$ para bloques.",
    "options": [
      { "id": "a", "text": "Opción A" },
      { "id": "b", "text": "Opción B" },
      { "id": "c", "text": "Opción C" },
      { "id": "d", "text": "Opción D" }
    ],
    "correctOptionIds": ["b"],
    "explanation": "Explicación de por qué B es correcta.",
    "difficulty": 3,
    "origin": ${originHint},
    "tags": ["concepto1", "concepto2"],
    "topicKey": "slug-del-tema-del-anexo"
  }
]

REGLAS PARA CADA TIPO:

1. **TEST** (opción múltiple):
   - Campos obligatorios: type, prompt, options (3-5 opciones con id único), correctOptionIds
   - Opcional: explanation, difficulty, tags, topicKey
   - IDs de opciones: "a", "b", "c", "d", "e"

2. **DESARROLLO** (respuesta libre):
   - Campos obligatorios: type, prompt
   - Muy recomendado: modelAnswer (respuesta modelo completa), keywords (términos clave esperados)
   - Opcional: explanation, difficulty, tags, topicKey

3. **COMPLETAR** (rellenar huecos):
   - Campos obligatorios: type, prompt, clozeText (texto con huecos {{respuesta}}), blanks
   - clozeText ejemplo: "El algoritmo {{A*}} usa una función {{heurística}} admisible."
   - blanks ejemplo: [{"id":"b1","accepted":["A*","a*"]}, {"id":"b2","accepted":["heurística","heuristica"]}]
   - Los blanks se numeran b1, b2, b3... en orden de aparición
   - Incluye variantes sin tilde en accepted

4. **PRACTICO** (respuesta numérica):
   - Campos obligatorios: type, prompt
   - Muy recomendado: modelAnswer (desarrollo paso a paso), numericAnswer (resultado numérico)
   - Opcional: keywords, explanation, difficulty, tags, topicKey

REGLAS DE FORMATO:
- Usa Markdown para formatear texto: **negrita**, *cursiva*, \`código\`, listas, tablas
- Fórmulas matemáticas con LaTeX: $f(x) = x^2$ (inline), $$\\sum_{i=1}^{n} x_i$$ (bloque)
- Matrices: \\begin{bmatrix}...\\end{bmatrix}
- difficulty: 1=muy fácil, 2=fácil, 3=medio, 4=difícil, 5=muy difícil
- topicKey DEBE ser uno de los slugs listados arriba
- Si no puedes determinar el topic exacto, usa el primero de la lista
- Cada pregunta debe ser independiente y auto-contenida

IMPORTANTE: Devuelve SOLO el JSON array. Sin texto antes ni después. Sin \`\`\`json. Solo el array [...]`;
}

// ─── OpenAI Provider ─────────────────────────────────────────────────────────

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider implements AIProvider {
  name = 'OpenAI';

  /**
   * @param baseUrl OpenAI-compatible API root (no trailing slash). Default: OpenAI.
   *                The 'hoard' provider passes '/api/ai/v1' (local Hypatia proxy).
   */
  constructor(
    private apiKey: string,
    private model: string = 'gpt-4o-mini',
    private baseUrl: string = OPENAI_BASE_URL,
    name?: string,
  ) {
    if (name) this.name = name;
  }

  async extractQuestions(params: ExtractionParams): Promise<ExtractedQuestion[]> {
    const systemPrompt = buildSystemPrompt(params);

    // Build messages
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    // If image, use vision API
    if (params.imageBase64) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analiza esta imagen y ${params.mode === 'generate' ? 'genera preguntas basadas en su contenido' : 'extrae las preguntas que contiene'}. Devuelve SOLO el JSON array.`,
          },
          {
            type: 'image_url',
            image_url: { url: params.imageBase64 },
          },
        ],
      });
    } else {
      const textTruncated = params.documentText.slice(0, 30000); // ~7500 tokens approx
      let userText = '';
      if (params.contextText?.trim()) {
        const ctxTruncated = params.contextText.slice(0, 15000);
        userText += `Temario de referencia (usa esto para detectar los temas de cada pregunta):\n\n---\n${ctxTruncated}\n---\n\n`;
      }
      userText += `Documento a analizar:\n\n---\n${textTruncated}\n---\n\nDevuelve SOLO el JSON array con las preguntas extraídas/generadas.`;
      messages.push({
        role: 'user',
        content: userText,
      });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.3,
        max_tokens: 16000,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        throw new Error(`API key de ${this.name} inválida. Revisa tu configuración.`);
      }
      if (response.status === 429) {
        throw new Error(`Límite de uso de ${this.name} alcanzado. Espera un momento e inténtalo de nuevo.`);
      }
      throw new Error(`Error de ${this.name} (${response.status}): ${errBody.slice(0, 200)}`);
    }

    const data = await response.json();
    const content: string = data.choices?.[0]?.message?.content ?? '';

    return parseAndValidateQuestions(content);
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

function parseAndValidateQuestions(raw: string): ExtractedQuestion[] {
  // Clean up: remove markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // Find the JSON array
  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('La IA no devolvió un JSON array válido. Intenta de nuevo.');
  }
  cleaned = cleaned.slice(startIdx, endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Error parseando JSON de la respuesta de la IA. Intenta de nuevo.');
  }

  // Validate with Zod
  const result = ExtractedQuestionsArraySchema.safeParse(parsed);
  if (!result.success) {
    // Try to salvage individual questions
    if (Array.isArray(parsed)) {
      const salvaged: ExtractedQuestion[] = [];
      for (const item of parsed) {
        const single = ExtractedQuestionSchema.safeParse(item);
        if (single.success) {
          salvaged.push(single.data as ExtractedQuestion);
        }
      }
      if (salvaged.length > 0) return salvaged;
    }
    throw new Error(`La IA devolvió preguntas con formato inválido: ${result.error.message.slice(0, 200)}`);
  }

  return result.data as ExtractedQuestion[];
}
