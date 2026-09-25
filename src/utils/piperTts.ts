/**
 * piperTts.ts
 *
 * Motor TTS neural usando Piper (VITS) ejecutado 100% en el navegador vía WASM.
 *
 * Problema resuelto: Brave Android bloquea OPFS (Origin Private File System),
 * que es lo que usa @mintplex-labs/piper-tts-web para cachear modelos.
 * Sin cache, cada sesión re-descarga el modelo.
 *
 * Solución:
 *   1. Descargar modelo nosotros con reintentos (3 intentos, backoff exponencial)
 *   2. Cachear en IndexedDB (funciona en Brave, Chrome, todos los navegadores)
 *   3. Interceptar fetch() durante TtsSession.create() para servir los blobs
 *      desde memoria → la librería no re-descarga, sin doble tráfico
 *   4. También intentar OPFS (por si funciona en otros navegadores)
 *
 * Primera ejecución: descarga ~27MB (modelo x_low) + WASM deps de CDN.
 * Ejecuciones siguientes: cacheado en IndexedDB, arranque instantáneo.
 */

import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { VoiceId, ProgressCallback } from '@mintplex-labs/piper-tts-web';

// ─── HuggingFace base (must match the library's HF_BASE) ───────────────────

const HF_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';

/**
 * Map of voiceId → relative path (must match the library's PATH_MAP).
 * Only Spanish voices we actually use.
 */
const VOICE_PATHS: Record<string, string> = {
  'es_ES-carlfm-x_low': 'es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx',
  'es_ES-davefx-medium': 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx',
  'es_ES-sharvard-medium': 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx',
  'es_ES-mls_10246-low': 'es/es_ES/mls_10246/low/es_ES-mls_10246-low.onnx',
  'es_MX-ald-medium': 'es/es_MX/ald/medium/es_MX-ald-medium.onnx',
  'es_MX-claude-high': 'es/es_MX/claude/high/es_MX-claude-high.onnx',
};

// ─── Available Spanish voices ────────────────────────────────────────────────

export interface PiperVoiceOption {
  id: VoiceId;
  label: string;
  quality: string;
  sizeHint: string;
}

export const SPANISH_VOICES: PiperVoiceOption[] = [
  { id: 'es_ES-carlfm-x_low', label: 'Carl (España, ligera)', quality: 'baja', sizeHint: '~27MB' },
  { id: 'es_ES-mls_10246-low', label: 'MLS 10246 (España)', quality: 'baja', sizeHint: '~30MB' },
  { id: 'es_ES-davefx-medium', label: 'Dave (España)', quality: 'media', sizeHint: '~60MB' },
  { id: 'es_ES-sharvard-medium', label: 'Sharvard (España)', quality: 'media', sizeHint: '~60MB' },
  { id: 'es_MX-ald-medium', label: 'Ald (México)', quality: 'media', sizeHint: '~60MB' },
  { id: 'es_MX-claude-high', label: 'Claude (México, alta)', quality: 'alta', sizeHint: '~90MB' },
];

export const DEFAULT_VOICE_ID: VoiceId = 'es_ES-carlfm-x_low';

// ─── In-memory blob cache (used to intercept fetch during TtsSession.create) ─

const blobCache = new Map<string, Blob>();

// ─── IndexedDB cache (persistent, works on Brave unlike OPFS) ────────────────

const IDB_NAME = 'piper-tts-cache';
const IDB_STORE = 'models';
const IDB_VERSION = 1;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<Blob | undefined> {
  try {
    const db = await openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(blob, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[piperTts] IDB write failed:', e);
  }
}

// ─── OPFS cache (fallback, doesn't work on Brave) ───────────────────────────

async function opfsWrite(filename: string, blob: Blob): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('piper', { create: true });
  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ─── Robust download with retry ─────────────────────────────────────────────

async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    return await res.blob();
  }

  const contentLength = +(res.headers.get('Content-Length') ?? 0);
  let receivedLength = 0;
  const chunks: BlobPart[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedLength += value.length;
    onProgress?.(receivedLength, contentLength);
  }

  if (contentLength > 0 && receivedLength < contentLength) {
    throw new Error(
      `Incomplete download: got ${receivedLength} of ${contentLength} bytes`,
    );
  }

  return new Blob(chunks, { type: res.headers.get('Content-Type') ?? undefined });
}

async function fetchWithRetry(
  url: string,
  maxAttempts: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchWithProgress(url, onProgress);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[piperTts] Download attempt ${attempt}/${maxAttempts} failed:`,
        lastError.message,
      );
      if (attempt < maxAttempts) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error('Download failed');
}

// ─── Pre-download and cache model ───────────────────────────────────────────

/**
 * Ensure the model is downloaded and cached. Uses IndexedDB (works on Brave)
 * as primary cache, with OPFS as bonus (for browsers that support it).
 * Also stores blobs in memory for the fetch interceptor.
 */
async function ensureModelCached(
  voiceId: VoiceId,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  const path = VOICE_PATHS[voiceId];
  if (!path) {
    console.error(`[piperTts] Unknown voice: ${voiceId}`);
    return false;
  }

  const onnxUrl = `${HF_BASE}/${path}`;
  const jsonUrl = `${onnxUrl}.json`;

  const onnxParts = onnxUrl.split('/');
  const jsonParts = jsonUrl.split('/');
  const onnxFilename = onnxParts[onnxParts.length - 1];
  const jsonFilename = jsonParts[jsonParts.length - 1];

  // Check IndexedDB cache first
  let onnxBlob = await idbGet(onnxFilename);
  let jsonBlob = await idbGet(jsonFilename);

  if (onnxBlob && jsonBlob) {
    console.log(`[piperTts] Model ${voiceId} loaded from IndexedDB cache`);
    // Put in memory cache for fetch interceptor
    blobCache.set(onnxUrl, onnxBlob);
    blobCache.set(jsonUrl, jsonBlob);
    return true;
  }

  // Download what's missing
  try {
    const [freshOnnx, freshJson] = await Promise.all([
      onnxBlob
        ? Promise.resolve(null)
        : fetchWithRetry(onnxUrl, 3, (loaded, total) => {
            onProgress?.({ url: onnxUrl, total, loaded });
          }),
      jsonBlob ? Promise.resolve(null) : fetchWithRetry(jsonUrl, 3),
    ]);

    if (freshOnnx) onnxBlob = freshOnnx;
    if (freshJson) jsonBlob = freshJson;

    // Cache in IndexedDB (primary, works on Brave)
    if (freshOnnx) await idbPut(onnxFilename, freshOnnx);
    if (freshJson) await idbPut(jsonFilename, freshJson);

    // Also try OPFS (bonus, doesn't work on Brave but helps on Chrome)
    try {
      if (freshOnnx) await opfsWrite(onnxFilename, freshOnnx);
      if (freshJson) await opfsWrite(jsonFilename, freshJson);
    } catch {
      // OPFS not available (Brave) — that's fine, IndexedDB has it
    }

    // Put in memory cache for fetch interceptor
    if (onnxBlob) blobCache.set(onnxUrl, onnxBlob);
    if (jsonBlob) blobCache.set(jsonUrl, jsonBlob);

    console.log(`[piperTts] Model ${voiceId} downloaded and cached`);
    return true;
  } catch (err) {
    console.error(`[piperTts] Failed to download model ${voiceId}:`, err);
    return false;
  }
}

// ─── Fetch interceptor ──────────────────────────────────────────────────────
//
// During TtsSession.create(), the library calls fetch() for the model files.
// We intercept those calls and serve from our in-memory cache instead,
// avoiding a second download (especially important since OPFS is broken on Brave).

function installFetchInterceptor(): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    const cached = blobCache.get(url);
    if (cached) {
      console.log(`[piperTts] Serving from cache: ${url.split('/').pop()}`);
      return new Response(cached, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': cached.type || 'application/octet-stream',
          'Content-Length': String(cached.size),
        },
      });
    }

    return originalFetch(input, init);
  };

  // Return cleanup function
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ─── State ──────────────────────────────────────────────────────────────────

let session: TtsSession | null = null;
let sessionVoiceId: VoiceId | null = null;
let initPromise: Promise<boolean> | null = null;

// ─── Initialization ─────────────────────────────────────────────────────────

export async function initPiperTts(
  voiceId: VoiceId = DEFAULT_VOICE_ID,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  // session.ready is always false (library bug) — check session exists instead
  if (session && sessionVoiceId === voiceId) return true;

  if (initPromise && sessionVoiceId === voiceId) {
    return initPromise;
  }

  if (session && sessionVoiceId !== voiceId) {
    session = null;
    sessionVoiceId = null;
  }

  sessionVoiceId = voiceId;
  initPromise = _doInit(voiceId, onProgress);
  const result = await initPromise;
  initPromise = null;
  return result;
}

async function _doInit(
  voiceId: VoiceId,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  // Step 1: Download and cache model (IndexedDB + memory)
  const cached = await ensureModelCached(voiceId, onProgress);
  if (!cached) {
    console.error('[piperTts] Could not cache model');
    // Still try — library will attempt its own download
  }

  // Step 2: Install fetch interceptor so library gets our cached blobs
  const removeFetchInterceptor = installFetchInterceptor();

  try {
    // Step 3: Create TTS session
    console.log('[piperTts] Creating TtsSession...');
    session = await TtsSession.create({
      voiceId,
      progress: onProgress,
    });
    // NOTE: session.ready is ALWAYS false due to a bug in piper-tts-web
    // (it's initialized to false and never set to true).
    // If TtsSession.create() resolves without throwing, the session works.
    console.log('[piperTts] TtsSession created successfully');
    return true;
  } catch (err) {
    console.error('[piperTts] TtsSession.create failed:', err);
    session = null;
    sessionVoiceId = null;
    // Re-throw with detail so the caller can show it
    throw new Error(
      `TtsSession.create: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Step 4: Always restore original fetch
    removeFetchInterceptor();
  }
}

export function isPiperReady(): boolean {
  // session.ready is always false (library bug), so we check if session exists
  return session !== null;
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

// Mutex para serializar llamadas a session.predict().
// Piper WASM no es thread-safe: si backgroundSynthesis y audioTtsEngine
// llaman a predict() concurrentemente, la sesión crashea.
let _synthLock: Promise<void> = Promise.resolve();

export async function synthesizeToBlob(text: string): Promise<Blob | null> {
  if (!session) {
    console.warn('[piperTts] Session not initialized');
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) return null;

  // Serializar: esperar a que termine la síntesis anterior
  let release: () => void;
  const prev = _synthLock;
  _synthLock = new Promise<void>((res) => { release = res; });
  await prev;

  try {
    if (!session) return null; // pudo destruirse mientras esperábamos
    return await session.predict(trimmed);
  } catch (err) {
    console.error('[piperTts] Synthesis error:', err);
    return null;
  } finally {
    release!();
  }
}

export async function synthesizeToBlobUrl(text: string): Promise<string | null> {
  const blob = await synthesizeToBlob(text);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}
