/**
 * AIExtractionTab.tsx
 *
 * Pestaña "IA" en SubjectView. Permite subir archivos y extraer/generar
 * preguntas usando un modelo de IA (OpenAI o Anthropic).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button, Progress } from './index';
import { AISettingsPanel } from './AISettingsPanel';
import { AIReviewModal, type AcceptedQuestion } from './AIReviewModal';
import {
  getActiveProvider,
  getEffectiveAISettings,
  extractFileContent,
  type ExtractedQuestion,
  type ExtractionMode,
} from '@/services/aiEngine';
import { generateSubjectGuide } from '@/services/generateSubjectGuide';
import { downloadContributionGuide } from '@/data/generateContributionGuide';
import { slugify } from '@/domain/normalize';
import type { Topic, Question, Subject } from '@/domain/models';
import { useStore } from '@/ui/store';
import { listStoredPdfs, getPdfBlobUrl } from '@/data/pdfStorage';
import { extractPdfText } from '@/utils/pdfTextExtractor';
import { loadPdfMapping, getPdfUrl } from '@/data/resourceLoader';
import { loadCategoryFromDB } from '@/data/resourceFromDB';

// ─── Props ───────────────────────────────────────────────────────────────────

interface AIExtractionTabProps {
  subject: Subject;
  topics: Topic[];
}

// ─── Accepted file extensions ────────────────────────────────────────────────

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.jpg,.jpeg,.png,.webp';

// ─── Prompt templates for external LLM ──────────────────────────────────────

const PROMPT_GENERATE = `[Adjunta aquí tus apuntes/resúmenes/PDFs del tema como contexto]

Usando ese contexto, crea [N] preguntas para la asignatura "[NOMBRE ASIGNATURA]", tema "[NOMBRE TEMA]", siguiendo estrictamente las normas del documento adjunto GUIA_CONTRIBUTION_PACKS.md.

🚨 Slugs obligatorios (del Anexo de la guía — no inventar):
  subjectKey: "[SLUG ASIGNATURA]"
  topicKey:   "[SLUG TEMA]"

Devuelve únicamente el JSON válido del contribution pack, sin texto adicional.`.trim();

const PROMPT_EXTRACT = `[Adjunta aquí el examen, test o extracto con las preguntas]

Extrae todas las preguntas de ese documento y genera un contribution pack según las especificaciones exactas de GUIA_CONTRIBUTION_PACKS.md (adjunta también). Para cada pregunta:
- Determina su tipo: TEST, DESARROLLO, COMPLETAR o PRACTICO
- Determina su tema de origen consultando el Anexo de la guía
- Si el documento no incluye respuestas, resuélvelas basándote en el contexto del temario
- Asigna dificultad (1–5) y origin: "examen_anterior" | "test" | "clase" | "alumno"

🚨 Slugs obligatorios (del Anexo de la guía — no inventar):
  subjectKey: "[SLUG ASIGNATURA]"

Devuelve únicamente el JSON válido del contribution pack, sin texto adicional.`.trim();

// ─── Component ───────────────────────────────────────────────────────────────

export function AIExtractionTab({ subject, topics }: AIExtractionTabProps) {
  const { createQuestion, loadQuestions } = useStore();

  // State
  const [mode, setMode] = useState<ExtractionMode>('extract');
  const [file, setFile] = useState<File | null>(null);
  const [inputMode, setInputMode] = useState<'file' | 'text'>('file');
  const [freeText, setFreeText] = useState('');
  const [selectedTopicId, setSelectedTopicId] = useState<string>(topics[0]?.id ?? '');
  const [maxQuestions, setMaxQuestions] = useState(20);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  // AI config
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Review modal
  const [extractedQuestions, setExtractedQuestions] = useState<ExtractedQuestion[]>([]);
  const [showReview, setShowReview] = useState(false);

  // Drag & drop
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Context PDF — each entry has a label for display and info to retrieve it
  const [availablePdfs, setAvailablePdfs] = useState<
    { label: string; filename: string; category: 'temas' | 'resumenes' }[]
  >([]);
  const [contextPdf, setContextPdf] = useState<string>(''); // filename or ''

  // Contribution pack section
  const [copiedGenerate, setCopiedGenerate] = useState(false);
  const [copiedExtract, setCopiedExtract] = useState(false);
  const [downloadingGuide, setDownloadingGuide] = useState(false);

  // Check API key and load available PDFs on mount
  useEffect(() => {
    checkApiKey();

    // Cargar PDFs de Temas + Resúmenes de ambas fuentes (estáticos + IndexedDB)
    (async () => {
      const pdfs: { label: string; filename: string; category: 'temas' | 'resumenes' }[] = [];
      const seen = new Set<string>();

      // 1. Temas desde index.json estático
      try {
        const mapping = await loadPdfMapping(subject.name);
        for (const entry of mapping) {
          if (!seen.has(entry.pdf)) {
            seen.add(entry.pdf);
            pdfs.push({
              label: `Temas / ${entry.topicTitle || entry.pdf}`,
              filename: entry.pdf,
              category: 'temas',
            });
          }
        }
      } catch { /* sin temas estáticos */ }

      // 2. Temas desde IndexedDB (sin prefijo de categoría)
      try {
        const dbPdfs = await listStoredPdfs(subject.id);
        for (const f of dbPdfs) {
          // Los de Temas en DB no tienen prefijo; los de Resumenes sí
          if (!f.includes('/') && !seen.has(f)) {
            seen.add(f);
            pdfs.push({ label: `Temas / ${f}`, filename: f, category: 'temas' });
          }
        }

        // 3. Resúmenes desde IndexedDB (prefijo Resumenes/)
        for (const f of dbPdfs) {
          if (f.startsWith('Resumenes/') && !seen.has(f)) {
            seen.add(f);
            const name = f.replace(/^Resumenes\//, '');
            pdfs.push({ label: `Resúmenes / ${name}`, filename: f, category: 'resumenes' });
          }
        }
      } catch { /* sin PDFs en DB */ }

      setAvailablePdfs(pdfs);
    })();
  }, [subject.id, subject.name]);

  const checkApiKey = async () => {
    const ai = await getEffectiveAISettings();
    if (!ai) {
      setHasApiKey(false);
      return;
    }
    if (ai.provider === 'hoard') {
      // Hypatia local (solo en modo hoard): usable only when the server reports a text model
      if (import.meta.env.VITE_HOARD !== '1') { setHasApiKey(false); return; }
      const { getCapabilities } = await import('@/data/hoardClient');
      setHasApiKey((await getCapabilities()).llm);
    }
    else if (ai.provider === 'openai' && ai.openaiApiKey) setHasApiKey(true);
    else if (ai.provider === 'anthropic' && ai.anthropicApiKey) setHasApiKey(true);
    else if (ai.provider === 'webllm') setHasApiKey(true); // No API key needed
    else setHasApiKey(false);
  };

  // ── File selection ──

  const handleFileSelect = useCallback((f: File) => {
    setFile(f);
    setError(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFileSelect(f);
    },
    [handleFileSelect],
  );

  // ── Extract questions ──

  const handleExtract = async () => {
    let documentText = '';
    let imageBase64: string | undefined;

    setExtracting(true);
    setError(null);
    setProgress(0);

    try {
      // Step 1: Get text (either from file or free text)
      if (inputMode === 'text') {
        if (!freeText.trim()) {
          setError('Por favor escribe o pega algún texto primero.');
          setExtracting(false);
          return;
        }
        documentText = freeText;
        setProgressLabel('Generando guía de referencia...');
        setProgress(0.3);
      } else {
        if (!file) {
          setError('Por favor selecciona un archivo primero.');
          setExtracting(false);
          return;
        }
        setProgressLabel('Extrayendo texto del archivo...');
        const extracted = await extractFileContent(file, (p) => {
          setProgress(p * 0.3); // 0-30% for file extraction
        });
        documentText = extracted.text;
        imageBase64 = extracted.imageBase64;
      }

      if (!documentText.trim() && !imageBase64) {
        throw new Error('No se pudo extraer texto. ¿Está vacío o es un PDF escaneado sin OCR?');
      }

      setProgress(0.3);
      setProgressLabel('Generando guía de referencia...');

      // Step 2: Generate contribution guide for this subject (exact slugs)
      const contributionGuide = await generateSubjectGuide(subject.id);

      // Step 2b: Extract context PDF text if selected
      let contextText: string | undefined;
      if (contextPdf) {
        setProgressLabel('Extrayendo texto del PDF de contexto...');
        const selected = availablePdfs.find((p) => p.filename === contextPdf);

        // Intentar IndexedDB/FSA primero
        let pdfUrl = await getPdfBlobUrl(subject.id, contextPdf);
        let isBlob = !!pdfUrl;

        // Fallback a recurso estático (solo para Temas)
        if (!pdfUrl && selected?.category === 'temas') {
          pdfUrl = getPdfUrl(subject.name, contextPdf);
          isBlob = false;
        }

        if (pdfUrl) {
          try {
            const pdfResult = await extractPdfText(pdfUrl);
            contextText = pdfResult.blocks.map((b) => b.text).join('\n\n');
          } finally {
            if (isBlob) URL.revokeObjectURL(pdfUrl);
          }
        }
      }

      setProgress(0.35);
      setProgressLabel('Enviando a la IA...');

      // Step 3: Get AI provider
      const provider = await getActiveProvider();

      // Step 4: Build topic list
      const topicList = topics.map((t) => ({
        topicKey: slugify(t.title),
        topicTitle: t.title,
      }));

      setProgress(0.4);
      setProgressLabel(
        mode === 'generate'
          ? 'Generando preguntas nuevas...'
          : 'Extrayendo preguntas del documento...',
      );

      // Step 5: Call AI with contribution guide embedded
      const extracted = await provider.extractQuestions({
        documentText,
        subjectKey: slugify(subject.name),
        subjectName: subject.name,
        topics: topicList,
        mode,
        maxQuestions,
        imageBase64,
        contributionGuide,
        contextText,
      });

      setProgress(1);
      setProgressLabel(`${extracted.length} preguntas encontradas`);

      if (extracted.length === 0) {
        setError('La IA no encontró preguntas en el documento. Prueba con otro archivo o cambia el modo.');
        return;
      }

      // Step 6: Show review modal
      setExtractedQuestions(extracted);
      setShowReview(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  // ── Contribution guide ──

  const handleDownloadGuide = async () => {
    setDownloadingGuide(true);
    try {
      await downloadContributionGuide();
    } finally {
      setDownloadingGuide(false);
    }
  };

  const handleCopyGenerate = () => {
    navigator.clipboard.writeText(PROMPT_GENERATE).then(() => {
      setCopiedGenerate(true);
      setTimeout(() => setCopiedGenerate(false), 2000);
    });
  };

  const handleCopyExtract = () => {
    navigator.clipboard.writeText(PROMPT_EXTRACT).then(() => {
      setCopiedExtract(true);
      setTimeout(() => setCopiedExtract(false), 2000);
    });
  };

  // ── Import accepted questions ──

  const handleImport = async (accepted: AcceptedQuestion[]) => {
    let imported = 0;

    for (const { question: q, topicId } of accepted) {
      try {
        const newQuestion: Omit<Question, 'id' | 'createdAt' | 'updatedAt' | 'contentHash'> = {
          subjectId: subject.id,
          topicId,
          type: q.type,
          prompt: q.prompt,
          explanation: q.explanation,
          difficulty: q.difficulty as Question['difficulty'],
          tags: q.tags,
          origin: q.origin ?? (mode === 'generate' ? 'alumno' : 'examen_anterior'),
          options: q.options,
          correctOptionIds: q.correctOptionIds,
          modelAnswer: q.modelAnswer,
          keywords: q.keywords,
          numericAnswer: q.numericAnswer,
          clozeText: q.clozeText,
          blanks: q.blanks,
          createdBy: 'IA',
          stats: { seen: 0, correct: 0, wrong: 0 },
        };

        await createQuestion(newQuestion);
        imported++;
      } catch (err) {
        console.error('Error importing question:', err);
      }
    }

    // Refresh questions list
    await loadQuestions(subject.id);

    setShowReview(false);
    setFile(null);
    setFreeText('');
    setExtractedQuestions([]);
    setError(null);
    setProgressLabel(`${imported} preguntas importadas correctamente`);
    setProgress(0);

    // Clear success message after 5s
    setTimeout(() => setProgressLabel(''), 5000);
  };

  // ── Render ──

  const subjectKey = slugify(subject.name);

  return (
    <div className="flex flex-col gap-5">
      {/* ── API key banner ── */}
      {hasApiKey === false && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-amber-300 font-medium">Configuración necesaria</p>
            <p className="text-xs text-ink-400 mt-0.5">
              Configura un proveedor de IA: OpenAI/Anthropic (con API key) o WebLLM (gratuito, local en tu navegador).
            </p>
          </div>
          <Button size="sm" onClick={() => setShowSettings(true)}>
            Configurar
          </Button>
        </div>
      )}

      {/* ── Section: Hazlo tu mismo ── */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-ink-200">✨ Hazlo tu mismo</span>
        <div className="flex-1 border-t border-ink-700" />
      </div>

      {/* ── Mode selector ── */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('extract')}
          className={`flex-1 rounded-lg px-4 py-3 text-sm text-left border transition-colors ${
            mode === 'extract'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
              : 'border-ink-700 bg-ink-900 text-ink-400 hover:border-ink-600'
          }`}
        >
          <span className="text-base block mb-1">Extraer preguntas</span>
          <span className="text-xs opacity-70">
            Sube un examen o test y extrae las preguntas que ya contiene
          </span>
        </button>
        <button
          onClick={() => setMode('generate')}
          className={`flex-1 rounded-lg px-4 py-3 text-sm text-left border transition-colors ${
            mode === 'generate'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
              : 'border-ink-700 bg-ink-900 text-ink-400 hover:border-ink-600'
          }`}
        >
          <span className="text-base block mb-1">Generar nuevas</span>
          <span className="text-xs opacity-70">
            Sube apuntes o un tema y genera preguntas de estudio automáticamente
          </span>
        </button>
      </div>

      {/* ── Input mode selector (file vs text) ── */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setInputMode('file')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'file' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'text-ink-400 hover:text-ink-200 border border-ink-700'}`}
        >
          📄 Subir archivo
        </button>
        <button
          onClick={() => setInputMode('text')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${inputMode === 'text' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'text-ink-400 hover:text-ink-200 border border-ink-700'}`}
        >
          ✏️ Texto directo
        </button>
      </div>

      {/* ── File upload zone ── */}
      {inputMode === 'file' && (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex flex-col items-center gap-3 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-amber-500 bg-amber-500/10'
            : file
              ? 'border-sage-600/50 bg-sage-900/10'
              : 'border-ink-700 hover:border-ink-500 bg-ink-900/50'
        }`}
      >
        <span className="text-3xl">{file ? '✓' : '📄'}</span>
        {file ? (
          <>
            <span className="text-sm text-sage-300 font-medium">{file.name}</span>
            <span className="text-xs text-ink-500">
              {(file.size / 1024).toFixed(0)} KB — Click para cambiar
            </span>
          </>
        ) : (
          <>
            <span className="text-sm text-ink-300">
              Arrastra un archivo aquí o haz click para seleccionar
            </span>
            <span className="text-xs text-ink-500">
              PDF, DOCX, TXT, MD, JPG, PNG
            </span>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFileSelect(f);
            e.target.value = '';
          }}
          className="hidden"
        />
      </div>
      )}

      {/* ── Text input zone ── */}
      {inputMode === 'text' && (
        <div className="flex flex-col gap-3">
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Pega aquí el texto del que quieres generar preguntas (apuntes, resúmenes, fragmentos de libro...)"
            rows={10}
            className="w-full bg-ink-800 border border-ink-700 text-ink-100 rounded-xl px-4 py-3 text-sm font-body placeholder:text-ink-600 focus:outline-none focus:ring-2 focus:ring-amber-500 resize-vertical"
          />
          <p className="text-xs text-ink-500">El texto se enviará directamente al modelo de IA para extraer o generar preguntas.</p>
        </div>
      )}

      {/* ── Options row ── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Topic selector — solo visible en modo generar (en extraer se detecta por pregunta) */}
        {mode === 'generate' && (
          <div>
            <label className="text-xs text-ink-400 uppercase tracking-widest block mb-1">
              Tema principal
            </label>
            <select
              value={selectedTopicId}
              onChange={(e) => setSelectedTopicId(e.target.value)}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            >
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-500 mt-1">
              Puedes reasignar temas individualmente en el modal de revisión
            </p>
          </div>
        )}

        {mode === 'extract' && (
          <div>
            <p className="text-xs text-ink-500 mt-1 col-span-1">
              La IA detectará automáticamente el tema de cada pregunta. Podrás revisarlos y reasignar en el modal.
            </p>
          </div>
        )}

        {/* Max questions (only for generate mode) */}
        {mode === 'generate' && (
          <div>
            <label className="text-xs text-ink-400 uppercase tracking-widest block mb-1">
              Cantidad de preguntas
            </label>
            <select
              value={maxQuestions}
              onChange={(e) => setMaxQuestions(Number(e.target.value))}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            >
              <option value={5}>5 preguntas</option>
              <option value={10}>10 preguntas</option>
              <option value={20}>20 preguntas</option>
              <option value={30}>30 preguntas</option>
              <option value={50}>50 preguntas</option>
            </select>
          </div>
        )}
      </div>

      {/* ── Context PDF selector ── */}
      {availablePdfs.length > 0 && (
        <div>
          <label className="text-xs text-ink-400 uppercase tracking-widest block mb-1">
            PDF de contexto (opcional)
          </label>
          <select
            value={contextPdf}
            onChange={(e) => setContextPdf(e.target.value)}
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          >
            <option value="">Sin contexto adicional</option>
            {availablePdfs.map((pdf) => (
              <option key={pdf.filename} value={pdf.filename}>
                {pdf.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-ink-500 mt-1">
            Selecciona un PDF del temario o resumen para que la IA pueda detectar mejor los temas de cada pregunta.
          </p>
        </div>
      )}

      {/* ── Progress ── */}
      {extracting && (
        <div className="flex flex-col gap-2">
          <Progress value={progress} max={1} />
          <p className="text-xs text-ink-400 text-center">{progressLabel}</p>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* ── Success message ── */}
      {!extracting && !error && progressLabel && (
        <div className="bg-sage-500/10 border border-sage-500/30 rounded-lg px-4 py-3 text-sm text-sage-300">
          {progressLabel}
        </div>
      )}

      {/* ── Extract button ── */}
      <Button
        onClick={handleExtract}
        disabled={
          (inputMode === 'file' && !file) ||
          (inputMode === 'text' && !freeText.trim()) ||
          hasApiKey === false ||
          extracting
        }
        loading={extracting}
      >
        {extracting
          ? 'Procesando...'
          : mode === 'generate'
            ? `Generar ${maxQuestions} preguntas`
            : 'Extraer preguntas del documento'}
      </Button>

      {/* ── Settings gear ── */}
      {hasApiKey && (
        <button
          onClick={() => setShowSettings(true)}
          className="text-xs text-ink-500 hover:text-ink-300 self-end"
        >
          Cambiar configuración de IA
        </button>
      )}

      {/* ── Divider: or use external LLM ── */}
      <div className="relative my-1">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-ink-700" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-ink-950 px-3 text-xs text-ink-500 uppercase tracking-widest">
            o con un LLM externo
          </span>
        </div>
      </div>

      {/* ── Section: Crea con ChatGPT / Claude ── */}
      <div className="flex flex-col gap-4 p-4 border border-ink-700/60 rounded-xl bg-ink-900/30">
        {/* Header */}
        <div>
          <p className="text-sm font-semibold text-ink-200">🤖 Crea con ChatGPT / Claude</p>
          <p className="text-xs text-ink-400 mt-1">
            Descarga la guía personalizada con tus asignaturas y temas exactos, y úsala con cualquier
            LLM para generar preguntas en el formato correcto.
          </p>
        </div>

        {/* Download button */}
        <Button
          variant="secondary"
          onClick={handleDownloadGuide}
          loading={downloadingGuide}
          disabled={downloadingGuide}
        >
          📥 Descargar guía de contribution pack
        </Button>

        {/* Instructions */}
        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-400 font-medium uppercase tracking-widest">Cómo usarla</p>
          <ol className="flex flex-col gap-1.5 text-xs text-ink-400 list-decimal list-inside">
            <li>Descarga la guía — contiene tus asignaturas, temas y slugs exactos.</li>
            <li>
              Abre ChatGPT, Claude o cualquier LLM y adjunta (o pega) el archivo.
            </li>
            <li>Usa el prompt de abajo como punto de partida, rellenando los corchetes.</li>
            <li>
              Importa el JSON resultante en{' '}
              <span className="text-ink-300">Ajustes → Importar contribuciones</span>.
            </li>
          </ol>
        </div>

        {/* Prompt templates */}
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-400 font-medium uppercase tracking-widest">Prompts de ejemplo</p>

          {/* Generate prompt */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-300">✏️ Generar preguntas desde apuntes</span>
              <button
                onClick={handleCopyGenerate}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  copiedGenerate
                    ? 'border-sage-500/50 text-sage-400 bg-sage-500/10'
                    : 'border-ink-600 text-ink-400 hover:border-ink-400 hover:text-ink-200'
                }`}
              >
                {copiedGenerate ? '✓ Copiado' : 'Copiar'}
              </button>
            </div>
            <pre className="text-xs text-ink-500 bg-ink-800/60 border border-ink-700 rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
              {PROMPT_GENERATE}
            </pre>
          </div>

          {/* Extract prompt */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-300">📄 Extraer desde examen o test</span>
              <button
                onClick={handleCopyExtract}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  copiedExtract
                    ? 'border-sage-500/50 text-sage-400 bg-sage-500/10'
                    : 'border-ink-600 text-ink-400 hover:border-ink-400 hover:text-ink-200'
                }`}
              >
                {copiedExtract ? '✓ Copiado' : 'Copiar'}
              </button>
            </div>
            <pre className="text-xs text-ink-500 bg-ink-800/60 border border-ink-700 rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed overflow-x-auto">
              {PROMPT_EXTRACT}
            </pre>
          </div>
        </div>
      </div>

      {/* ── Settings modal ── */}
      <AISettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={() => {
          setShowSettings(false);
          checkApiKey();
        }}
      />

      {/* ── Review modal ── */}
      <AIReviewModal
        open={showReview}
        questions={extractedQuestions}
        topics={topics}
        sourceFileName={file?.name ?? ''}
        mode={mode}
        onImport={handleImport}
        onCancel={() => {
          setShowReview(false);
          setExtractedQuestions([]);
        }}
      />
    </div>
  );
}
