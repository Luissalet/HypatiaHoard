/**
 * teacherSync.ts — sincroniza los datos del Profesor (IndexedDB) con el servidor
 * local de Hypatia. Solo en modo Hypatia; nunca toca la copia de Gist.
 *
 * Ciclo: push de pendientes y borrados → POST /api/teacher/sync/push; pull de lo
 * cambiado desde la última revisión → GET /api/teacher/sync/pull?since=N, aplicado
 * con «gana la última escritura» (teacherSyncCore.decideRemote).
 * Disparadores: arranque, cambios locales (2 s), cada 15 s si la revisión del
 * servidor cambió (un trabajo de corrección o una herramienta de Faustus), y a demanda.
 */

import { hoardJson, HoardError } from './hoardClient';
import { isHoardMode } from './hoardMode';
import {
  TEACHER_REV_KEY, decideRemote, isTeacherKind, parsePendingKey, pendingKey, remainingPending, type WireRecord,
} from './teacherSyncCore';
import {
  notifyTeacherChanged, readDeletes, readPending, setTeacherSyncScheduler, tableOf, writeDeletes, writePending,
} from './teacherRepo';

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function getTeacherRev(): number {
  const n = Number(lsGet(TEACHER_REV_KEY) ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface TeacherSyncStatus {
  lastSyncAt: string | null;
  error: string | null;
  syncing: boolean;
}

let status: TeacherSyncStatus = { lastSyncAt: null, error: null, syncing: false };
export function getTeacherSyncStatus(): TeacherSyncStatus { return status; }

async function push(): Promise<void> {
  const pending = readPending();
  const deletes = readDeletes();
  if (!pending.length && !deletes.length) return;
  const records: WireRecord[] = [];
  const sent: Record<string, string> = {};
  for (const key of pending) {
    const ref = parsePendingKey(key);
    if (!ref) continue;
    const row = await tableOf(ref.kind).get(ref.id);
    if (!row?.updatedAt) continue;
    records.push({ kind: ref.kind, id: ref.id, updatedAt: row.updatedAt, deleted: false, data: row as unknown as Record<string, unknown> });
    sent[key] = row.updatedAt;
  }
  for (const d of deletes) records.push({ kind: d.kind, id: d.id, updatedAt: d.deletedAt, deleted: true, data: null });
  const res = await hoardJson<{ rev: number; applied: number; stale: { kind: string; id: string }[] }>('/teacher/sync/push', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }),
  });
  const current: Record<string, string | undefined> = {};
  for (const key of readPending()) {
    const ref = parsePendingKey(key);
    if (ref) current[key] = (await tableOf(ref.kind).get(ref.id))?.updatedAt;
  }
  writePending(remainingPending(readPending(), sent, current, res.stale ?? []));
  const sentDeletes = new Set(deletes.map((d) => `${pendingKey(d.kind, d.id)}@${d.deletedAt}`));
  writeDeletes(readDeletes().filter((d) => !sentDeletes.has(`${pendingKey(d.kind, d.id)}@${d.deletedAt}`)));
}

async function pull(): Promise<boolean> {
  const since = getTeacherRev();
  const res = await hoardJson<{ rev: number; records: WireRecord[] }>(`/teacher/sync/pull?since=${since}`);
  const pending = new Set(readPending());
  let changed = false;
  for (const r of res.records ?? []) {
    if (!isTeacherKind(r.kind) || typeof r.id !== 'string') continue;
    const table = tableOf(r.kind);
    const local = await table.get(r.id);
    const decision = decideRemote(local, { updatedAt: r.updatedAt, deleted: !!r.deleted }, pending.has(pendingKey(r.kind, r.id)));
    if (decision === 'apply' && r.data && local?.updatedAt !== r.updatedAt) {
      await table.put(r.data as { id: string; updatedAt?: string });
      changed = true;
    } else if (decision === 'delete') {
      await table.delete(r.id);
      changed = true;
    }
  }
  if (Number.isFinite(res.rev)) lsSet(TEACHER_REV_KEY, String(res.rev));
  return changed;
}

let running: Promise<void> | null = null;
let rerun = false;

/** Un ciclo ahora (uno a la vez; si llega otra petición durante el ciclo, se repite). */
export function teacherSyncNow(): Promise<void> {
  if (!isHoardMode()) return Promise.resolve();
  if (running) { rerun = true; return running; }
  running = (async () => {
    try {
      do {
        rerun = false;
        status = { ...status, syncing: true };
        try {
          await push();
          const changed = await pull();
          status = { lastSyncAt: new Date().toISOString(), error: null, syncing: false };
          if (changed) notifyTeacherChanged();
        } catch (err) {
          status = { ...status, syncing: false, error: err instanceof HoardError || err instanceof Error ? err.message : String(err) };
        }
      } while (rerun);
    } finally {
      running = null;
    }
  })();
  return running;
}

let soon: ReturnType<typeof setTimeout> | null = null;
function scheduleSoon(): void {
  if (soon) return;
  soon = setTimeout(() => { soon = null; void teacherSyncNow(); }, 2000);
}

let started = false;
export function startTeacherSync(): void {
  if (started || !isHoardMode()) return;
  started = true;
  setTeacherSyncScheduler(scheduleSoon);
  void teacherSyncNow();
  setInterval(async () => {
    if (document.visibilityState !== 'visible' || running) return;
    try {
      const state = await hoardJson<{ rev: number }>('/teacher/sync/state');
      if (state.rev !== getTeacherRev() || readPending().length || readDeletes().length) void teacherSyncNow();
    } catch { /* sin servidor: se reintenta */ }
  }, 15_000);
}
