/**
 * aiEngine.ts
 *
 * Abstracción del motor de IA para extracción/generación de preguntas.
 * Soporta múltiples providers (OpenAI, Anthropic) con una interfaz común.
 */

import type { QuestionType, QuestionOption, ClozeBlank, DifficultyLevel, QuestionOrigin, AISettings } from '@/domain/models';
import { getSettings } from '@/data/db';
import { isHoardMode } from '@/data/hoardMode';
import { extractPdfText } from '@/utils/pdfTextExtractor';
import mammoth from 'mammoth';

// ─── Extracted Question (formato intermedio antes de guardar) ─────────────────

export interface ExtractedQuestion {
  type: QuestionType;
  prompt: string;
  options?: QuestionOption[];
  correctOptionIds?: string[];
  modelAnswer?: string;
  keywords?: string[];
  numericAnswer?: string;
  clozeText?: string;
  blanks?: ClozeBlank[];
  explanation?: string;
  difficulty?: DifficultyLevel;
  origin?: QuestionOrigin;
  tags?: string[];
  topicKey?: string;
}

// ─── AI Provider interface ───────────────────────────────────────────────────

export type ExtractionMode = 'generate' | 'extract';

export interface ExtractionParams {
  /** Texto del documento fuente */
  documentText: string;
  /** Slug de la asignatura */
  subjectKey: string;
  /** Nombre de la asignatura */
  subjectName: string;
  /** Topics disponibles con sus slugs */
  topics: { topicKey: string; topicTitle: string }[];
  /** Generar nuevas vs extraer existentes */
  mode: ExtractionMode;
  /** Número máximo de preguntas */
  maxQuestions?: number;
  /** Imagen en base64 (para archivos de imagen) */
  imageBase64?: string;
  /** Guía de contribución generada para la asignatura actual (slugs exactos) */
  contributionGuide?: string;
  /** Texto extraído de un PDF de contexto (temario/resumen) para ayudar al modelo */
  contextText?: string;
}

export interface AIProvider {
  name: string;
  extractQuestions(params: ExtractionParams): Promise<ExtractedQuestion[]>;
}

// ─── Provider factory ────────────────────────────────────────────────────────

/** OpenAI-compatible proxy of the local Hypatia's Hoard server (hoard mode only). */
export const HOARD_AI_BASE_URL = '/api/ai/v1';
/** The proxy ignores the key; OpenAIProvider just needs a non-empty one. */
const HOARD_AI_DUMMY_KEY = 'hypatia-local';
/** Model name sent to the proxy; the server resolves it through Hoard Link. */
const HOARD_AI_MODEL = 'default';

/**
 * Effective AI settings: the saved ones, or — in hoard mode with nothing
 * saved — the local 'hoard' provider. A saved 'hoard' provider outside hoard
 * mode is treated as unconfigured.
 */
export async function getEffectiveAISettings(): Promise<AISettings | undefined> {
  const settings = await getSettings();
  const ai = settings.aiSettings;
  if (ai?.provider === 'hoard' && !isHoardMode()) return undefined;
  if (!ai && isHoardMode()) return { provider: 'hoard' };
  return ai;
}

export async function getActiveProvider(): Promise<AIProvider> {
  const ai = await getEffectiveAISettings();

  if (!ai) {
    throw new Error('No hay configuración de IA. Ve a la pestaña IA y configura tu API key.');
  }

  if (ai.provider === 'hoard') {
    const { OpenAIProvider } = await import('@/services/providers/openaiProvider');
    return new OpenAIProvider(HOARD_AI_DUMMY_KEY, HOARD_AI_MODEL, HOARD_AI_BASE_URL, 'Hypatia (local)');
  }

  if (ai.provider === 'openai') {
    if (!ai.openaiApiKey) throw new Error('Falta la API key de OpenAI.');
    const { OpenAIProvider } = await import('@/services/providers/openaiProvider');
    return new OpenAIProvider(ai.openaiApiKey, ai.openaiModel ?? 'gpt-4o-mini');
  }

  if (ai.provider === 'anthropic') {
    if (!ai.anthropicApiKey) throw new Error('Falta la API key de Anthropic.');
    const { AnthropicProvider } = await import('@/services/providers/anthropicProvider');
    return new AnthropicProvider(ai.anthropicApiKey, ai.anthropicModel ?? 'claude-sonnet-4-5-20250929');
  }

  if (ai.provider === 'webllm') {
    const { WebLLMProvider } = await import('@/services/providers/webllmProvider');
    return new WebLLMProvider(ai.webllmModel ?? 'Llama-3.1-8B-Instruct-q4f16_1-MLC');
  }

  throw new Error(`Provider desconocido: ${ai.provider}`);
}

// ─── File text extraction ────────────────────────────────────────────────────

export interface FileExtractionResult {
  text: string;
  imageBase64?: string;
  fileType: 'pdf' | 'docx' | 'txt' | 'md' | 'image';
}

export async function extractFileContent(
  file: File,
  onProgress?: (p: number) => void,
): Promise<FileExtractionResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = file.type;

  // PDF
  if (ext === 'pdf' || mime === 'application/pdf') {
    const url = URL.createObjectURL(file);
    try {
      const result = await extractPdfText(url, { onProgress });
      const text = result.blocks.map((b) => b.text).join('\n\n');
      return { text, fileType: 'pdf' };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // DOCX
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    onProgress?.(1);
    return { text: result.value, fileType: 'docx' };
  }

  // Markdown / Plain text
  if (['txt', 'md', 'markdown'].includes(ext) || mime.startsWith('text/')) {
    const text = await file.text();
    onProgress?.(1);
    return { text, fileType: ext === 'md' || ext === 'markdown' ? 'md' : 'txt' };
  }

  // Images — convert to base64 for vision API
  if (mime.startsWith('image/')) {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
    );
    onProgress?.(1);
    return {
      text: '[Imagen subida — se enviará a la API de visión para extracción]',
      imageBase64: `data:${mime};base64,${base64}`,
      fileType: 'image',
    };
  }

  throw new Error(`Formato de archivo no soportado: .${ext} (${mime})`);
}

// ─── Explanation generation ──────────────────────────────────────────────────

/**
 * Genera una explicación para una pregunta de tipo TEST usando el proveedor de IA activo.
 * Devuelve el texto de la explicación, o lanza un error si falla.
 */
export async function generateExplanation(question: {
  prompt: string;
  options?: QuestionOption[];
  correctOptionIds?: string[];
  modelAnswer?: string;
  type: string;
}): Promise<string> {
  const ai = await getEffectiveAISettings();
  if (!ai) throw new Error('No hay configuración de IA configurada.');

  let questionContext = `Pregunta: ${question.prompt}\n`;

  if (question.type === 'TEST' && question.options && question.options.length > 0) {
    questionContext += '\nOpciones:\n';
    question.options.forEach((opt, i) => {
      const isCorrect = (question.correctOptionIds ?? []).includes(opt.id);
      questionContext += `${String.fromCharCode(65 + i)}) ${opt.text}${isCorrect ? ' ✓ (correcta)' : ''}\n`;
    });
  }

  if (question.modelAnswer) {
    questionContext += `\nRespuesta modelo: ${question.modelAnswer}`;
  }

  const prompt = `Eres un profesor experto. Genera una explicación concisa (2-4 frases) para la siguiente pregunta de estudio. La explicación debe aclarar POR QUÉ la respuesta correcta es correcta y, si aplica, por qué las otras opciones son incorrectas. Responde SOLO con el texto de la explicación, sin preámbulos ni formato extra.

${questionContext}

Explicación:`;

  const isHoard = ai.provider === 'hoard';
  if (isHoard || (ai.provider === 'openai' && ai.openaiApiKey)) {
    const { OPENAI_BASE_URL } = await import('@/services/providers/openaiProvider');
    const baseUrl = isHoard ? HOARD_AI_BASE_URL : OPENAI_BASE_URL;
    const key = isHoard ? HOARD_AI_DUMMY_KEY : ai.openaiApiKey;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: isHoard ? HOARD_AI_MODEL : (ai.openaiModel ?? 'gpt-4o-mini'),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : undefined;
      throw new Error(data.error?.message ?? detail ?? (isHoard ? 'Error del modelo local de Hypatia' : 'Error de OpenAI'));
    }
    return data.choices[0].message.content.trim();
  }

  if (ai.provider === 'anthropic' && ai.anthropicApiKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ai.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: ai.anthropicModel ?? 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'Error de Anthropic');
    return data.content[0].text.trim();
  }

  throw new Error('Proveedor de IA no compatible con esta función. Usa OpenAI, Anthropic o Hypatia (local).');
}
