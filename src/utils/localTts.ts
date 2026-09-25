/**
 * localTts.ts
 *
 * Motor TTS 100% local usando meSpeak (eSpeak compilado a JS vía Emscripten).
 * Genera audio WAV real en el navegador sin ninguna petición de red.
 *
 * El audio WAV generado se puede reproducir a través de un <audio> element,
 * lo que permite:
 *   - Reproducción en segundo plano en Android (el tab se mantiene vivo)
 *   - Notificación de media con controles play/pause
 *   - Funciona 100% offline
 *
 * La voz es sintética (tipo robot) pero es el único enfoque que:
 *   1. No depende de APIs externas (Google TTS devuelve 403)
 *   2. No depende de WebSocket (Edge TTS rechaza Origin del navegador)
 *   3. Genera audio REAL reproducible por <audio> (speechSynthesis no lo hace)
 */

// meSpeak es CommonJS; Vite lo convierte a ESM automáticamente
// eslint-disable-next-line @typescript-eslint/no-require-imports
import meSpeak from 'mespeak';
import mespeakConfig from 'mespeak/src/mespeak_config.json';
import esVoice from 'mespeak/voices/es.json';

// ─── State ───────────────────────────────────────────────────────────────────────

let initialized = false;

// ─── Initialization ──────────────────────────────────────────────────────────────

/**
 * Inicializa meSpeak con la configuración y la voz española.
 * Es idempotente: llamar múltiples veces no tiene efecto.
 */
export function initLocalTts(): boolean {
  if (initialized) return true;
  try {
    meSpeak.loadConfig(mespeakConfig);
    meSpeak.loadVoice(esVoice);
    initialized = true;
    return true;
  } catch (err) {
    console.error('[localTts] Error initializing meSpeak:', err);
    return false;
  }
}

/**
 * Indica si meSpeak está listo para sintetizar.
 */
export function isLocalTtsReady(): boolean {
  return initialized;
}

// ─── Synthesis ───────────────────────────────────────────────────────────────────

export interface SynthesisOptions {
  /** Velocidad de habla. Rango: 80–450, default: 175 */
  speed?: number;
  /** Tono. Rango: 0–99, default: 50 */
  pitch?: number;
  /** Amplitud. Rango: 0–200, default: 100 */
  amplitude?: number;
  /** Variante de voz (p.ej. 'f2' para femenina, 'm3' para masculina grave) */
  variant?: string;
}

/**
 * Sintetiza texto a audio WAV.
 * Retorna un Blob con los datos WAV, listo para crear una URL con createObjectURL.
 *
 * @param text   Texto a sintetizar
 * @param opts   Opciones de síntesis
 * @returns      Blob WAV, o null si falla
 */
export function synthesizeToBlob(text: string, opts?: SynthesisOptions): Blob | null {
  if (!initialized) {
    if (!initLocalTts()) return null;
  }

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    // meSpeak.speak con rawdata: true devuelve ArrayBuffer (WAV)
    const result = meSpeak.speak(trimmed, {
      rawdata: true,
      voice: 'es',
      speed: opts?.speed ?? 175,
      pitch: opts?.pitch ?? 50,
      amplitude: opts?.amplitude ?? 100,
      variant: opts?.variant,
    });

    if (!result || typeof result === 'number') {
      console.warn('[localTts] meSpeak returned null/number for text:', trimmed.substring(0, 50));
      return null;
    }

    // result es ArrayBuffer cuando rawdata: true
    return new Blob([result as ArrayBuffer], { type: 'audio/wav' });
  } catch (err) {
    console.error('[localTts] Synthesis error:', err);
    return null;
  }
}

/**
 * Sintetiza texto y devuelve una URL blob reproducible por un <audio> element.
 * IMPORTANTE: El caller es responsable de llamar URL.revokeObjectURL() cuando
 * ya no necesite la URL.
 */
export function synthesizeToBlobUrl(text: string, opts?: SynthesisOptions): string | null {
  const blob = synthesizeToBlob(text, opts);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

// ─── Utility ─────────────────────────────────────────────────────────────────────

/**
 * Convierte una velocidad de speechSynthesis (0.5–2.0) a la escala de meSpeak (80–450).
 * speechSynthesis rate=1.0 ≈ meSpeak speed=175
 */
export function rateToMespeakSpeed(rate: number): number {
  // Mapeo lineal: rate 0.5 → speed 90, rate 1.0 → speed 175, rate 2.0 → speed 350
  const speed = Math.round(175 * rate);
  return Math.max(80, Math.min(450, speed));
}
