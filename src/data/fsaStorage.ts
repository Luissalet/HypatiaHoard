/**
 * fsaStorage.ts
 *
 * Servicio de almacenamiento de PDFs usando la File System Access API.
 * Permite al usuario elegir una carpeta de su disco y guardar los PDFs allí
 * en lugar de en IndexedDB, eliminando el límite de quota del navegador.
 *
 * Estructura de carpetas en el disco:
 *   [carpeta elegida]/
 *     [subjectId]/          ← UUID de la asignatura como nombre de carpeta
 *       Tema1.pdf
 *       Tema2.pdf
 *       ...
 *
 * El FileSystemDirectoryHandle se guarda en la tabla `fsaHandles` de Dexie,
 * que sí puede almacenar objetos structured-cloneable como los handles de la FSAPI.
 *
 * Compatibilidad: Chrome/Edge 86+, Firefox (parcial), Safari 15.2+.
 * Se expone `isFsaSupported()` para que la UI pueda ocultar la opción si no aplica.
 */

import { db } from './db';

// ─── Constantes ───────────────────────────────────────────────────────────────

const HANDLE_KEY = 'pdf-root';

// ─── Soporte del navegador ────────────────────────────────────────────────────

/** Devuelve true si el navegador soporta File System Access API (desktop). */
export function isFsaSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    typeof (window as any).showDirectoryPicker === 'function'
  );
}

/**
 * Devuelve true si el navegador soporta Origin Private File System (OPFS).
 * Compatible con Chrome/Edge Android 86+, desktop, Safari 15.2+.
 * OPFS usa almacenamiento privado del navegador — sin picker, sin límite de quota.
 */
export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof (navigator.storage as any).getDirectory === 'function'
  );
}

// ─── Gestión del handle raíz ──────────────────────────────────────────────────

/**
 * Solicita al usuario que elija una carpeta y la guarda en Dexie.
 * Devuelve el handle o null si el usuario cancela.
 * Solo disponible en escritorio (Chrome/Edge 86+).
 */
export async function selectPdfFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFsaSupported()) return null;
  try {
    const handle = await (window as any).showDirectoryPicker({
      id: 'examcoach-pdfs',
      mode: 'readwrite',
      startIn: 'documents',
    }) as FileSystemDirectoryHandle;

    await db.fsaHandles.put({
      key: HANDLE_KEY,
      handle,
      name: handle.name,
      type: 'fsa',
      savedAt: new Date().toISOString(),
    });

    return handle;
  } catch (err: any) {
    // AbortError = usuario canceló el picker, no es un error real
    if (err?.name === 'AbortError') return null;
    console.error('[fsaStorage] Error seleccionando carpeta:', err);
    return null;
  }
}

/**
 * Activa el Origin Private File System (OPFS) como almacenamiento de PDFs.
 * No requiere ningún picker ni permiso del usuario.
 * Compatible con Chrome/Edge Android 86+, iOS Safari 15.2+.
 * Los archivos se guardan en el almacenamiento privado de la app (no accesibles
 * desde el explorador de archivos del sistema operativo).
 */
export async function selectOpfsFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isOpfsSupported()) return null;
  try {
    const handle = await (navigator.storage as any).getDirectory() as FileSystemDirectoryHandle;
    await db.fsaHandles.put({
      key: HANDLE_KEY,
      handle,
      name: 'Almacenamiento interno (OPFS)',
      type: 'opfs',
      savedAt: new Date().toISOString(),
    });
    return handle;
  } catch (err) {
    console.error('[fsaStorage] Error activando OPFS:', err);
    return null;
  }
}

/**
 * Devuelve el handle guardado, o null si no hay ninguno configurado.
 * No muestra ningún diálogo al usuario.
 */
export async function getStoredFolderRecord(): Promise<{
  handle: FileSystemDirectoryHandle;
  name: string;
  type?: 'fsa' | 'opfs';
} | null> {
  try {
    const record = await db.fsaHandles.get(HANDLE_KEY);
    if (!record) return null;
    return { handle: record.handle, name: record.name, type: record.type };
  } catch {
    return null;
  }
}

/**
 * Elimina el handle guardado. A partir de este punto la app vuelve a usar IndexedDB.
 */
export async function clearPdfFolder(): Promise<void> {
  await db.fsaHandles.delete(HANDLE_KEY);
}

// ─── Verificación de permisos ─────────────────────────────────────────────────

/**
 * Verifica (y solicita si es necesario) permiso de lectura/escritura para el handle.
 * Devuelve true si el permiso fue concedido.
 *
 * Los permisos de la FSAPI se revocan al cerrar el navegador, así que hay
 * que volver a pedirlos en cada sesión. Chrome permite re-pedir sin picker.
 */
export async function verifyPermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite' = 'readwrite'
): Promise<boolean> {
  const opts = { mode };
  // queryPermission primero para no molestar al usuario si ya tiene permiso
  if ((await (handle as any).queryPermission(opts)) === 'granted') return true;
  // Si no, pedir al usuario (requiere un gesto de usuario en algunos navegadores)
  if ((await (handle as any).requestPermission(opts)) === 'granted') return true;
  return false;
}

/**
 * Obtiene el handle raíz con permisos verificados.
 * Devuelve null si no hay carpeta configurada o el usuario deniega el permiso.
 *
 * OPFS no requiere verificación de permisos — siempre accesible.
 * Para OPFS se obtiene el handle fresco cada vez vía navigator.storage.getDirectory().
 */
async function getRootHandle(): Promise<FileSystemDirectoryHandle | null> {
  const record = await getStoredFolderRecord();
  if (!record) return null;

  if (record.type === 'opfs') {
    // OPFS: always accessible, no permission dialog needed
    try {
      return await (navigator.storage as any).getDirectory() as FileSystemDirectoryHandle;
    } catch {
      return null;
    }
  }

  // FSA: verify (and re-request if needed) read/write permission
  const ok = await verifyPermission(record.handle);
  if (!ok) return null;
  return record.handle;
}

// ─── Operaciones de archivos ──────────────────────────────────────────────────

/**
 * Guarda un PDF en la carpeta FSA del usuario.
 * Devuelve true si se guardó correctamente, false si la FSAPI no está disponible
 * o el usuario no ha concedido permiso.
 */
export async function savePdfToFolder(
  subjectId: string,
  filename: string,
  blob: Blob
): Promise<boolean> {
  const root = await getRootHandle();
  if (!root) return false;
  try {
    const subjectDir = await root.getDirectoryHandle(subjectId, { create: true });
    const fileHandle = await subjectDir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    console.error('[fsaStorage] Error guardando PDF en carpeta:', err);
    return false;
  }
}

/**
 * Lee un PDF desde la carpeta FSA.
 * Devuelve el Blob o null si no existe / no hay permisos.
 */
export async function readPdfFromFolder(
  subjectId: string,
  filename: string
): Promise<Blob | null> {
  const root = await getRootHandle();
  if (!root) return null;
  try {
    const subjectDir = await root.getDirectoryHandle(subjectId, { create: false });
    const fileHandle = await subjectDir.getFileHandle(filename, { create: false });
    const file = await fileHandle.getFile();
    return file;
  } catch {
    return null;
  }
}

/**
 * Lista los nombres de PDFs almacenados en la carpeta FSA para una asignatura.
 * Devuelve [] si no hay carpeta configurada o no existe el subdirectorio.
 */
export async function listPdfsInFolder(subjectId: string): Promise<string[]> {
  const root = await getRootHandle();
  if (!root) return [];
  try {
    const subjectDir = await root.getDirectoryHandle(subjectId, { create: false });
    const names: string[] = [];
    for await (const [name, entry] of (subjectDir as any).entries()) {
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
        names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Elimina un PDF de la carpeta FSA.
 * Devuelve true si se eliminó, false si hubo un error.
 */
export async function deletePdfFromFolder(
  subjectId: string,
  filename: string
): Promise<boolean> {
  const root = await getRootHandle();
  if (!root) return false;
  try {
    const subjectDir = await root.getDirectoryHandle(subjectId, { create: false });
    await subjectDir.removeEntry(filename);
    return true;
  } catch {
    return false;
  }
}

// ─── Comprobación de quota ────────────────────────────────────────────────────

export interface StorageCheck {
  /** true si hay espacio suficiente (o si FSA está activa y no hay límite) */
  ok: boolean;
  /** % de quota IndexedDB usado (0-100). 0 si FSA activa o API no disponible. */
  percentUsed: number;
  /** Bytes disponibles en IndexedDB. Infinity si FSA activa o API no disponible. */
  availableBytes: number;
  /** true si hay carpeta FSA configurada con permiso activo */
  fsaConfigured: boolean;
}

/**
 * Comprueba si hay quota suficiente para almacenar `requiredBytes`.
 *
 * Si la carpeta FSA está configurada y activa, siempre devuelve ok:true
 * porque los archivos van al disco del usuario (sin límite de browser).
 */
export async function checkStorageQuota(requiredBytes: number): Promise<StorageCheck> {
  const root = await getRootHandle();
  if (root) {
    // FSA activa → sin límite de quota de navegador
    return { ok: true, percentUsed: 0, availableBytes: Infinity, fsaConfigured: true };
  }

  if (!('storage' in navigator && 'estimate' in navigator.storage)) {
    return { ok: true, percentUsed: 0, availableBytes: Infinity, fsaConfigured: false };
  }

  const est = await navigator.storage.estimate();
  const used = est.usage ?? 0;
  const quota = est.quota ?? Infinity;
  const available = Math.max(0, quota - used);
  const percentUsed = quota > 0 && isFinite(quota) ? (used / quota) * 100 : 0;

  return {
    ok: available >= requiredBytes,
    percentUsed,
    availableBytes: available,
    fsaConfigured: false,
  };
}

// ─── Migración ────────────────────────────────────────────────────────────────

export interface MigrationResult {
  migrated: number;
  failed: number;
  /** Bytes liberados de IndexedDB (aprox. tamaño total de blobs migrados) */
  freedBytes: number;
}

/**
 * Migra todos los PDFs almacenados en IndexedDB a la carpeta FSA configurada.
 * Los PDFs migrados con éxito se eliminan de IndexedDB para liberar quota.
 *
 * La operación es incremental y segura: si un PDF ya existe en disco, se salta;
 * si falla la escritura, lo deja en IndexedDB intacto.
 */
export async function migrateAllPdfsToFolder(): Promise<MigrationResult> {
  const root = await getRootHandle();
  if (!root) throw new Error('No hay carpeta FSA configurada o sin permisos.');

  const allPdfs = await db.pdfResources.toArray();
  let migrated = 0;
  let failed = 0;
  let freedBytes = 0;

  for (const record of allPdfs) {
    try {
      // Crear/abrir subcarpeta de la asignatura
      const subjectDir = await root.getDirectoryHandle(record.subjectId, { create: true });

      // Comprobar si ya existe en disco para evitar sobreescrituras innecesarias
      let alreadyExists = false;
      try {
        await subjectDir.getFileHandle(record.filename, { create: false });
        alreadyExists = true;
      } catch { /* no existe */ }

      if (!alreadyExists) {
        const fileHandle = await subjectDir.getFileHandle(record.filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(record.blob);
        await writable.close();
      }

      // Eliminar de IndexedDB tras confirmar que está en disco
      freedBytes += record.blob.size;
      await db.pdfResources.delete(record.id);
      migrated++;
    } catch (err) {
      console.error(`[fsaStorage] No se pudo migrar ${record.filename}:`, err);
      failed++;
    }
  }

  return { migrated, failed, freedBytes };
}
