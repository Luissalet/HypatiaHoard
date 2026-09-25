/**
 * backgroundSynthesis.ts
 *
 * Singleton que gestiona la síntesis TTS en segundo plano.
 * Vive fuera de React (como startAutoSync) para sobrevivir a la navegación.
 *
 * Flujo:
 *   1. PdfListenMode sale sin completar síntesis → transfiere trabajo aquí
 *   2. Este manager sintetiza bloque a bloque usando piperTts directamente
 *   3. Guarda cada WAV en el cache existente (audio-tts-wav-cache)
 *   4. Reporta progreso al Zustand store (synthesisJobs)
 *   5. Al entrar de nuevo a PdfListenMode para ese PDF, el WAV ya está cacheado
 */

import {
  initPiperTts,
  isPiperReady,
  synthesizeToBlob,
  DEFAULT_VOICE_ID,
} from './piperTts';
import type { VoiceId } from '@mintplex-labs/piper-tts-web';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SynthesisJob {
  /** Unique ID: `${topicId}:${voiceId}` or `${cacheKey}` */
  jobId: string;
  topicId: string;
  pdfFilename: string;
  /** Pre-processed texts (already through mathToSpeech) */
  texts: string[];
  voiceId: VoiceId;
  /** SHA-256 hash of texts, used as WAV cache key */
  cacheKey: string;
  /** Index of the first block to synthesize (skip already-done blocks) */
  startFromBlock: number;
}

export interface SynthesisProgress {
  topicId: string;
  pdfFilename: string;
  current: number;
  total: number;
  status: 'queued' | 'running' | 'done' | 'error';
  errorMsg?: string;
}

// ─── WAV Cache (same DB as audioTtsEngine.ts) ───────────────────────────────────

const WAV_CACHE_DB = 'audio-tts-wav-cache';
const WAV_CACHE_STORE = 'wavs';
const WAV_CACHE_VERSION = 1;

interface CachedWavEntry {
  wav: Blob;
  blockBoundaries: number[];
  blockCount: number;
  voiceId: string;
  createdAt: number;
}

function openWavCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WAV_CACHE_DB, WAV_CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WAV_CACHE_STORE)) {
        db.createObjectStore(WAV_CACHE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function wavCacheGet(key: string): Promise<CachedWavEntry | undefined> {
  try {
    const db = await openWavCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(WAV_CACHE_STORE, 'readonly');
      const store = tx.objectStore(WAV_CACHE_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? undefined);
      req.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

async function wavCachePut(key: string, entry: CachedWavEntry): Promise<void> {
  try {
    const db = await openWavCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(WAV_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(WAV_CACHE_STORE);
      const req = store.put(entry, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[BgSynth] WAV cache write failed:', e);
  }
}

/** Check if a WAV is already fully cached */
export async function isWavCached(cacheKey: string, blockCount: number, voiceId: string): Promise<boolean> {
  const entry = await wavCacheGet(cacheKey);
  return !!entry && entry.blockCount === blockCount && entry.voiceId === voiceId;
}

/** Check if any WAV entry exists for the given cache key (lightweight, no validation) */
export async function hasWavEntry(cacheKey: string): Promise<boolean> {
  const entry = await wavCacheGet(cacheKey);
  return !!entry;
}

// ─── Topic → WAV cache key mapping (localStorage) ───────────────────────────

const TOPIC_WAV_KEY_PREFIX = 'wav-topic-key:';

/** Store the WAV cache key for a topic so its status can be shown in the topic list */
export function storeTopicWavCacheKey(topicId: string, cacheKey: string): void {
  try {
    localStorage.setItem(TOPIC_WAV_KEY_PREFIX + topicId, cacheKey);
  } catch { /* ignore quota errors */ }
}

/** Retrieve the WAV cache key previously stored for a topic */
export function getTopicWavCacheKey(topicId: string): string | null {
  try {
    return localStorage.getItem(TOPIC_WAV_KEY_PREFIX + topicId);
  } catch { return null; }
}

// ─── Resource file → WAV cache key mapping (localStorage) ───────────────────

const RESOURCE_WAV_KEY_PREFIX = 'wav-resource-key:';

/** Store the WAV cache key for a resource file so its status can be shown in the resource list */
export function storeResourceWavCacheKey(resourceFile: string, cacheKey: string): void {
  try {
    localStorage.setItem(RESOURCE_WAV_KEY_PREFIX + resourceFile, cacheKey);
  } catch { /* ignore quota errors */ }
}

/** Retrieve the WAV cache key previously stored for a resource file */
export function getResourceWavCacheKey(resourceFile: string): string | null {
  try {
    return localStorage.getItem(RESOURCE_WAV_KEY_PREFIX + resourceFile);
  } catch { return null; }
}

/** List all keys in the WAV cache with metadata */
export async function listWavCacheEntries(): Promise<Array<{ key: string; entry: CachedWavEntry }>> {
  try {
    const db = await openWavCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(WAV_CACHE_STORE, 'readonly');
      const store = tx.objectStore(WAV_CACHE_STORE);
      const results: Array<{ key: string; entry: CachedWavEntry }> = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          results.push({ key: c.key as string, entry: c.value });
          c.continue();
        } else {
          resolve(results);
        }
      };
      cursor.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

// ─── WAV utilities (simplified from audioTtsEngine.ts) ──────────────────────────

const TARGET_SAMPLE_RATE = 11025;

interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  duration: number;
}

function parseWavHeader(buffer: ArrayBuffer): WavInfo | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);

  const riff =
    String.fromCharCode(view.getUint8(0)) +
    String.fromCharCode(view.getUint8(1)) +
    String.fromCharCode(view.getUint8(2)) +
    String.fromCharCode(view.getUint8(3));
  if (riff !== 'RIFF') return null;

  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const chunkId =
      String.fromCharCode(view.getUint8(offset)) +
      String.fromCharCode(view.getUint8(offset + 1)) +
      String.fromCharCode(view.getUint8(offset + 2)) +
      String.fromCharCode(view.getUint8(offset + 3));
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'data') {
      const bytesPerSample = bitsPerSample / 8;
      const duration = chunkSize / (sampleRate * numChannels * bytesPerSample);
      return { sampleRate, numChannels, bitsPerSample, dataOffset: offset + 8, dataSize: chunkSize, duration };
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  return null;
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Silence WAV for empty/errored blocks */
function createSilenceWav(durationSec: number): Blob {
  const sampleRate = TARGET_SAMPLE_RATE;
  const numSamples = Math.round(sampleRate * durationSec);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: 'audio/wav' });
}

/** Concatenate WAV blobs into a single WAV with downsampling */
async function concatWavBlobs(
  blobs: Blob[],
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Promise<{ wav: Blob; durations: number[] } | null> {
  if (blobs.length === 0) return null;

  const buffers: ArrayBuffer[] = [];
  for (const blob of blobs) {
    buffers.push(await blob.arrayBuffer());
  }

  const infos: WavInfo[] = [];
  for (const buf of buffers) {
    const info = parseWavHeader(buf);
    if (!info) return null;
    infos.push(info);
  }

  const ref = infos[0];
  const srcRate = ref.sampleRate;
  const { numChannels, bitsPerSample } = ref;
  const frameSize = numChannels * (bitsPerSample / 8);

  const dsRatio = (targetSampleRate > 0 && targetSampleRate < srcRate)
    ? Math.round(srcRate / targetSampleRate)
    : 1;
  const outRate = dsRatio > 1 ? Math.round(srcRate / dsRatio) : srcRate;

  let totalOutPcmSize = 0;
  const durations: number[] = [];

  for (const info of infos) {
    const srcFrames = info.dataSize / frameSize;
    const outFrames = Math.ceil(srcFrames / dsRatio);
    totalOutPcmSize += outFrames * frameSize;
    durations.push(info.duration);
  }

  const headerSize = 44;
  const totalSize = headerSize + totalOutPcmSize;
  const output = new ArrayBuffer(totalSize);
  const view = new DataView(output);

  const outByteRate = outRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outByteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, totalOutPcmSize, true);

  const outputBytes = new Uint8Array(output);
  let writeOffset = headerSize;

  for (let i = 0; i < buffers.length; i++) {
    const srcBytes = new Uint8Array(buffers[i]);
    const info = infos[i];
    const srcFrames = info.dataSize / frameSize;

    if (dsRatio <= 1) {
      outputBytes.set(
        srcBytes.subarray(info.dataOffset, info.dataOffset + info.dataSize),
        writeOffset,
      );
      writeOffset += info.dataSize;
    } else {
      for (let f = 0; f < srcFrames; f += dsRatio) {
        const srcOff = info.dataOffset + f * frameSize;
        outputBytes.set(
          srcBytes.subarray(srcOff, srcOff + frameSize),
          writeOffset,
        );
        writeOffset += frameSize;
      }
    }
  }

  return {
    wav: new Blob([output], { type: 'audio/wav' }),
    durations,
  };
}

// ─── Store integration ──────────────────────────────────────────────────────────

// Lazy import to avoid circular dependencies
let _updateProgress: ((jobId: string, progress: SynthesisProgress | null) => void) | null = null;

export function setProgressUpdater(fn: (jobId: string, progress: SynthesisProgress | null) => void) {
  _updateProgress = fn;
}

function reportProgress(jobId: string, progress: SynthesisProgress | null) {
  _updateProgress?.(jobId, progress);
}

// ─── Singleton Manager ──────────────────────────────────────────────────────────

const queue: SynthesisJob[] = [];
let currentJobId: string | null = null;
let abortCurrent = false;
let processing = false;

/** Enqueue a background synthesis job */
export function enqueueSynthesis(job: SynthesisJob): void {
  // Don't duplicate
  if (queue.some(j => j.jobId === job.jobId) || currentJobId === job.jobId) {
    console.log('[BgSynth] Job already queued/running:', job.jobId);
    return;
  }

  queue.push(job);
  reportProgress(job.jobId, {
    topicId: job.topicId,
    pdfFilename: job.pdfFilename,
    current: job.startFromBlock,
    total: job.texts.length,
    status: 'queued',
  });

  console.log('[BgSynth] Enqueued:', job.jobId, `(${job.texts.length} blocks, start from ${job.startFromBlock})`);
  processQueue();
}

/** Cancel a specific job (e.g., user re-entered listen mode for that PDF) */
export function cancelSynthesis(jobId: string): void {
  // Remove from queue if queued
  const idx = queue.findIndex(j => j.jobId === jobId);
  if (idx !== -1) {
    queue.splice(idx, 1);
    reportProgress(jobId, null);
    console.log('[BgSynth] Removed from queue:', jobId);
    return;
  }

  // Abort if currently running
  if (currentJobId === jobId) {
    abortCurrent = true;
    console.log('[BgSynth] Aborting current job:', jobId);
  }
}

/** Cancel all jobs */
export function cancelAllSynthesis(): void {
  while (queue.length > 0) {
    const job = queue.pop()!;
    reportProgress(job.jobId, null);
  }
  if (currentJobId) {
    abortCurrent = true;
  }
}

/** Check if a job is running or queued for a specific topic */
export function isJobActiveFor(topicId: string): boolean {
  if (queue.some(j => j.topicId === topicId)) return true;
  // Check current job — we need the topicId from the progress report
  return false;
}

/** Get current queue size */
export function getQueueSize(): number {
  return queue.length + (currentJobId ? 1 : 0);
}

// ─── Processing loop ────────────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift()!;
    currentJobId = job.jobId;
    abortCurrent = false;

    try {
      await runJob(job);
    } catch (err) {
      console.error('[BgSynth] Job failed:', job.jobId, err);
      reportProgress(job.jobId, {
        topicId: job.topicId,
        pdfFilename: job.pdfFilename,
        current: 0,
        total: job.texts.length,
        status: 'error',
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    }

    currentJobId = null;
  }

  processing = false;
}

async function runJob(job: SynthesisJob): Promise<void> {
  const { jobId, topicId, pdfFilename, texts, voiceId, cacheKey, startFromBlock } = job;

  // Check if already fully cached
  const existing = await wavCacheGet(cacheKey);
  if (existing && existing.blockCount === texts.length && existing.voiceId === voiceId) {
    console.log('[BgSynth] Already cached, skipping:', jobId);
    reportProgress(jobId, {
      topicId, pdfFilename,
      current: texts.length,
      total: texts.length,
      status: 'done',
    });
    // Auto-remove after 3s
    setTimeout(() => reportProgress(jobId, null), 3000);
    return;
  }

  // Initialize Piper if needed
  if (!isPiperReady()) {
    reportProgress(jobId, {
      topicId, pdfFilename,
      current: startFromBlock,
      total: texts.length,
      status: 'running',
    });
    const ok = await initPiperTts(voiceId);
    if (!ok) {
      reportProgress(jobId, {
        topicId, pdfFilename,
        current: 0,
        total: texts.length,
        status: 'error',
        errorMsg: 'No se pudo inicializar Piper TTS',
      });
      return;
    }
  }

  // Synthesize block by block
  const blobs: Blob[] = [];

  for (let i = 0; i < texts.length; i++) {
    if (abortCurrent) {
      console.log('[BgSynth] Job aborted:', jobId);
      reportProgress(jobId, null);
      return;
    }

    const text = texts[i];

    if (!text || !text.trim()) {
      blobs.push(createSilenceWav(0.2));
    } else {
      try {
        const blob = await synthesizeToBlob(text);
        if (abortCurrent) {
          reportProgress(jobId, null);
          return;
        }
        blobs.push(blob ?? createSilenceWav(0.5));
      } catch (err) {
        console.warn('[BgSynth] Block', i, 'failed:', err);
        blobs.push(createSilenceWav(0.5));
      }
    }

    // Report progress
    reportProgress(jobId, {
      topicId, pdfFilename,
      current: i + 1,
      total: texts.length,
      status: 'running',
    });
  }

  if (abortCurrent) {
    reportProgress(jobId, null);
    return;
  }

  // Concatenate all blobs into single WAV
  const result = await concatWavBlobs(blobs);
  if (!result) {
    reportProgress(jobId, {
      topicId, pdfFilename,
      current: 0,
      total: texts.length,
      status: 'error',
      errorMsg: 'Error al concatenar WAVs',
    });
    return;
  }

  // Build block boundaries
  const blockBoundaries: number[] = [];
  let cum = 0;
  for (const d of result.durations) {
    blockBoundaries.push(cum);
    cum += d;
  }

  // Save to WAV cache
  await wavCachePut(cacheKey, {
    wav: result.wav,
    blockBoundaries,
    blockCount: texts.length,
    voiceId,
    createdAt: Date.now(),
  });

  console.log('[BgSynth] Job completed:', jobId, `(${texts.length} blocks, ${(result.wav.size / 1024 / 1024).toFixed(1)} MB)`);

  reportProgress(jobId, {
    topicId, pdfFilename,
    current: texts.length,
    total: texts.length,
    status: 'done',
  });

  // Auto-remove "done" status after 5 seconds
  setTimeout(() => reportProgress(jobId, null), 5000);
}
