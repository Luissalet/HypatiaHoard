/**
 * ttsEngine.ts
 *
 * Wrapper sobre Web Speech API con:
 *   - Selección de voz española (prioriza Google/MS neural)
 *   - Control de reproducción (play/pause/skip/velocidad)
 *   - Callbacks para sincronizar UI
 *   - Audio keep-alive opcional para reproducción en segundo plano (móvil)
 *   - Auto-resume en background: detecta cuándo Chrome Android suspende
 *     speechSynthesis al minimizar el navegador y lo re-resume periódicamente.
 */

import type { AudioKeepaliveManager } from './audioKeepalive';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TtsVoiceInfo {
  name: string;
  lang: string;
  /** Indica si es una voz "premium" (Google/MS neural) */
  quality: 'standard' | 'enhanced';
}

export interface TtsCallbacks {
  onBlockStart?: (blockIndex: number) => void;
  onBlockEnd?: (blockIndex: number) => void;
  /** Fired after each block finishes with its real duration and character count */
  onBlockTiming?: (blockIndex: number, durationMs: number, charCount: number) => void;
  onFinish?: () => void;
  onError?: (error: string) => void;
  onStateChange?: (state: TtsState) => void;
  /** Progreso de síntesis (para motores que pre-sintetizan todo el audio).
   *  bytesGenerated = bytes acumulados de WAV generado hasta ahora. */
  onSynthesisProgress?: (current: number, total: number, bytesGenerated?: number) => void;
}

export type TtsState = 'idle' | 'playing' | 'paused' | 'loading';

export interface TtsEngine {
  getSpanishVoices(): TtsVoiceInfo[];
  setVoice(voiceName: string): void;
  getVoice(): TtsVoiceInfo | null;
  setRate(rate: number): void;
  getRate(): number;
  speak(blocks: string[], callbacks?: TtsCallbacks): void;
  pause(): void;
  resume(): void;
  stop(): void;
  skipTo(blockIndex: number): void;
  next(): void;
  previous(): void;
  getState(): TtsState;
  getCurrentBlockIndex(): number;
  destroy(): void;
}

// ─── Implementation ────────────────────────────────────────────────────────────

function voiceQualityScore(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  if (name.includes('google')) return 100;
  if (name.includes('microsoft') && (name.includes('neural') || name.includes('online'))) return 90;
  if (name.includes('microsoft')) return 70;
  if (voice.localService === false) return 60;
  if (name.includes('monica') || name.includes('jorge') || name.includes('paulina')) return 50;
  return 10;
}

function pickBestSpanishVoice(allVoices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const spanish = allVoices.filter((v) => v.lang.startsWith('es'));
  if (spanish.length === 0) return allVoices[0] ?? null;

  const prioritized = [...spanish].sort((a, b) => voiceQualityScore(b) - voiceQualityScore(a));
  return prioritized[0];
}

export interface TtsEngineOptions {
  /** Audio keep-alive para reproducción en segundo plano en móvil */
  keepalive?: AudioKeepaliveManager;
}

/**
 * Intervalo (ms) para re-resumir speechSynthesis en background.
 * Chrome Android suspende speechSynthesis al minimizar el navegador.
 * Llamar resume() periódicamente lo mantiene activo.
 */
const BG_RESUME_INTERVAL_MS = 3000;

export function createTtsEngine(options?: TtsEngineOptions): TtsEngine {
  const keepalive = options?.keepalive;
  const synth = window.speechSynthesis;
  let voices: SpeechSynthesisVoice[] = [];
  let selectedVoice: SpeechSynthesisVoice | null = null;
  let rate = 1.0;
  let state: TtsState = 'idle';
  let blocks: string[] = [];
  let currentBlockIndex = 0;
  let callbacks: TtsCallbacks = {};
  let destroyed = false;
  let blockStartTime = 0;

  // ── Background resume state ─────────────────────────────────────────────
  let bgResumeInterval: ReturnType<typeof setInterval> | null = null;
  /** Track whether the user intentionally paused (not the browser) */
  let userPaused = false;

  // ── Load voices ────────────────────────────────────────────────────────────
  function loadVoices() {
    voices = synth.getVoices();
    if (!selectedVoice) {
      selectedVoice = pickBestSpanishVoice(voices);
    }
  }

  loadVoices();
  if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = loadVoices;
  }

  // ── Background resume logic ─────────────────────────────────────────────
  /**
   * Cuando el navegador va a background y speechSynthesis está reproduciendo,
   * Chrome lo pausa automáticamente. Este interval lo re-resume periódicamente.
   *
   * También re-dispara la utterance actual si se detecta que se ha detenido
   * completamente (algunos dispositivos cancelan en vez de pausar).
   */
  function startBgResumeInterval() {
    stopBgResumeInterval();
    bgResumeInterval = setInterval(() => {
      if (destroyed || state !== 'playing' || userPaused) return;

      // Si synth reporta que está pausado pero nosotros estamos "playing",
      // significa que el navegador lo pausó → resumir
      if (synth.paused) {
        synth.resume();
      }

      // Algunos navegadores cancelan la utterance por completo en background.
      // Si synth no está hablando ni pausado y nosotros creemos que está playing,
      // re-disparar el bloque actual.
      if (!synth.speaking && !synth.paused && !synth.pending) {
        speakBlock(currentBlockIndex);
      }
    }, BG_RESUME_INTERVAL_MS);
  }

  function stopBgResumeInterval() {
    if (bgResumeInterval != null) {
      clearInterval(bgResumeInterval);
      bgResumeInterval = null;
    }
  }

  /**
   * Handler de visibilitychange: cuando el tab se oculta durante reproducción,
   * activa el interval de resume. Cuando vuelve al foreground, fuerza un resume
   * inmediato y limpia el interval.
   */
  function onVisibilityChange() {
    if (destroyed) return;

    if (document.visibilityState === 'hidden' && state === 'playing') {
      // Entrando a background con TTS activo → activar interval de resume
      startBgResumeInterval();
    } else if (document.visibilityState === 'visible') {
      stopBgResumeInterval();
      // Forzar resume inmediato al volver al foreground
      if (state === 'playing' && !userPaused) {
        if (synth.paused) {
          synth.resume();
        }
        // Si synth murió completamente en background, re-lanzar bloque
        if (!synth.speaking && !synth.paused && !synth.pending) {
          speakBlock(currentBlockIndex);
        }
      }
    }
  }

  // Registrar listener de visibilitychange
  document.addEventListener('visibilitychange', onVisibilityChange);

  // ── Speak a single block ───────────────────────────────────────────────────
  function speakBlock(index: number) {
    if (destroyed) return;
    if (index >= blocks.length) {
      state = 'idle';
      userPaused = false;
      stopBgResumeInterval();
      keepalive?.stop();
      callbacks.onFinish?.();
      callbacks.onStateChange?.('idle');
      return;
    }

    currentBlockIndex = index;
    blockStartTime = performance.now();
    callbacks.onBlockStart?.(index);

    const text = blocks[index];
    if (!text.trim()) {
      // Skip empty blocks
      callbacks.onBlockEnd?.(index);
      setTimeout(() => {
        if (state === 'playing') speakBlock(index + 1);
      }, 100);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.lang = 'es-ES';
    utterance.rate = rate;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      if (destroyed) return;
      // Report timing for estimation
      const elapsed = performance.now() - blockStartTime;
      callbacks.onBlockTiming?.(index, elapsed, text.length);
      callbacks.onBlockEnd?.(index);
      // Encadenar inmediatamente al siguiente bloque
      if (state === 'playing' && !destroyed) {
        speakBlock(index + 1);
      }
    };

    utterance.onerror = (event) => {
      if (destroyed) return;
      // 'interrupted' and 'canceled' are normal (skip/stop)
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        callbacks.onError?.(`Error TTS: ${event.error}`);
      }
    };

    synth.speak(utterance);
  }

  return {
    getSpanishVoices() {
      return voices
        .filter((v) => v.lang.startsWith('es'))
        .map((v) => ({
          name: v.name,
          lang: v.lang,
          quality: voiceQualityScore(v) >= 60 ? ('enhanced' as const) : ('standard' as const),
        }));
    },

    setVoice(voiceName: string) {
      selectedVoice = voices.find((v) => v.name === voiceName) ?? selectedVoice;
    },

    getVoice() {
      if (!selectedVoice) return null;
      return {
        name: selectedVoice.name,
        lang: selectedVoice.lang,
        quality: voiceQualityScore(selectedVoice) >= 60 ? ('enhanced' as const) : ('standard' as const),
      };
    },

    setRate(r: number) {
      rate = Math.max(0.5, Math.min(2.0, r));
    },
    getRate() {
      return rate;
    },

    speak(newBlocks: string[], cbs?: TtsCallbacks) {
      synth.cancel();
      blocks = newBlocks;
      callbacks = cbs ?? {};
      currentBlockIndex = 0;
      state = 'playing';
      userPaused = false;
      keepalive?.start();
      callbacks.onStateChange?.('playing');
      speakBlock(0);

      // Si ya estamos en background, activar interval de resume inmediatamente
      if (document.visibilityState === 'hidden') {
        startBgResumeInterval();
      }
    },

    pause() {
      if (state === 'playing') {
        userPaused = true;
        synth.pause();
        state = 'paused';
        stopBgResumeInterval();
        callbacks.onStateChange?.('paused');
      }
    },

    resume() {
      if (state === 'paused') {
        userPaused = false;
        synth.resume();
        state = 'playing';
        callbacks.onStateChange?.('playing');
        // Re-activar interval si estamos en background
        if (document.visibilityState === 'hidden') {
          startBgResumeInterval();
        }
      }
    },

    stop() {
      synth.cancel();
      state = 'idle';
      currentBlockIndex = 0;
      userPaused = false;
      stopBgResumeInterval();
      keepalive?.stop();
      callbacks.onStateChange?.('idle');
    },

    skipTo(blockIndex: number) {
      if (blockIndex < 0 || blockIndex >= blocks.length) return;
      synth.cancel();
      state = 'playing';
      userPaused = false;
      callbacks.onStateChange?.('playing');
      speakBlock(blockIndex);
    },

    next() {
      if (currentBlockIndex < blocks.length - 1) {
        synth.cancel();
        state = 'playing';
        speakBlock(currentBlockIndex + 1);
      }
    },

    previous() {
      if (currentBlockIndex > 0) {
        synth.cancel();
        state = 'playing';
        speakBlock(currentBlockIndex - 1);
      }
    },

    getState() {
      return state;
    },
    getCurrentBlockIndex() {
      return currentBlockIndex;
    },

    destroy() {
      destroyed = true;
      synth.cancel();
      state = 'idle';
      userPaused = false;
      stopBgResumeInterval();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      keepalive?.stop();
      blocks = [];
      callbacks = {};
    },
  };
}
