/**
 * hoardSyncCore.ts
 *
 * Pure helpers for hoardSync.ts (no Dexie, no fetch, no DOM) so they can be
 * unit-checked with plain node. Only hoard-mode code imports this module.
 */

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** Record kinds as named by the server store (SPEC "Records store"). */
export type RecordKind =
  | 'subject' | 'topic' | 'question' | 'session' | 'pdfAnchor'
  | 'keyConcept' | 'exam' | 'deliverable' | 'gradingConfig' | 'installedPackage';

/** Dexie table for each kind. */
export const KIND_TABLE: Record<RecordKind, string> = {
  subject: 'subjects',
  topic: 'topics',
  question: 'questions',
  session: 'sessions',
  pdfAnchor: 'pdfAnchors',
  keyConcept: 'keyConcepts',
  exam: 'exams',
  deliverable: 'deliverables',
  gradingConfig: 'gradingConfigs',
  installedPackage: 'installedPackages',
};

/** Tables whose local deletions are queued for the server (SPEC: Dexie `deleting` hooks). */
export const DELETE_TRACKED: RecordKind[] = [
  'subject', 'topic', 'question', 'keyConcept', 'exam', 'deliverable', 'session', 'pdfAnchor',
];

/** Tables whose writes mark the local state dirty (worth a push). */
export const DIRTY_TRACKED_TABLES = [
  'subjects', 'topics', 'questions', 'sessions', 'pdfAnchors', 'keyConcepts',
  'exams', 'deliverables', 'gradingConfigs', 'questionImages', 'installedPackages',
];

export function isRecordKind(k: unknown): k is RecordKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(KIND_TABLE, k);
}

// ─── Pending deletes queue ───────────────────────────────────────────────────

export interface PendingDelete {
  kind: RecordKind;
  id: string;
  deletedAt: string;
}

export const PENDING_DELETES_KEY = 'hypatia-pending-deletes';
export const LAST_REV_KEY = 'hypatia-last-rev';
export const ID_MAP_KEY = 'hypatia-id-map';

export function deleteKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** Adds a delete to the queue, replacing an older entry for the same record. */
export function enqueueDelete(queue: PendingDelete[], entry: PendingDelete): PendingDelete[] {
  const k = deleteKey(entry.kind, entry.id);
  return [...queue.filter((e) => deleteKey(e.kind, e.id) !== k), entry];
}

/** Removes the entries that were sent (matched by kind+id+deletedAt, so re-deletes survive). */
export function removeSent(queue: PendingDelete[], sent: PendingDelete[]): PendingDelete[] {
  const sentKeys = new Set(sent.map((e) => `${deleteKey(e.kind, e.id)}@${e.deletedAt}`));
  return queue.filter((e) => !sentKeys.has(`${deleteKey(e.kind, e.id)}@${e.deletedAt}`));
}

export function parseQueue(raw: string | null): PendingDelete[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && isRecordKind(e.kind) && typeof e.id === 'string')
      .map((e) => ({ kind: e.kind, id: e.id, deletedAt: String(e.deletedAt ?? new Date(0).toISOString()) }));
  } catch {
    return [];
  }
}

// ─── Id map (PWA id ↔ server id) ─────────────────────────────────────────────

/**
 * When the server dedupes a pushed record onto an existing one (same slug /
 * content hash), push returns idMap { subjects: { pwaId: serverId } }.
 * We remember it so queued deletes and incoming tombstones hit the right row.
 */
export type IdMap = Partial<Record<RecordKind, Record<string, string>>>;

const IDMAP_GROUPS: Record<string, RecordKind> = {
  subjects: 'subject', topics: 'topic', questions: 'question',
  subject: 'subject', topic: 'topic', question: 'question',
};

export function mergeIdMap(current: IdMap, fromServer: unknown): IdMap {
  const next: IdMap = { ...current };
  if (!fromServer || typeof fromServer !== 'object') return next;
  for (const [group, entries] of Object.entries(fromServer as Record<string, unknown>)) {
    const kind = IDMAP_GROUPS[group];
    if (!kind || !entries || typeof entries !== 'object') continue;
    const bucket = { ...(next[kind] ?? {}) };
    for (const [pwaId, serverId] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof serverId === 'string' && serverId && serverId !== pwaId) bucket[pwaId] = serverId;
    }
    // Cap memory: keep the most recent 2000 entries per kind
    const keys = Object.keys(bucket);
    if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete bucket[k];
    next[kind] = bucket;
  }
  return next;
}

export function toServerId(map: IdMap, kind: RecordKind, localId: string): string {
  return map[kind]?.[localId] ?? localId;
}

/** Local ids that correspond to a server id (the id itself plus mapped aliases). */
export function toLocalIds(map: IdMap, kind: RecordKind, serverId: string): string[] {
  const ids = [serverId];
  const bucket = map[kind];
  if (bucket) for (const [pwaId, sid] of Object.entries(bucket)) if (sid === serverId) ids.push(pwaId);
  return ids;
}

/**
 * The queued deletes as the server must see them. The server dedupes a pushed duplicate onto
 * the existing record (idMap), so the duplicate and the original share one server id: deleting
 * one local copy must not delete that server record while another local copy still maps to it
 * (its tombstone would then remove the surviving copy on every device). Those are dropped.
 */
export async function serverDeletes(
  queue: PendingDelete[],
  map: IdMap,
  isLive: (kind: RecordKind, localId: string) => Promise<boolean>,
): Promise<PendingDelete[]> {
  const out: PendingDelete[] = [];
  for (const d of queue) {
    const serverId = toServerId(map, d.kind, d.id);
    let shared = false;
    for (const localId of toLocalIds(map, d.kind, serverId)) {
      if (localId !== d.id && await isLive(d.kind, localId)) { shared = true; break; }
    }
    if (!shared) out.push({ kind: d.kind, id: serverId, deletedAt: d.deletedAt });
  }
  return out;
}

export function parseIdMap(raw: string | null): IdMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as IdMap) : {};
  } catch {
    return {};
  }
}

// ─── Pulled backup normalisation ─────────────────────────────────────────────

const BACKUP_ARRAYS = [
  'subjects', 'topics', 'questions', 'sessions', 'pdfAnchors',
  'keyConcepts', 'exams', 'deliverables', 'gradingConfigs', 'installedPackages',
] as const;

/** Fills missing arrays/objects so mergeBackup never trips over a partial pull. */
export function normalizePulledBackup<T extends Record<string, unknown>>(raw: unknown): T {
  const b = { ...((raw ?? {}) as Record<string, unknown>) };
  for (const k of BACKUP_ARRAYS) if (!Array.isArray(b[k])) b[k] = [];
  if (!b.questionImages || typeof b.questionImages !== 'object') b.questionImages = {};
  const ss = (b.syncedSettings ?? {}) as Record<string, unknown>;
  b.syncedSettings = {
    ...ss,
    alias: typeof ss.alias === 'string' ? ss.alias : '',
    importedPackIds: Array.isArray(ss.importedPackIds) ? ss.importedPackIds : [],
  };
  b.version = 2;
  b.kind = 'full-backup';
  if (typeof b.exportedAt !== 'string') b.exportedAt = new Date().toISOString();
  if (typeof b.deviceId !== 'string') b.deviceId = 'hypatia-server';
  // Server never sends PDFs/WAVs
  delete b.pdfManifest;
  delete b.pregenManifest;
  return b as T;
}

export function countRecords(b: Record<string, unknown>): number {
  let n = 0;
  for (const k of BACKUP_ARRAYS) n += Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0;
  n += Object.keys((b.questionImages as object) ?? {}).length;
  return n;
}

// ─── PDF upload diff ─────────────────────────────────────────────────────────

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Which local PDFs the server lacks: compared by basename (case-insensitive)
 * and size. A same-named source with a different size is re-uploaded.
 * `serverSizes` maps lowercase basename → bytes (undefined when unknown).
 */
export function pdfsToUpload(
  local: { name: string; size: number }[],
  server: { filename: string; bytes?: number }[],
): { name: string; size: number }[] {
  const serverSizes = new Map<string, number | undefined>();
  for (const s of server) serverSizes.set(basename(s.filename).toLowerCase(), s.bytes);
  return local.filter((l) => {
    const key = basename(l.name).toLowerCase();
    if (!serverSizes.has(key)) return true;
    const bytes = serverSizes.get(key);
    return bytes !== undefined && bytes !== null && Number(bytes) !== l.size;
  });
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** "ahora", "hace 3 min", "hace 2 h", "hace 4 d". */
export function timeAgoEs(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'nunca';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'nunca';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'ahora';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}
