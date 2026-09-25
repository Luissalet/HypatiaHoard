/**
 * PdfListenMode.tsx
 *
 * Página completa del modo escucha de PDFs.
 * Soporta dos modos:
 *   1. Temas: /subject/:subjectId/listen/:topicId
 *   2. Recursos (resúmenes, etc.): /subject/:subjectId/listen-resource?file=Resumenes/archivo.pdf
 *
 * Muestra texto extraído con highlighting del bloque actual + controles TTS.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { db } from '@/data/db';
import { subjectRepo } from '@/data/repos';
import { EmptyState } from '@/ui/components';
import { TtsControls } from '@/ui/components/TtsControls';
import { extractPdfText, type TextBlock } from '@/utils/pdfTextExtractor';
import { mathToSpeech } from '@/utils/mathSymbolSpeech';
import { createTtsEngine, type TtsEngine, type TtsState, type TtsVoiceInfo } from '@/utils/ttsEngine';
import { createAudioTtsEngine, hashBlockTexts } from '@/utils/audioTtsEngine';
import { enqueueSynthesis, cancelSynthesis, storeTopicWavCacheKey, storeResourceWavCacheKey } from '@/utils/backgroundSynthesis';
import { createAudioKeepalive, type AudioKeepaliveManager } from '@/utils/audioKeepalive';
import { createMediaSessionController, type MediaSessionController } from '@/utils/mediaSessionController';
import { getPdfBlobUrl } from '@/data/pdfStorage';
import { getResourceBlobUrl } from '@/data/resourceFromDB';
import { getPdfUrl, resourcesUrl } from '@/data/resourceLoader';
import { slugify } from '@/domain/normalize';
import type { Subject, Topic } from '@/domain/models';

// ─── Component ─────────────────────────────────────────────────────────────────

export function PdfListenMode() {
  const { subjectId, topicId } = useParams<{ subjectId: string; topicId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Resource mode: file query param (e.g. "Resumenes/archivo.pdf")
  const resourceFile = searchParams.get('file');
  const isResourceMode = !!resourceFile;

  // ── State ──────────────────────────────────────────────────────────────────
  const [subject, setSubject] = useState<Subject | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState(0);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [processedTexts, setProcessedTexts] = useState<string[]>([]);
  const [ttsState, setTtsState] = useState<TtsState>('idle');
  const [currentBlock, setCurrentBlock] = useState(0);
  const [rate, setRate] = useState(1.0);
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([]);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [estimatedRemaining, setEstimatedRemaining] = useState<number | null>(null);
  /** Progreso de síntesis del audio concatenado */
  const [synthProgress, setSynthProgress] = useState<{ current: number; total: number; bytes: number } | null>(null);

  // Timing accumulator: normalized to rate 1.0 so speed changes don't invalidate data
  const timingRef = useRef({ totalBaseMs: 0, totalChars: 0 });

  const ttsRef = useRef<TtsEngine | null>(null);
  const keepaliveRef = useRef<AudioKeepaliveManager | null>(null);
  const mediaSessionRef = useRef<MediaSessionController | null>(null);
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Clave de caché WAV para el PDF actual (hash de textos + voiceId) */
  const wavCacheKeyRef = useRef<string | null>(null);

  // ── Title for display ──────────────────────────────────────────────────────
  const displayTitle = isResourceMode
    ? decodeURIComponent(resourceFile!.split('/').pop() ?? 'Recurso')
    : topic?.title ?? 'Tema';

  // ── Load subject + topic, then extract ─────────────────────────────────────
  useEffect(() => {
    if (!subjectId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      // 1. Load subject
      const s = await subjectRepo.getById(subjectId);
      if (!s) { if (!cancelled) { setError('Asignatura no encontrada'); setLoading(false); } return; }
      if (!cancelled) setSubject(s);

      // 2. Load topic (if topic mode)
      let t: Topic | undefined;
      if (!isResourceMode && topicId) {
        t = await db.topics.get(topicId);
        if (!t) { if (!cancelled) { setError('Tema no encontrado'); setLoading(false); } return; }
        if (!cancelled) setTopic(t);
      }

      // 3. Validate PDF source
      if (!isResourceMode && (!t || !t.pdfFilename)) {
        if (!cancelled) setLoading(false);
        return;
      }

      // 4. Resolve PDF URL
      // Primero busca en IndexedDB (blobs importados por ZIP), luego en estáticos.
      // Para el fallback estático, verificamos que no sea un SPA catch-all (text/html).
      let url: string | null = null;
      try {
        if (isResourceMode && resourceFile) {
          url = await getResourceBlobUrl(subjectId, resourceFile);
          if (!url) {
            const slug = slugify(s.name);
            const staticUrl = resourcesUrl(`resources/${slug}/${resourceFile}`);
            // Verificar que sea un archivo real y no el SPA catch-all
            try {
              const headRes = await fetch(staticUrl, { method: 'HEAD' });
              const ct = headRes.headers.get('Content-Type') ?? '';
              if (headRes.ok && !ct.includes('text/html')) {
                url = staticUrl;
              }
            } catch {
              // estático no disponible
            }
          }
        } else if (t?.pdfFilename) {
          url = await getPdfBlobUrl(subjectId, t.pdfFilename);
          if (!url) {
            const staticUrl = getPdfUrl(s.name, t.pdfFilename);
            try {
              const headRes = await fetch(staticUrl, { method: 'HEAD' });
              const ct = headRes.headers.get('Content-Type') ?? '';
              if (headRes.ok && !ct.includes('text/html')) {
                url = staticUrl;
              }
            } catch {
              // estático no disponible
            }
          }
        }
      } catch {
        if (!cancelled) { setError('No se pudo obtener la URL del PDF'); setLoading(false); }
        return;
      }

      if (!url) {
        if (!cancelled) { setError('No se pudo obtener la URL del PDF'); setLoading(false); }
        return;
      }

      // 5. Extract text
      if (cancelled) return;
      if (!cancelled) setExtracting(true);

      try {
        const result = await extractPdfText(url, {
          onProgress: (p) => { if (!cancelled) setExtractProgress(p); },
        });

        if (cancelled) return;
        setBlocks(result.blocks);
        const processed = result.blocks.map((b) => mathToSpeech(b.text));
        setProcessedTexts(processed);
      } catch (err) {
        if (!cancelled) setError(`Error al extraer texto: ${err}`);
      } finally {
        if (!cancelled) { setLoading(false); setExtracting(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [subjectId, topicId, isResourceMode, resourceFile]);

  // ── Compute WAV cache key when texts change ──────────────────────────────
  useEffect(() => {
    if (processedTexts.length === 0) {
      wavCacheKeyRef.current = null;
      return;
    }
    hashBlockTexts(processedTexts).then((hash) => {
      wavCacheKeyRef.current = hash;
      // Store topicId → cacheKey so the topic list can show WAV status icons
      if (topicId && !isResourceMode) {
        storeTopicWavCacheKey(topicId, hash);
      }
      // Store resourceFile → cacheKey so the resource list can show WAV status icons
      if (isResourceMode && resourceFile) {
        storeResourceWavCacheKey(resourceFile, hash);
      }
      // Cancel any background synthesis for this PDF (we're taking over)
      const currentVoice = ttsRef.current?.getVoice();
      const voiceId = currentVoice?.name ?? 'es_ES-carlfm-x_low';
      cancelSynthesis(`${hash}:${voiceId}`);
    });
  }, [processedTexts]);

  // ── Initialize TTS engine + audio keepalive + media session ───────────────
  //
  // Estrategia de motor TTS:
  //   - Motor principal: Piper TTS (VITS neural) → genera WAV real → funciona en 2º plano
  //   - Fallback: speechSynthesis (solo funciona en primer plano en Android)
  //
  // Piper TTS corre 100% en el navegador vía WASM + Web Worker.
  // Genera WAV de alta calidad con voces neurales y lo reproduce a través
  // de un <audio> element real, que es lo que permite que Android mantenga
  // el audio en segundo plano y muestre la notificación con controles
  // play/pause (como YouTube/Rumble).
  //
  // Primera carga: descarga modelo de voz (~60MB) desde HuggingFace.
  // Ejecuciones siguientes: cacheado en OPFS, arranque instantáneo.
  //
  const [ttsMode, setTtsMode] = useState<'audio' | 'speech'>('audio');
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  // Ref para que el fallback callback pueda acceder a los textos y callbacks actuales
  const processedTextsRef = useRef<string[]>([]);
  processedTextsRef.current = processedTexts;

  // ── Función para crear y registrar un motor TTS ──────────────────────────
  const setupEngine = useCallback((engine: TtsEngine) => {
    ttsRef.current = engine;
    const spanishVoices = engine.getSpanishVoices();
    setVoices(spanishVoices);
    const currentVoice = engine.getVoice();
    if (currentVoice) setSelectedVoice(currentVoice.name);
  }, []);

  const [piperError, setPiperError] = useState<string | null>(null);

  // ── Fallback: Piper TTS falló → cambiar a speechSynthesis ─────────────────
  const handleEdgeTtsFailed = useCallback((errorDetail?: string) => {
    console.error('[PdfListenMode] Piper TTS failed, falling back to speechSynthesis. Detail:', errorDetail);
    setPiperError(errorDetail ?? 'Unknown error');
    const keepalive = keepaliveRef.current;
    // Destruir motor de audio
    ttsRef.current?.destroy();

    // Crear motor speechSynthesis
    const fallback = createTtsEngine({ keepalive: keepalive ?? undefined });
    setupEngine(fallback);
    setTtsMode('speech');

    // Re-check voices después de un tick (speechSynthesis carga async)
    setTimeout(() => {
      const v = fallback.getSpanishVoices();
      if (v.length > 0) {
        setVoices(v);
        const cur = fallback.getVoice();
        if (cur) setSelectedVoice(cur.name);
      }
    }, 500);

    // Auto-iniciar reproducción con el motor de fallback
    const texts = processedTextsRef.current;
    if (texts.length > 0) {
      timingRef.current = { totalBaseMs: 0, totalChars: 0 };
      setEstimatedRemaining(null);
      fallback.speak(texts, {
        onBlockStart: (idx: number) => setCurrentBlock(idx),
        onBlockEnd: () => {},
        onBlockTiming: (idx: number, durationMs: number, charCount: number) => {
          if (charCount <= 0) return;
          const currentRate = fallback.getRate();
          const baseMs = durationMs * currentRate;
          const t = timingRef.current;
          t.totalBaseMs += baseMs;
          t.totalChars += charCount;
          const remaining = texts.slice(idx + 1).reduce((sum, txt) => sum + txt.length, 0);
          if (t.totalChars > 0 && remaining > 0) {
            const baseMsPerChar = t.totalBaseMs / t.totalChars;
            const remainingSecs = (remaining * baseMsPerChar) / (currentRate * 1000);
            setEstimatedRemaining(Math.round(remainingSecs));
          } else {
            setEstimatedRemaining(0);
          }
        },
        onFinish: () => {
          setTtsState('idle');
          setCurrentBlock(0);
          setEstimatedRemaining(null);
          timingRef.current = { totalBaseMs: 0, totalChars: 0 };
        },
        onError: (err: string) => console.warn('[TTS fallback]', err),
        onStateChange: (s: TtsState) => setTtsState(s),
      });
    }
  }, [setupEngine]);

  useEffect(() => {
    // Audio keepalive: Wake Lock + sesión de audio activa
    const keepalive = createAudioKeepalive();
    keepaliveRef.current = keepalive;

    // Media Session: controles en la pantalla de bloqueo
    const mediaSession = createMediaSessionController();
    mediaSessionRef.current = mediaSession;

    // Crear motor: Piper TTS neural (genera WAV real → segundo plano), speechSynthesis como fallback
    let engine: TtsEngine;
    engine = createAudioTtsEngine({
      keepalive,
      onSynthesisFailed: handleEdgeTtsFailed,
      mediaTitle: displayTitle.replace(/\.pdf$/i, ''),
      mediaArtist: subject?.name ?? 'Hypatia',
      onModelProgress: (progress) => {
        const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
        setModelProgress(ratio);
      },
      getCacheKey: () => wavCacheKeyRef.current,
    });
    setTtsMode('audio');
    setupEngine(engine);

    // Re-check voices after a short delay (speechSynthesis voices load async)
    const timer = setTimeout(() => {
      const v = engine.getSpanishVoices();
      if (v.length > 0) {
        setVoices(v);
        const cur = engine.getVoice();
        if (cur) setSelectedVoice(cur.name);
      }
    }, 500);

    return () => {
      clearTimeout(timer);

      // Si la síntesis estaba en progreso (loading), transferir al background manager
      const engineState = engine.getState();
      if (engineState === 'loading' || engineState === 'playing' || engineState === 'paused') {
        const texts = processedTextsRef.current;
        const cacheKeyVal = wavCacheKeyRef.current;
        // Transferir si hay textos y cacheKey — soportar tanto topic como resource mode
        const identifier = topicId ?? resourceFile;
        if (texts.length > 0 && cacheKeyVal && identifier) {
          const currentVoice = engine.getVoice();
          const voiceId = currentVoice?.name ?? 'es_ES-carlfm-x_low';
          const jobId = `${cacheKeyVal}:${voiceId}`;

          enqueueSynthesis({
            jobId,
            topicId: identifier,
            pdfFilename: resourceFile ?? '',
            texts,
            voiceId: voiceId as import('@mintplex-labs/piper-tts-web').VoiceId,
            cacheKey: cacheKeyVal,
            startFromBlock: 0,
          });
        }
      }

      engine.destroy();
      keepalive.destroy();
      mediaSession.cleanup();
      ttsRef.current = null;
      keepaliveRef.current = null;
      mediaSessionRef.current = null;
    };
  }, [setupEngine, handleEdgeTtsFailed]);

  // ── Update Media Session metadata on block/state changes ──────────────────
  useEffect(() => {
    const ms = mediaSessionRef.current;
    if (!ms) return;

    if (ttsState === 'idle') {
      ms.setPlaybackState('none');
    } else {
      ms.setPlaybackState(ttsState === 'playing' ? 'playing' : 'paused');
      ms.updateMetadata({
        title: displayTitle.replace(/\.pdf$/i, ''),
        artist: subject?.name ?? 'Hypatia',
        album: blocks.length > 0 ? `Bloque ${currentBlock + 1} de ${blocks.length}` : '',
      });
      // Actualizar posición para la barra de progreso de la notificación
      if (blocks.length > 0) {
        ms.setPositionState(currentBlock, blocks.length);
      }
    }
  }, [ttsState, currentBlock, displayTitle, subject?.name, blocks.length]);

  // ── Auto scroll to active block ────────────────────────────────────────────
  useEffect(() => {
    const el = blockRefs.current[currentBlock];
    if (el && ttsState !== 'idle') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentBlock, ttsState]);

  // ── TTS callbacks ──────────────────────────────────────────────────────────
  const ttsCallbacks = useCallback(
    () => ({
      onBlockStart: (idx: number) => setCurrentBlock(idx),
      onBlockEnd: (_idx: number) => {},
      onBlockTiming: (idx: number, durationMs: number, charCount: number) => {
        if (charCount <= 0) return;
        // Normalize duration to rate 1.0 so speed changes don't invalidate old data
        const currentRate = ttsRef.current?.getRate() ?? 1.0;
        const baseMs = durationMs * currentRate;
        const t = timingRef.current;
        t.totalBaseMs += baseMs;
        t.totalChars += charCount;

        // Compute remaining chars (blocks after idx)
        const remaining = processedTexts.slice(idx + 1).reduce((sum, txt) => sum + txt.length, 0);
        if (t.totalChars > 0 && remaining > 0) {
          const baseMsPerChar = t.totalBaseMs / t.totalChars;
          const remainingSecs = (remaining * baseMsPerChar) / (currentRate * 1000);
          setEstimatedRemaining(Math.round(remainingSecs));
        } else {
          setEstimatedRemaining(0);
        }
      },
      onFinish: () => {
        setTtsState('idle');
        setCurrentBlock(0);
        setEstimatedRemaining(null);
        setSynthProgress(null);
        timingRef.current = { totalBaseMs: 0, totalChars: 0 };
      },
      onError: (err: string) => {
        console.warn('[TTS]', err);
      },
      onStateChange: (s: TtsState) => {
        setTtsState(s);
        // Limpiar progreso de síntesis cuando empieza a reproducir
        if (s === 'playing') setSynthProgress(null);
      },
      onSynthesisProgress: (current: number, total: number, bytesGenerated?: number) => {
        setSynthProgress({ current, total, bytes: bytesGenerated ?? 0 });
      },
    }),
    [processedTexts],
  );

  // ── Controls ───────────────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    if (!ttsRef.current || processedTexts.length === 0) return;
    timingRef.current = { totalBaseMs: 0, totalChars: 0 };
    setEstimatedRemaining(null);
    ttsRef.current.speak(processedTexts, ttsCallbacks());
  }, [processedTexts, ttsCallbacks]);

  const handlePause = useCallback(() => ttsRef.current?.pause(), []);
  const handleResume = useCallback(() => ttsRef.current?.resume(), []);
  const handleStop = useCallback(() => {
    ttsRef.current?.stop();
    setCurrentBlock(0);
    setEstimatedRemaining(null);
    timingRef.current = { totalBaseMs: 0, totalChars: 0 };
  }, []);
  const handleNext = useCallback(() => ttsRef.current?.next(), []);
  const handlePrevious = useCallback(() => ttsRef.current?.previous(), []);

  const handleRateChange = useCallback((newRate: number) => {
    setRate(newRate);
    ttsRef.current?.setRate(newRate);
  }, []);

  const handleVoiceChange = useCallback((name: string) => {
    setSelectedVoice(name);
    ttsRef.current?.setVoice(name);
  }, []);

  const handleSkipTo = useCallback(
    (idx: number) => {
      if (ttsState === 'idle') {
        // Start playing from that block
        if (!ttsRef.current || processedTexts.length === 0) return;
        ttsRef.current.speak(processedTexts, ttsCallbacks());
        // Wait a tick then skip
        setTimeout(() => ttsRef.current?.skipTo(idx), 50);
      } else {
        ttsRef.current?.skipTo(idx);
      }
    },
    [ttsState, processedTexts, ttsCallbacks],
  );

  // ── Wire Media Session handlers (after handlePlay is defined) ──────────────
  useEffect(() => {
    const ms = mediaSessionRef.current;
    if (!ms) return;

    ms.setHandlers({
      onPlay: () => {
        const s = ttsRef.current?.getState();
        if (s === 'paused') {
          ttsRef.current!.resume();
        } else if (s === 'idle' && processedTexts.length > 0) {
          handlePlay();
        }
      },
      onPause: () => ttsRef.current?.pause(),
      onNextTrack: () => ttsRef.current?.next(),
      onPreviousTrack: () => ttsRef.current?.previous(),
      onStop: () => ttsRef.current?.stop(),
      onSeekTo: (time: number) => {
        const blockIdx = Math.max(0, Math.min(Math.floor(time), (processedTexts.length || 1) - 1));
        ttsRef.current?.skipTo(blockIdx);
      },
    });
  }, [processedTexts, handlePlay]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (ttsState === 'idle') handlePlay();
          else if (ttsState === 'playing') handlePause();
          else if (ttsState === 'paused') handleResume();
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleNext();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handlePrevious();
          break;
        case '+':
        case '=':
          e.preventDefault();
          handleRateChange(Math.min(2.0, rate + 0.25));
          break;
        case '-':
          e.preventDefault();
          handleRateChange(Math.max(0.5, rate - 0.25));
          break;
        case 'Escape':
          e.preventDefault();
          handleStop();
          navigate(-1);
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [ttsState, rate, handlePlay, handlePause, handleResume, handleNext, handlePrevious, handleRateChange, handleStop, navigate]);

  // ── Check TTS support ────────────────────────────────────────────────────
  // Audio engine (Piper TTS WASM) funciona en cualquier navegador moderno con WASM.
  // Speech engine necesita speechSynthesis.
  const speechSupported =
    ttsMode === 'audio' ||
    (typeof window !== 'undefined' && 'speechSynthesis' in window);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Loading state
  if (loading && !extracting) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-400 text-sm animate-pulse">Cargando…</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Header title={displayTitle} onBack={() => navigate(-1)} />
        <div className="max-w-3xl mx-auto p-6">
          <EmptyState
            icon={<span className="text-3xl">⚠️</span>}
            title="Error"
            description={error}
          />
          <div className="text-center mt-4">
            <button
              onClick={() => window.location.reload()}
              className="text-sm text-amber-400 hover:text-amber-300 underline"
            >
              Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // No PDF for topic
  if (!isResourceMode && (!topic?.pdfFilename)) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Header title={displayTitle} onBack={() => navigate(-1)} />
        <div className="max-w-3xl mx-auto p-6">
          <EmptyState
            icon={<span className="text-3xl">📄</span>}
            title="Sin PDF asociado"
            description="Este tema no tiene un PDF vinculado. Añade un PDF desde la vista de asignatura."
          />
        </div>
      </div>
    );
  }

  // Web Speech API not supported
  if (!speechSupported) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Header title={displayTitle} onBack={() => navigate(-1)} />
        <div className="max-w-3xl mx-auto p-6">
          <EmptyState
            icon={<span className="text-3xl">🔇</span>}
            title="TTS no soportado"
            description="Tu navegador no soporta Web Speech API. Usa Chrome, Edge o Safari para esta funcionalidad."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 flex flex-col">
      <Header title={displayTitle} onBack={() => { handleStop(); navigate(-1); }} />

      {/* Main content */}
      <main ref={containerRef} className="flex-1 overflow-y-auto pb-20">
        <div className="max-w-3xl mx-auto px-4 py-6">
          {/* Extraction progress */}
          {extracting && (
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm text-ink-300 animate-pulse">Extrayendo texto…</span>
                <span className="text-xs text-ink-500 font-mono">
                  {Math.round(extractProgress * 100)}%
                </span>
              </div>
              <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-300"
                  style={{ width: `${extractProgress * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Model download progress (first-time Piper TTS load) */}
          {modelProgress !== null && modelProgress < 1 && (
            <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm text-blue-300 animate-pulse">Descargando modelo de voz…</span>
                <span className="text-xs text-blue-400 font-mono">
                  {Math.round(modelProgress * 100)}%
                </span>
              </div>
              <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${modelProgress * 100}%` }}
                />
              </div>
              <p className="text-[10px] text-blue-400/60 mt-1">Primera vez: ~27MB. Se cachea para siguiente uso.</p>
            </div>
          )}

          {/* Synthesis progress (pre-generating concatenated audio) */}
          {synthProgress && synthProgress.current < synthProgress.total && (
            <div className="mb-4 p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm text-purple-300 animate-pulse">Preparando audio…</span>
                <span className="text-xs text-purple-400 font-mono">
                  Bloque {synthProgress.current} de {synthProgress.total}
                </span>
                {synthProgress.bytes > 0 && (
                  <span className="text-[10px] text-purple-400/70 font-mono ml-auto">
                    {synthProgress.bytes < 1024 * 1024
                      ? `${(synthProgress.bytes / 1024).toFixed(0)} KB`
                      : `${(synthProgress.bytes / (1024 * 1024)).toFixed(1)} MB`}
                    {synthProgress.current > 0 && (
                      <> · ~{((synthProgress.bytes / synthProgress.current) * synthProgress.total / (1024 * 1024)).toFixed(1)} MB total</>
                    )}
                  </span>
                )}
              </div>
              <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-300"
                  style={{ width: `${(synthProgress.current / synthProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-[10px] text-purple-400/60 mt-1">
                Generando audio continuo para reproducción en segundo plano.
                {wavCacheKeyRef.current ? ' Se cacheará para uso futuro.' : ''}
              </p>
            </div>
          )}

          {/* Piper TTS error detail (for debugging) */}
          {piperError && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-xs text-red-400 font-medium mb-1">Piper TTS falló → usando voz del sistema</p>
              <p className="text-[10px] text-red-400/70 font-mono break-all">{piperError}</p>
            </div>
          )}

          {/* No voices warning */}
          {!extracting && voices.length === 0 && blocks.length > 0 && (
            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <p className="text-xs text-amber-400">
                No se encontraron voces en español. La lectura usará la voz por defecto del sistema.
              </p>
            </div>
          )}

          {/* TTS mode toggle */}
          {!extracting && blocks.length > 0 && (
            <div className="mb-4 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => {
                  if (ttsState !== 'idle') return; // No cambiar durante reproducción
                  if (ttsMode === 'audio') {
                    // Cambiar a bloques (speechSynthesis)
                    ttsRef.current?.destroy();
                    const keepalive = keepaliveRef.current;
                    const fallback = createTtsEngine({ keepalive: keepalive ?? undefined });
                    setupEngine(fallback);
                    setTtsMode('speech');
                    setTimeout(() => {
                      const v = fallback.getSpanishVoices();
                      if (v.length > 0) {
                        setVoices(v);
                        const cur = fallback.getVoice();
                        if (cur) setSelectedVoice(cur.name);
                      }
                    }, 300);
                  } else {
                    // Cambiar a concatenado (Piper TTS)
                    ttsRef.current?.destroy();
                    const keepalive = keepaliveRef.current;
                    const engine = createAudioTtsEngine({
                      keepalive: keepalive ?? undefined,
                      onSynthesisFailed: handleEdgeTtsFailed,
                      mediaTitle: displayTitle.replace(/\.pdf$/i, ''),
                      mediaArtist: subject?.name ?? 'Hypatia',
                      onModelProgress: (progress) => {
                        const ratio = progress.total > 0 ? progress.loaded / progress.total : 0;
                        setModelProgress(ratio);
                      },
                      getCacheKey: () => wavCacheKeyRef.current,
                    });
                    setupEngine(engine);
                    setTtsMode('audio');
                  }
                }}
                disabled={ttsState !== 'idle'}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
                  ttsMode === 'audio'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                } ${ttsState !== 'idle' ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80 cursor-pointer'}`}
                title={ttsState !== 'idle' ? 'Detén la reproducción para cambiar de modo' : 'Cambiar modo de reproducción'}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {ttsMode === 'audio' ? 'Audio continuo · 2º plano' : 'Por bloques · 1er plano'}
              </button>
              <span className="text-[9px] text-ink-600">
                {ttsState === 'idle' ? 'Toca para cambiar' : ''}
              </span>
            </div>
          )}

          {/* Text blocks */}
          {blocks.map((block, idx) => {
            const isActive = idx === currentBlock && ttsState !== 'idle';

            return (
              <div
                key={idx}
                ref={(el) => { blockRefs.current[idx] = el; }}
                onClick={() => handleSkipTo(idx)}
                className={`
                  mb-3 px-4 py-3 rounded-lg cursor-pointer transition-all duration-200
                  border
                  ${isActive
                    ? 'border-amber-500/50 bg-ink-800/80 ring-1 ring-amber-500/20 shadow-lg shadow-amber-500/5'
                    : 'border-transparent hover:border-ink-700 hover:bg-ink-900/50'
                  }
                  ${block.type === 'math' ? 'bg-blue-500/5' : ''}
                  ${block.type === 'table' ? 'bg-emerald-500/5' : ''}
                  ${block.type === 'callout' ? 'bg-red-500/8 border-red-500/20' : ''}
                `}
              >
                {/* Block type indicator */}
                <div className="flex items-start gap-2">
                  {block.type === 'math' && (
                    <span className="text-xs text-blue-400 mt-0.5 shrink-0" title="Fórmula">🔢</span>
                  )}
                  {block.type === 'heading' && (
                    <span className="text-xs text-amber-500 mt-0.5 shrink-0" title="Título">§</span>
                  )}
                  {block.type === 'list' && (
                    <span className="text-xs text-sage-400 mt-0.5 shrink-0" title="Lista">☰</span>
                  )}
                  {block.type === 'table' && (
                    <span className="text-xs text-emerald-400 mt-0.5 shrink-0" title="Tabla">⊞</span>
                  )}
                  {block.type === 'callout' && (
                    <span className="text-xs text-red-400 mt-0.5 shrink-0" title="Importante">⚠</span>
                  )}

                  <p
                    className={`
                      text-sm leading-relaxed flex-1
                      ${block.type === 'heading'
                        ? 'font-display text-lg text-ink-100 font-semibold'
                        : block.type === 'math'
                          ? 'text-ink-200 font-mono text-xs'
                          : block.type === 'table'
                            ? 'text-ink-200 text-xs whitespace-pre-line'
                            : block.type === 'callout'
                              ? 'text-red-300 text-sm font-medium'
                              : 'text-ink-300'
                      }
                    `}
                  >
                    {block.text}
                  </p>

                  {/* Page indicator */}
                  <span className="text-[10px] text-ink-600 shrink-0 mt-1">
                    p.{block.pageIndex + 1}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Empty state after extraction */}
          {!extracting && !loading && blocks.length === 0 && !error && (
            <EmptyState
              icon={<span className="text-3xl">📝</span>}
              title="Sin texto extraíble"
              description="No se pudo extraer texto de este PDF. Puede que sea un PDF escaneado (imagen)."
            />
          )}
        </div>
      </main>

      {/* TTS Controls */}
      {blocks.length > 0 && (
        <TtsControls
          state={ttsState}
          currentBlock={currentBlock}
          totalBlocks={blocks.length}
          rate={rate}
          voiceName={selectedVoice}
          voices={voices}
          estimatedRemaining={estimatedRemaining}
          onPlay={handlePlay}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onRateChange={handleRateChange}
          onVoiceChange={handleVoiceChange}
          onSkipTo={handleSkipTo}
        />
      )}
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────────

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="sticky top-0 z-20 bg-ink-950/95 backdrop-blur border-b border-ink-800 px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-ink-400 hover:text-ink-200 transition-colors"
          title="Volver (Esc)"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 4L7 10L13 16" />
          </svg>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">🎧</span>
          <h1 className="font-display text-ink-100 text-lg truncate">
            Escucha — {title}
          </h1>
        </div>
      </div>
    </header>
  );
}
