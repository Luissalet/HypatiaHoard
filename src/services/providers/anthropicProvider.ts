/**
 * anthropicProvider.ts
 *
 * Provider de Anthropic (Claude) para extracción/generación de preguntas.
 * Llama directamente a la API de Messages con fetch().
 *
 * NOTA: La API de Anthropic requiere CORS headers. Si se llama desde el
 * navegador directamente, puede fallar por CORS. En ese caso el usuario
 * necesitará usar un proxy o la API de OpenAI como alternativa.
 */

import { z } from 'zod';
import type { AIProvider, ExtractionParams, ExtractedQuestion } from '@/services/aiEngine';

// ─── Zod schema (reutilizado) ────────────────────────────────────────────────

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

// ─── System prompt (shared logic with OpenAI) ────────────────────────────────

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
      : `TAREA: Extrae TODAS las preguntas que ya existen en el documento. Identifica preguntas tipo test, preguntas de desarrollo, ejercicios prácticos y preguntas de completar. Mantén el texto original de las preguntas lo más fielmente posible.`;

  const originHint =
    params.mode === 'generate'
      ? '"alumno"'
      : '"examen_anterior" o "test" o "clase" según corresponda';

  return `Eres un especialista en extracción de contenido educativo universitario. Tu trabajo es analizar documentos académicos y producir preguntas estructuradas en formato JSON.

ASIGNATURA: ${params.subjectName} (subjectKey: "${params.subjectKey}")

TEMAS VÁLIDOS (usa EXACTAMENTE estos topicKey):
${topicList}
${guideSection}

${modeInstruction}

Devuelve ÚNICAMENTE un JSON array con las preguntas. Sin markdown fences, sin explicaciones.

Formato de cada pregunta:
{
  "type": "TEST" | "DESARROLLO" | "COMPLETAR" | "PRACTICO",
  "prompt": "Enunciado en Markdown con LaTeX ($..$ inline, $$...$$ bloque)",
  "options": [{"id":"a","text":"..."}],          // solo TEST
  "correctOptionIds": ["a"],                      // solo TEST
  "modelAnswer": "Respuesta modelo",              // DESARROLLO/PRACTICO
  "keywords": ["término1"],                       // DESARROLLO/PRACTICO
  "numericAnswer": "42.5",                         // solo PRACTICO
  "clozeText": "El {{algoritmo}} usa...",          // solo COMPLETAR
  "blanks": [{"id":"b1","accepted":["algoritmo"]}], // solo COMPLETAR
  "explanation": "Explicación opcional",
  "difficulty": 3,
  "origin": ${originHint},
  "tags": ["etiqueta"],
  "topicKey": "slug-del-tema"
}

Reglas: IDs de opciones "a","b","c","d","e". Blanks "b1","b2","b3"... Incluye variantes sin tilde en accepted. difficulty 1-5. topicKey debe ser uno de los listados arriba.`;
}

// ─── Anthropic Provider ──────────────────────────────────────────────────────

export class AnthropicProvider implements AIProvider {
  name = 'Anthropic';

  constructor(
    private apiKey: string,
    private model: string = 'claude-sonnet-4-5-20250929',
  ) {}

  async extractQuestions(params: ExtractionParams): Promise<ExtractedQuestion[]> {
    const systemPrompt = buildSystemPrompt(params);

    // Build content blocks
    const content: any[] = [];

    if (params.imageBase64) {
      // Extract media type and base64 data
      const match = params.imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        });
      }
      content.push({
        type: 'text',
        text: `Analiza esta imagen y ${params.mode === 'generate' ? 'genera preguntas basadas en su contenido' : 'extrae las preguntas que contiene'}. Devuelve SOLO el JSON array.`,
      });
    } else {
      const textTruncated = params.documentText.slice(0, 30000);
      let userText = '';
      if (params.contextText?.trim()) {
        const ctxTruncated = params.contextText.slice(0, 15000);
        userText += `Temario de referencia (usa esto para detectar los temas de cada pregunta):\n\n---\n${ctxTruncated}\n---\n\n`;
      }
      userText += `Documento a analizar:\n\n---\n${textTruncated}\n---\n\nDevuelve SOLO el JSON array.`;
      content.push({
        type: 'text',
        text: userText,
      });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16000,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        throw new Error('API key de Anthropic inválida. Revisa tu configuración.');
      }
      if (response.status === 429) {
        throw new Error('Límite de uso de Anthropic alcanzado. Espera un momento.');
      }
      throw new Error(`Error de Anthropic (${response.status}): ${errBody.slice(0, 200)}`);
    }

    const data = await response.json();
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    const rawContent: string = textBlock?.text ?? '';

    return parseAndValidateQuestions(rawContent);
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

function parseAndValidateQuestions(raw: string): ExtractedQuestion[] {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('La IA no devolvió un JSON array válido.');
  }
  cleaned = cleaned.slice(startIdx, endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Error parseando JSON de la respuesta de la IA.');
  }

  const result = ExtractedQuestionsArraySchema.safeParse(parsed);
  if (!result.success) {
    if (Array.isArray(parsed)) {
      const salvaged: ExtractedQuestion[] = [];
      for (const item of parsed) {
        const single = ExtractedQuestionSchema.safeParse(item);
        if (single.success) salvaged.push(single.data as ExtractedQuestion);
      }
      if (salvaged.length > 0) return salvaged;
    }
    throw new Error(`Formato inválido: ${result.error.message.slice(0, 200)}`);
  }

  return result.data as ExtractedQuestion[];
}
