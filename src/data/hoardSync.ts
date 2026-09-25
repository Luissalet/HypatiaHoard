/**
 * hoardSync.ts
 *
 * Two-way sync of IndexedDB with the local Hypatia's Hoard server. Hoard mode
 * only: main.tsx imports this module dynamically after the build flag check,
 * and bootHoard() runs detectHoard() before touching anything.
 *
 * One cycle (SPEC "Sync protocol"):
 *   1. push   POST /api/sync/push {backup: exportFullBackup(), deletes, deviceId}
 *   2. pull   GET  /api/sync/pull?since=<lastRev>
 *   3. merge  mergeBackup(backup)   (same rules as the Gist sync)
 *   4. apply server tombstones locally (delete by id, hooks suppressed)
 *   5. store lastRev in localStorage 'hypatia-last-rev'
 *
 * Triggers: start, every 60 s while visible, on visibilitychange→hidden, and
 * when GET /api/sync/state (polled every 15 s while visible) reports a new rev
 * (an agent changed something through the tools).
 *
 * Local deletions are captured with Dexie `deleting` hooks into the
 * localStorage queue 'hypatia-pending-deletes' — installed only here, i.e.
 * only in hoard mode. The Gist auto-sync keeps running independently.
 */

import type Dexie from 'dexie';
import { db, getSettings, saveSettings } from './db';
import { exportFullBackup, mergeBackup, type FullBackup } from './gistSync';
import { detectHoard, hoardJson, getSyncState, listSources, uploadSource, HoardError } from './hoardClient';
import { isHoardMode } from './hoardMode';
import { listStoredPdfs } from './pdfStorage';
import { readPdfFromFolder } from './fsaStorage';
import {
  DELETE_TRACKED, DIRTY_TRACKED_TABLES, KIND_TABLE, ID_MAP_KEY, LAST_REV_KEY, PENDING_DELETES_KEY,
  basename, countRecords, deleteKey, enqueueDelete, isRecordKind, mergeIdMap, normalizePulledBackup,
  parseIdMap, parseQueue, pdfsToUpload, removeSent, serverDeletes, toLocalIds, toServerId,
  type IdMap, type PendingDelete, type RecordKind,
} from './hoardSyncCore';
import { useStore } from '@/ui/store';

// ─── localStorage helpers (never throw) ──────────────────────────────────────

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / private mode */ }
}

function readQueue(): PendingDelete[] { return parseQueue(lsGet(PENDING_DELETES_KEY)); }
function writeQueue(q: PendingDelete[]): void { lsSet(PENDING_DELETES_KEY, JSON.stringify(q)); }
function readIdMap(): IdMap { return parseIdMap(lsGet(ID_MAP_KEY)); }

export function getLastRev(): number {
  const n = Number(lsGet(LAST_REV_KEY) ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Server id for a local record id (differs only when the server deduped it). */
export function serverIdFor(kind: RecordKind, localId: string): string {
  return toServerId(readIdMap(), kind, localId);
}

// ─── Dexie hooks ─────────────────────────────────────────────────────────────

/** kind:id pairs being deleted because the server said so — not re-queued. */
const suppressed = new Set<string>();
let dirty = true;
let hooksInstalled = false;
/** True while pull() writes the server's records into IndexedDB. */
let applyingRemote = false;

function installHooks(): void {
  if (hooksInstalled || !isHoardMode()) return;
  hooksInstalled = true;

  for (const kind of DELETE_TRACKED) {
    const table = (db as unknown as Record<string, Dexie.Table<unknown, string>>)[KIND_TABLE[kind]];
    table.hook('deleting', function (this: { onsuccess?: () => void }, primKey: string) {
      if (!isHoardMode()) return;
      if (suppressed.has(deleteKey(kind, String(primKey)))) return;
      const id = String(primKey);
      this.onsuccess = () => {
        writeQueue(enqueueDelete(readQueue(), { kind, id, deletedAt: new Date().toISOString() }));
        dirty = true;
        scheduleSoon();
      };
    });
  }

  // Local edits: push within a few seconds (not while a pull is writing the server's changes).
  const markDirty = () => { dirty = true; if (!applyingRemote) scheduleSoon(); };
  for (const name of DIRTY_TRACKED_TABLES) {
    const table = (db as unknown as Record<string, Dexie.Table<unknown, string>>)[name];
    if (!table) continue;
    table.hook('creating', markDirty);
    table.hook('updating', markDirty);
    table.hook('deleting', markDirty);
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

function setStatus(patch: Parameters<ReturnType<typeof useStore.getState>['setHoardStatus']>[0]): void {
  useStore.getState().setHoardStatus(patch);
}

function errorMessage(err: unknown): string {
  if (err instanceof HoardError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Cycle ───────────────────────────────────────────────────────────────────

let running: Promise<void> | null = null;
let rerun = false;
let lastSettingsKey = '';

interface PushResponse {
  rev?: number;
  added?: number;
  updated?: number;
  skipped?: number;
  idMap?: unknown;
}

interface PullResponse {
  backup?: unknown;
  tombstones?: { kind: string; id: string }[];
  rev?: number;
}

async function syncedSettingsKey(): Promise<string> {
  const s = await getSettings();
  return JSON.stringify([
    s.alias, s.importedPackIds, s.importHistory?.length, s.globalBankSyncedAt, s.studyStreak,
    s.lastStudyDate, s.subjectGoals, s.marketplacePasswords ? Object.keys(s.marketplacePasswords) : null,
  ]);
}

async function push(): Promise<void> {
  const settingsKey = await syncedSettingsKey();
  const queue = readQueue();
  if (!dirty && queue.length === 0 && settingsKey === lastSettingsKey) return;

  dirty = false; // writes that happen while we export mark it again
  const backup = await exportFullBackup();
  // PDFs/WAVs never travel through the server sync
  delete (backup as Partial<FullBackup>).pdfManifest;
  delete (backup as Partial<FullBackup>).pregenManifest;

  const deletes = await serverDeletes(queue, readIdMap(), async (kind, localId) => {
    const table = (db as unknown as Record<string, Dexie.Table<unknown, string>>)[KIND_TABLE[kind]];
    return !!table && !!(await table.get(localId));
  });

  try {
    const res = await hoardJson<PushResponse>('/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup, deletes, deviceId: backup.deviceId }),
    });
    writeQueue(removeSent(readQueue(), queue));
    if (res?.idMap) lsSet(ID_MAP_KEY, JSON.stringify(mergeIdMap(readIdMap(), res.idMap)));
    lastSettingsKey = settingsKey;
  } catch (err) {
    dirty = true;
    throw err;
  }
}

async function applyTombstones(tombstones: { kind: string; id: string }[]): Promise<number> {
  const idMap = readIdMap();
  let removed = 0;
  for (const t of tombstones) {
    if (!isRecordKind(t.kind) || typeof t.id !== 'string') continue;
    const table = (db as unknown as Record<string, Dexie.Table<unknown, string>>)[KIND_TABLE[t.kind]];
    if (!table) continue;
    for (const localId of toLocalIds(idMap, t.kind, t.id)) {
      const key = deleteKey(t.kind, localId);
      suppressed.add(key);
      try {
        if (await table.get(localId)) {
          await table.delete(localId);
          removed++;
        }
      } finally {
        suppressed.delete(key);
      }
    }
  }
  // A tombstone also cancels a still-queued local delete of the same record
  if (tombstones.length) {
    const gone = new Set(tombstones.map((t) => deleteKey(t.kind, t.id)));
    writeQueue(readQueue().filter((d) => !gone.has(deleteKey(d.kind, toServerId(idMap, d.kind, d.id)))));
  }
  return removed;
}

async function pull(): Promise<{ changed: boolean; rev: number }> {
  const since = getLastRev();
  const res = await hoardJson<PullResponse>(`/sync/pull?since=${since}`);
  const backup = normalizePulledBackup<FullBackup & Record<string, unknown>>(res?.backup);
  let changed = false;

  // Always merge: even an empty pull carries syncedSettings (streak, goals…).
  // mergeBackup stamps settings.lastSyncAt, which the Gist sync uses to decide
  // whether its gist changed — restore it so hoard cycles don't mask Gist pulls.
  const gistLastSyncAt = (await getSettings()).lastSyncAt;
  applyingRemote = true;
  let removed = 0;
  try {
    const result = await mergeBackup(backup);
    await saveSettings({ lastSyncAt: gistLastSyncAt });
    if (!result.success) throw new Error(result.error ?? 'Error al fusionar datos de Hypatia');
    changed = countRecords(backup) > 0 && (result.added ?? 0) + (result.updated ?? 0) > 0;
    removed = await applyTombstones(Array.isArray(res?.tombstones) ? res.tombstones : []);
  } finally {
    applyingRemote = false;
  }
  if (removed > 0) changed = true;

  const rev = Number(res?.rev ?? since);
  if (Number.isFinite(rev)) lsSet(LAST_REV_KEY, String(rev));
  return { changed, rev };
}

async function refreshUi(): Promise<void> {
  const store = useStore.getState();
  await store.loadSubjects();
  const subjectId = store.questions[0]?.subjectId ?? store.topics[0]?.subjectId;
  if (subjectId) {
    await Promise.all([store.loadTopics(subjectId), store.loadQuestions(subjectId)]);
  }
  window.dispatchEvent(new CustomEvent('hypatia-synced'));
}

async function runCycle(): Promise<void> {
  setStatus({ syncing: true });
  try {
    await push();
    const { changed, rev } = await pull();
    setStatus({ connected: true, syncing: false, error: null, lastSyncAt: new Date().toISOString(), rev });
    if (changed) await refreshUi();
  } catch (err) {
    const offline = err instanceof HoardError && err.status === 0;
    setStatus({ syncing: false, error: errorMessage(err), connected: !offline });
  }
}

/** Runs a sync cycle now (single-flight; a request during a run queues one more). */
export function syncNow(): Promise<void> {
  if (!isHoardMode()) return Promise.resolve();
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerun = false;
        await runCycle();
      } while (rerun);
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * After the local data were wiped (Ajustes → Borrar todos los datos): forget the sync
 * cursor and the id map, so the next cycle downloads everything the server keeps.
 * Table.clear() fires no Dexie hooks, so the wipe never reaches the server as deletions.
 */
export function resetSyncCursor(): Promise<void> {
  lsSet(LAST_REV_KEY, '0');
  lsSet(ID_MAP_KEY, '{}');
  dirty = true;
  return syncNow();
}

let soonTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced cycle after local deletions. */
function scheduleSoon(): void {
  if (soonTimer) return;
  soonTimer = setTimeout(() => { soonTimer = null; void syncNow(); }, 3000);
}

// ─── Start ───────────────────────────────────────────────────────────────────

let started = false;

export function startHoardSync(): void {
  if (started || !isHoardMode()) return;
  started = true;
  installHooks();
  setStatus({ connected: true, rev: getLastRev() });
  void syncNow();

  const visible = () => document.visibilityState === 'visible';

  setInterval(() => { if (visible()) void syncNow(); }, 60_000);

  setInterval(async () => {
    if (!visible() || running) return;
    try {
      const state = await getSyncState();
      if (state.rev !== getLastRev()) void syncNow();
      else setStatus({ connected: true });
    } catch (err) {
      const offline = err instanceof HoardError && err.status === 0;
      if (offline) setStatus({ connected: false, error: errorMessage(err) });
    }
  }, 15_000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void syncNow();
  });
}

/** Entry point from main.tsx (hoard build only): detect the server, then sync. */
export async function bootHoard(): Promise<boolean> {
  const ok = await detectHoard();
  if (ok) startHoardSync();
  return ok;
}

// ─── PDFs → notebook sources ─────────────────────────────────────────────────

/**
 * The stored PDF as a Blob (FSA folder first, then IndexedDB — same order as
 * pdfStorage.getPdfBlobUrl). FSA files are lazy File objects, so `.size` is cheap.
 */
export async function getStoredPdfBlob(subjectId: string, filename: string): Promise<Blob | null> {
  const fsa = await readPdfFromFolder(subjectId, filename);
  if (fsa) return fsa;
  const rec = await db.pdfResources
    .where('subjectId').equals(subjectId)
    .filter((r) => r.filename === filename)
    .first();
  return rec?.blob ?? null;
}

export interface PdfUploadProgress {
  done: number;
  total: number;
  current?: string;
}

/**
 * Uploads the subject's locally stored PDFs (FSA folder / IndexedDB) that the
 * server's notebook doesn't have yet, compared by filename + size via
 * GET /api/notebook/sources?subject=. Returns the uploaded filenames.
 */
export async function uploadMissingPdfs(
  localSubjectId: string,
  onProgress?: (p: PdfUploadProgress) => void,
): Promise<string[]> {
  if (!isHoardMode()) return [];
  const serverSubject = serverIdFor('subject', localSubjectId);
  const names = (await listStoredPdfs(localSubjectId)).filter((n) => n.toLowerCase().endsWith('.pdf'));
  if (names.length === 0) return [];

  const blobs = new Map<string, Blob>();
  const local: { name: string; size: number }[] = [];
  for (const name of names) {
    const blob = await getStoredPdfBlob(localSubjectId, name);
    if (!blob) continue;
    blobs.set(name, blob);
    local.push({ name, size: blob.size });
  }

  const server = await listSources(serverSubject);
  const missing = pdfsToUpload(local, server.map((s) => ({ filename: s.filename, bytes: s.bytes })));
  const uploaded: string[] = [];
  let done = 0;
  onProgress?.({ done, total: missing.length });
  for (const m of missing) {
    onProgress?.({ done, total: missing.length, current: basename(m.name) });
    const blob = blobs.get(m.name)!;
    await uploadSource(serverSubject, basename(m.name), blob.type ? blob : new Blob([blob], { type: 'application/pdf' }));
    uploaded.push(basename(m.name));
    done++;
    onProgress?.({ done, total: missing.length });
  }
  return uploaded;
}
