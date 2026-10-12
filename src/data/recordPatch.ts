import { db } from './db';
import { isHoardMode } from './hoardMode';
import { hoardJson } from './hoardClient';
import { KIND_TABLE, parseIdMap, toLocalIds, type RecordKind } from './hoardSyncCore';
import { serverRecordId } from './copilotCore';

/** Return true after a native server patch, false for the standalone/offline PWA. */
export async function saveRecordPatch(kind: RecordKind, id: string, data: object): Promise<boolean> {
  if (!isHoardMode()) return false;
  const { syncNow } = await import('./hoardSync');
  await syncNow();
  const current = await db.table(KIND_TABLE[kind]).get(id);
  const patch = Object.fromEntries(Object.entries(data).filter(([key]) =>
    !['id', 'createdAt', 'updatedAt', 'contentHash'].includes(key)).map(([key, value]) => [key, value ?? null]));
  for (const key of ['subjectId', 'topicId'] as const) {
    if (typeof patch[key] === 'string') patch[key] = serverRecordId(key === 'subjectId' ? 'subject' : 'topic', patch[key]);
  }
  if (Array.isArray(patch.topicIds)) patch.topicIds = patch.topicIds.map(id => serverRecordId('topic', id));
  const result = await hoardJson<{ record: Record<string, unknown> }>(
    `/bank/records/${kind}/${encodeURIComponent(serverRecordId(kind, id))}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
  const local: Record<string, unknown> = { ...result.record, id };
  // Remap actual returned references, including references changed by another tool.
  const map = parseIdMap(localStorage.getItem('hypatia-id-map'));
  async function localRef(kind: RecordKind, serverId: string, previous?: string): Promise<string> {
    if (previous && serverRecordId(kind, previous) === serverId) return previous;
    for (const candidate of toLocalIds(map, kind, serverId)) {
      if (await db.table(KIND_TABLE[kind]).get(candidate)) return candidate;
    }
    return serverId;
  }
  for (const key of ['subjectId', 'topicId'] as const) {
    if (typeof local[key] === 'string') local[key] = await localRef(key === 'subjectId' ? 'subject' : 'topic', local[key], current?.[key]);
  }
  if (Array.isArray(local.topicIds)) local.topicIds = await Promise.all(local.topicIds.map(id => localRef('topic', id)));
  await db.table(KIND_TABLE[kind]).put(local);
  return true;
}
