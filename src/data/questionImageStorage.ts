/**
 * questionImageStorage.ts
 *
 * Gestiona imágenes de preguntas (inline en markdown):
 *  1. Siempre guarda en IndexedDB (fallback offline/producción)
 *  2. En desarrollo: también escribe en public/question-images/ via dev server
 *
 * Las imágenes se referencian en markdown como:
 *   ![alt](question-images/uuid.ext)
 *
 * En contribution packs se exportan como base64 en el campo `questionImages`.
 */

import { db } from './db';
import { isHoardMode } from './hoardMode';

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

/** Guarda una imagen (File) en IndexedDB y opcionalmente en disco (dev server). */
export async function saveQuestionImage(file: File): Promise<string> {
  const ext = (file.name.split('.').pop() ?? 'png').toLowerCase();
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;

  // 1. IndexedDB
  await db.questionImages.add({
    id,
    filename,
    blob: file,
    mimeType: file.type || `image/${ext}`,
    createdAt: new Date().toISOString(),
  });

  // 2. Dev server (best-effort). Under Hypatia's Hoard /api is the local server, which gets the
  //    image with the next sync (questionImages in the backup) instead.
  if (!isHoardMode()) try {
    const base64 = await blobToBase64(file);
    await fetch('/api/upload-question-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, data: base64, mime: file.type }),
    });
  } catch {
    // Dev server not available — IndexedDB is the fallback
  }

  return filename;
}

/**
 * Devuelve una blob URL para usar como src de <img>.
 * El caller debe revocar la URL con URL.revokeObjectURL() cuando ya no la necesite.
 * Devuelve null si la imagen no está en IndexedDB (puede estar en /public ya).
 */
export async function getQuestionImageBlobUrl(filename: string): Promise<string | null> {
  const id = filenameToId(filename);
  const record = await db.questionImages.get(id);
  if (!record) return null;
  return URL.createObjectURL(record.blob);
}

// ─── Contribution pack helpers ────────────────────────────────────────────────

/**
 * Extrae todos los filenames de question-images/ referenciados en un texto markdown.
 */
export function extractImageFilenames(text: string): string[] {
  const matches = [...text.matchAll(/question-images\/([^\s"')]+)/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

/**
 * Dado un conjunto de textos (prompt, explanation, modelAnswer…),
 * devuelve un mapa { filename → base64 } con todas las imágenes referenciadas.
 */
export async function buildImageMap(texts: string[]): Promise<Record<string, string>> {
  const filenames = new Set<string>();
  for (const text of texts) {
    if (text) extractImageFilenames(text).forEach((f) => filenames.add(f));
  }

  const map: Record<string, string> = {};
  for (const filename of filenames) {
    const id = filenameToId(filename);
    const record = await db.questionImages.get(id);
    if (record) {
      map[filename] = await blobToBase64(record.blob);
    }
  }
  return map;
}

/**
 * Importa imágenes desde un contribution pack (base64 map).
 * Guarda en IndexedDB + intenta dev server.
 */
export async function importImages(images: Record<string, string>, mimeMap?: Record<string, string>): Promise<void> {
  for (const [filename, base64] of Object.entries(images)) {
    const id = filenameToId(filename);
    const existing = await db.questionImages.get(id);
    if (existing) continue; // ya existe

    const ext = (filename.split('.').pop() ?? 'png').toLowerCase();
    const mime = mimeMap?.[filename] ?? `image/${ext}`;
    const blob = base64ToBlob(base64, mime);

    await db.questionImages.add({
      id,
      filename,
      blob,
      mimeType: mime,
      createdAt: new Date().toISOString(),
    });

    // Best-effort dev server (Hypatia's Hoard gets it with the next sync)
    if (!isHoardMode()) try {
      await fetch('/api/upload-question-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, data: base64, mime }),
      });
    } catch { /* ignore */ }
  }
}

// ─── Dev: sync IndexedDB → public/question-images/ ───────────────────────────

export interface ImageSyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
}

/**
 * Vuelca todas las imágenes de IndexedDB al dev server (public/question-images/).
 * Solo útil para el mantenedor del repo en modo desarrollo.
 */
export async function syncImagesToDevServer(): Promise<ImageSyncResult> {
  const result: ImageSyncResult = { total: 0, synced: 0, skipped: 0, errors: [] };

  const all = await db.questionImages.toArray();
  result.total = all.length;

  for (const record of all) {
    try {
      const base64 = await blobToBase64(record.blob);
      const res = await fetch('/api/upload-question-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: record.filename, data: base64, mime: record.mimeType }),
      });
      if (res.ok) {
        result.synced++;
      } else {
        // Si el endpoint no existe (producción), contar como skipped
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`${record.filename}: ${String(e)}`);
    }
  }

  return result;
}
// ─── Internal utils ───────────────────────────────────────────────────────────

function filenameToId(filename: string): string {
  // filename = "uuid.ext" → id = "uuid"
  return filename.replace(/\.[^.]+$/, '');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
