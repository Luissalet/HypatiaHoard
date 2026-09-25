/**
 * pdfStorage.ts
 *
 * Gestiona PDFs subidos por el usuario con una estrategia de almacenamiento en dos capas:
 *
 *   1. File System Access API (FSA) — si el usuario ha configurado una carpeta de disco.
 *      Sin límite de quota del navegador. Los PDFs se guardan en:
 *      [carpeta elegida]/[subjectId]/[filename].pdf
 *
 *   2. IndexedDB (Dexie) — fallback universal. Siempre disponible pero sujeto a la
 *      quota del navegador (~2 GB en muchos casos).
 *
 *   Prioridad al leer: FSA → IndexedDB.
 *   Al guardar: intenta FSA; si no hay carpeta o falla, usa IndexedDB.
 *   Al borrar: elimina de ambos almacenes para no dejar huérfanos.
 *
 *   3. Dev server — en `npm run dev`, puede subir PDFs a resources/ via /api/upload-pdf.
 *      Con Hypatia's Hoard, el servidor local los guarda en resources/ (PUT /api/resources/upload).
 */

import { v4 as uuidv4 } from 'uuid';
import { isHoardMode } from './hoardMode';
import { db } from './db';
import { slugify } from '@/domain/normalize';
import { invalidateExtraInfoCache } from './resourceLoader';
import {
  savePdfToFolder,
  readPdfFromFolder,
  listPdfsInFolder,
  deletePdfFromFolder,
} from './fsaStorage';

// ─── Capa combinada FSA + IndexedDB ───────────────────────────────────────────

/**
 * Guarda un PDF.
 * Intenta FSA primero; si no hay carpeta configurada o falla, usa IndexedDB.
 */
export async function savePdfBlob(
  subjectId: string,
  filename: string,
  blob: Blob
): Promise<void> {
  const savedToFsa = await savePdfToFolder(subjectId, filename, blob);

  if (savedToFsa) {
    // Si el mismo PDF existía en IndexedDB de antes, lo eliminamos para liberar quota
    const existing = await db.pdfResources
      .where('subjectId').equals(subjectId)
      .filter((r) => r.filename === filename)
      .first();
    if (existing) await db.pdfResources.delete(existing.id);
    return;
  }

  // Fallback: IndexedDB
  const existing = await db.pdfResources
    .where('subjectId').equals(subjectId)
    .filter((r) => r.filename === filename)
    .first();

  if (existing) {
    await db.pdfResources.update(existing.id, { blob, createdAt: new Date().toISOString() });
  } else {
    await db.pdfResources.add({
      id: uuidv4(),
      subjectId,
      filename,
      mime: 'application/pdf',
      blob,
      createdAt: new Date().toISOString(),
    });
  }
}

/**
 * Devuelve una blob URL para un PDF.
 * Busca primero en FSA, luego en IndexedDB.
 * Devuelve null si no existe en ningún almacén.
 * ⚠️ El caller debe revocar la URL con URL.revokeObjectURL() cuando ya no la necesite.
 */
export async function getPdfBlobUrl(
  subjectId: string,
  filename: string
): Promise<string | null> {
  // 1. Intentar FSA
  const fsaBlob = await readPdfFromFolder(subjectId, filename);
  if (fsaBlob) return URL.createObjectURL(fsaBlob);

  // 2. Fallback IndexedDB
  const record = await db.pdfResources
    .where('subjectId').equals(subjectId)
    .filter((r) => r.filename === filename)
    .first();
  if (!record) return null;
  return URL.createObjectURL(record.blob);
}

/**
 * Lista los nombres de PDFs disponibles para una asignatura.
 * Combina FSA (prioridad) e IndexedDB, sin duplicados.
 */
export async function listStoredPdfs(subjectId: string): Promise<string[]> {
  const [fsaNames, idbRecords] = await Promise.all([
    listPdfsInFolder(subjectId),
    db.pdfResources.where('subjectId').equals(subjectId).toArray(),
  ]);

  const combined = new Set<string>(fsaNames);
  for (const r of idbRecords) combined.add(r.filename);
  return Array.from(combined);
}

/**
 * Elimina un PDF de todos los almacenes (FSA e IndexedDB).
 */
export async function deleteStoredPdf(subjectId: string, filename: string): Promise<void> {
  // Borrar de FSA (ignora silenciosamente si no existe)
  await deletePdfFromFolder(subjectId, filename);

  // Borrar de IndexedDB
  const record = await db.pdfResources
    .where('subjectId').equals(subjectId)
    .filter((r) => r.filename === filename)
    .first();
  if (record) await db.pdfResources.delete(record.id);
}

// ─── Dev server upload ────────────────────────────────────────────────────────

/**
 * Intenta subir el PDF al servidor de desarrollo Vite para guardarlo en
 * resources/[slug]/Temas/ y actualizar el index.json con el mapeo topicTitle → pdf.
 *
 * Solo funciona con `npm run dev`. En producción devuelve false silenciosamente.
 * Invalida la caché de resourceLoader para que loadPdfMapping refleje el nuevo archivo.
 *
 * @param topicTitle  Título del tema al que pertenece el PDF (para el mapeo en index.json)
 * @returns true si el servidor lo aceptó, false si no está disponible.
 */
export async function savePdfToServer(
  subjectName: string,
  filename: string,
  file: File,
  topicTitle?: string,
): Promise<boolean> {
  // Hypatia's Hoard: the local server keeps it in resources/[slug]/Temas/ (PUT /api/resources/upload),
  // so every device that opens the server can view it. No topicTitle mapping: the topic itself
  // (pdfFilename) syncs, and a mapping would re-attach the PDF after the user removes it.
  if (isHoardMode()) {
    try {
      const params = new URLSearchParams({ subject: subjectName, filename });
      const res = await fetch(`/api/resources/upload?${params}`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/pdf' },
        body: file,
      });
      if (res.ok) invalidateExtraInfoCache(subjectName);
      else console.warn('[pdfStorage] Hypatia no guardó el PDF:', await res.json().catch(() => ({})));
      return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    const slug = slugify(subjectName);

    const res = await fetch('/api/upload-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, filename, data: base64, topicTitle: topicTitle ?? '' }),
    });

    if (res.ok) {
      invalidateExtraInfoCache(subjectName);
      console.log(`[pdfStorage] ✅ PDF guardado en resources/${slug}/Temas/${filename} → "${topicTitle}"`);
      return true;
    }

    const err = await res.json().catch(() => ({}));
    console.warn('[pdfStorage] El servidor rechazó el PDF:', err);
    return false;
  } catch {
    console.info('[pdfStorage] Endpoint /api/upload-pdf no disponible (¿producción?). Solo IndexedDB/FSA.');
    return false;
  }
}
