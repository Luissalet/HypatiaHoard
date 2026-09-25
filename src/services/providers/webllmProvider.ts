/**
 * webllmProvider.ts
 *
 * Provider que usa WebLLM para ejecutar modelos de IA directamente
 * en el navegador (WebGPU). Gratuito, sin API key, totalmente local.
 *
 * NOTA: Requiere que el navegador soporte WebGPU (Chrome 121+, Edge 121+).
 * El primer uso descarga el modelo (~4GB para 8B), las siguientes ejecuciones
 * usan la caché del navegador.
 */

import { z } from 'zod';
import type { AIProvider, ExtractionParams, ExtractedQuestion } from '@/services/aiEngine';

// ─── Zod schema ──────────────────────────────────────────────────────────────

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

// ─── Singleton engine cache ──────────────────────────────────────────────────

let cachedEngine: any = null;
let cachedModelId: string | null = null;

// ─── System prompt (optimizado para modelos pequeños 8B) ─────────────────────

function buildSystemPrompt(params: ExtractionParams): string {
  const topicList = params.topics
    .map((t) => `"${t.topicKey}"`)
    .join(', ');

  const isExtract = params.mode === 'extract';
  const count = params.maxQuestions ?? 10;

  // Prompt ultra-conciso con ejemplo concreto — modelos 8B necesitan esto
  return `Devuelve SOLO un JSON array con preguntas tipo test.

Asignatura: ${params.subjectName}
Temas válidos: [${topicList}]

${isExtract ? 'Extrae las preguntas del documento.' : `Genera ${count} preguntas del contenido.`}

Ejemplo de formato exacto:
[{"type":"TEST","prompt":"¿Cuál es la capital de Francia?","options":[{"id":"a","text":"Madrid"},{"id":"b","text":"París"},{"id":"c","text":"Roma"},{"id":"d","text":"Berlín"}],"correctOptionIds":["b"],"explanation":"París es la capital de Francia.","difficulty":1,"origin":"${isExtract ? 'examen_anterior' : 'alumno'}","topicKey":"${params.topics[0]?.topicKey ?? 'tema-1'}"}]

Reglas:
- SOLO JSON array, sin texto antes ni después
- Cada pregunta tiene 4 opciones con ids "a","b","c","d"
- topicKey debe ser uno de los temas válidos
- difficulty de 1 a 5`;
}

// ─── WebLLM Provider ─────────────────────────────────────────────────────────

export class WebLLMProvider implements AIProvider {
  name = 'WebLLM (Local)';

  constructor(private model: string = 'Llama-3.1-8B-Instruct-q4f16_1-MLC') {}

  async extractQuestions(params: ExtractionParams): Promise<ExtractedQuestion[]> {
    // Check WebGPU support
    if (!('gpu' in navigator)) {
      throw new Error(
        'Tu navegador no soporta WebGPU, necesario para ejecutar modelos locales. ' +
        'Usa Chrome 121+ o Edge 121+. Alternativamente, configura un provider de API (OpenAI/Anthropic).'
      );
    }

    // Dynamic import from CDN — no npm install needed
    let webllm: any;
    const cdnUrl = 'https://esm.run/@mlc-ai/web-llm@0.2.81';
    try {
      webllm = await import(/* @vite-ignore */ cdnUrl);
    } catch {
      throw new Error(
        'No se pudo cargar WebLLM. Comprueba tu conexión a internet.\n\n' +
        'Nota: WebLLM requiere ~4GB de descarga la primera vez para el modelo. ' +
        'Las siguientes ejecuciones usan la caché del navegador.'
      );
    }

    // Reuse or create engine
    if (!cachedEngine || cachedModelId !== this.model) {
      try {
        cachedEngine = await webllm.CreateMLCEngine(this.model, {
          initProgressCallback: (progress: any) => {
            console.log(`[WebLLM] ${progress.text}`);
          },
        });
        cachedModelId = this.model;
      } catch (err: any) {
        cachedEngine = null;
        cachedModelId = null;
        throw new Error(
          `Error cargando modelo ${this.model}: ${err?.message ?? err}. ` +
          'Asegúrate de tener conexión a internet para la primera descarga.'
        );
      }
    }

    const systemPrompt = buildSystemPrompt(params);

    if (params.imageBase64) {
      throw new Error(
        'Los modelos locales (WebLLM) no soportan análisis de imágenes. ' +
        'Usa un provider de API (OpenAI/Anthropic) para archivos de imagen.'
      );
    }

    // Repartir contexto entre el PDF de referencia y el documento
    const hasContext = !!params.contextText?.trim();
    const maxTotal = 12000; // chars totales para el modelo
    const contextMax = hasContext ? Math.min(params.contextText!.length, 4000) : 0;
    const docMax = maxTotal - contextMax;

    let userContent = '';
    if (hasContext) {
      const ctxTruncated = params.contextText!.slice(0, contextMax);
      userContent += `Temario de referencia (usa esto para detectar los temas):\n\n${ctxTruncated}\n\n---\n\n`;
    }
    const textTruncated = params.documentText.slice(0, docMax);
    userContent += `Documento con las preguntas:\n\n${textTruncated}\n\nJSON array:`;

    const response = await cachedEngine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2, // Más determinista para JSON
      max_tokens: 8000,
    });

    const content: string = response.choices?.[0]?.message?.content ?? '';
    return parseAndValidateQuestions(content);
  }
}

// ─── JSON recovery (robusto para modelos pequeños) ───────────────────────────

/**
 * Intenta reparar JSON malformado común en modelos pequeños:
 * - Trailing commas: [{"a":1},]
 * - JSON truncado: [{"a":1},{"a":2  (sin cerrar)
 * - Objetos sueltos sin array: {"a":1}{"a":2}
 * - Markdown fences: ```json ... ```
 */
function repairJson(raw: string): string {
  let s = raw.trim();

  // Quitar markdown fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  s = s.trim();

  // Si empieza con texto antes del [, cortarlo
  const arrStart = s.indexOf('[');
  if (arrStart > 0) {
    s = s.slice(arrStart);
  }

  // Si no tiene [ pero tiene {, intentar envolver en array
  if (!s.startsWith('[') && s.startsWith('{')) {
    // Puede ser objetos concatenados: {...}{...}
    s = '[' + s.replace(/\}\s*\{/g, '},{') + ']';
  }

  // Quitar trailing commas antes de ] o }
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Si el JSON está truncado (no termina en ]), intentar cerrarlo
  if (s.startsWith('[') && !s.endsWith(']')) {
    // Buscar el último objeto completo (termina en })
    const lastCloseBrace = s.lastIndexOf('}');
    if (lastCloseBrace > 0) {
      s = s.slice(0, lastCloseBrace + 1) + ']';
    }
  }

  return s;
}

// ─── Response parsing ────────────────────────────────────────────────────────

function parseAndValidateQuestions(raw: string): ExtractedQuestion[] {
  if (!raw.trim()) {
    throw new Error(
      'El modelo no generó respuesta. Prueba de nuevo o usa un documento más corto.'
    );
  }

  // Intentar parsear directamente primero
  let parsed: unknown;
  const cleaned = repairJson(raw);

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Segundo intento: buscar cualquier substring que sea JSON válido
    const startIdx = raw.indexOf('[');
    const endIdx = raw.lastIndexOf(']');
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        const subset = repairJson(raw.slice(startIdx, endIdx + 1));
        parsed = JSON.parse(subset);
      } catch {
        // Último intento: extraer objetos individuales con regex
        parsed = extractObjectsManually(raw);
      }
    } else {
      parsed = extractObjectsManually(raw);
    }
  }

  if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) {
    throw new Error(
      'El modelo local no devolvió preguntas válidas. ' +
      'Los modelos pequeños a veces fallan con documentos largos. ' +
      'Prueba con un texto más corto o usa OpenAI/Anthropic.'
    );
  }

  // Validar con Zod, rescatando las que sean válidas
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const salvaged: ExtractedQuestion[] = [];

  for (const item of items) {
    // Intentar normalizar campos comunes que el modelo puede escribir mal
    const normalized = normalizeQuestion(item);
    const result = ExtractedQuestionSchema.safeParse(normalized);
    if (result.success) {
      salvaged.push(result.data as ExtractedQuestion);
    }
  }

  if (salvaged.length === 0) {
    throw new Error(
      `El modelo generó ${items.length} respuesta(s) pero ninguna tiene el formato correcto. ` +
      'Prueba de nuevo o usa un provider de API para mejores resultados.'
    );
  }

  return salvaged;
}

/**
 * Intenta extraer objetos JSON individuales del texto con regex.
 * Útil cuando el modelo mezcla texto con JSON.
 */
function extractObjectsManually(raw: string): unknown[] {
  const results: unknown[] = [];
  // Buscar patrones que parezcan objetos JSON con "type" y "prompt"
  const regex = /\{[^{}]*"type"\s*:\s*"[^"]*"[^{}]*"prompt"\s*:\s*"[^"]*"[^{}]*\}/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    try {
      const repaired = repairJson(match[0]);
      const obj = JSON.parse(repaired);
      results.push(obj);
    } catch {
      // Skip malformed objects
    }
  }

  // Si el regex simple no funciona, intentar con objetos anidados
  if (results.length === 0) {
    const deepRegex = /\{(?:[^{}]|\{[^{}]*\}|\[(?:[^\[\]]|\[[^\[\]]*\])*\])*\}/g;
    while ((match = deepRegex.exec(raw)) !== null) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj && typeof obj === 'object' && obj.type && obj.prompt) {
          results.push(obj);
        }
      } catch {
        // Skip
      }
    }
  }

  return results;
}

/**
 * Normaliza campos que modelos pequeños suelen escribir mal.
 */
function normalizeQuestion(item: any): any {
  if (!item || typeof item !== 'object') return item;

  const q = { ...item };

  // type en minúsculas → mayúsculas
  if (typeof q.type === 'string') {
    q.type = q.type.toUpperCase();
    // Aliases comunes
    if (q.type === 'MULTIPLE_CHOICE' || q.type === 'CHOICE' || q.type === 'MCQ') q.type = 'TEST';
    if (q.type === 'ESSAY' || q.type === 'OPEN') q.type = 'DESARROLLO';
    if (q.type === 'FILL' || q.type === 'FILL_BLANK' || q.type === 'CLOZE') q.type = 'COMPLETAR';
    if (q.type === 'NUMERIC' || q.type === 'CALCULATION') q.type = 'PRACTICO';
  }

  // correctOptionIds como string → array
  if (typeof q.correctOptionIds === 'string') {
    q.correctOptionIds = [q.correctOptionIds];
  }

  // Si "answer" existe pero "correctOptionIds" no, intentar mapear
  if (!q.correctOptionIds && q.answer && q.type === 'TEST') {
    const ans = String(q.answer).toLowerCase().trim();
    if (['a', 'b', 'c', 'd', 'e'].includes(ans)) {
      q.correctOptionIds = [ans];
    }
    delete q.answer;
  }

  // difficulty como string → number
  if (typeof q.difficulty === 'string') {
    const n = parseInt(q.difficulty, 10);
    if (!isNaN(n) && n >= 1 && n <= 5) q.difficulty = n;
    else delete q.difficulty;
  }

  // Asegurar que options tiene formato correcto
  if (Array.isArray(q.options)) {
    q.options = q.options.map((opt: any, i: number) => {
      if (typeof opt === 'string') {
        return { id: String.fromCharCode(97 + i), text: opt };
      }
      if (opt && typeof opt === 'object') {
        return {
          id: opt.id ?? String.fromCharCode(97 + i),
          text: opt.text ?? opt.label ?? opt.value ?? String(opt),
        };
      }
      return { id: String.fromCharCode(97 + i), text: String(opt) };
    });
  }

  return q;
}
