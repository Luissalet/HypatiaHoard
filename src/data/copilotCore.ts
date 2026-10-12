import { parseIdMap, toServerId, type RecordKind } from './hoardSyncCore';

export function changedFields<T extends object>(initial: Partial<T>, draft: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
    JSON.stringify(value) !== JSON.stringify((initial as Record<string, unknown>)[key]))) as Partial<T>;
}

export function changedObjectFields(initial: object, draft: object): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    const before = (initial as Record<string, unknown>)[key];
    if (JSON.stringify(value) === JSON.stringify(before)) continue;
    patch[key] = value && before && typeof value === 'object' && typeof before === 'object' &&
      !Array.isArray(value) && !Array.isArray(before) ? changedObjectFields(before, value) : value ?? null;
  }
  return patch;
}

export function routeObjects(hash: string): { kind: RecordKind; id: string }[] {
  const path = hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  const out: { kind: RecordKind; id: string }[] = [];
  const add = (kind: RecordKind, id?: string) => {
    if (id && id !== 'new') out.push({ kind, id: decodeURIComponent(id) });
  };
  if (path[0] === 'subject') {
    add('subject', path[1]);
    if (path[2] === 'read' || path[2] === 'listen') add('topic', path[3]);
  } else if (path[0] === 'flashcard') add('subject', path[1]);
  else if (path[0] === 'practice' || path[0] === 'results') add('session', path[1]);
  return out;
}

export function serverRecordId(kind: RecordKind, id: string): string {
  return toServerId(parseIdMap(localStorage.getItem('hypatia-id-map')), kind, id);
}

/** Only form values in the app, never the embedded chat's composer or file/password inputs. */
export function editorContext() {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    '#root input, #root textarea, #root select'))
    .filter(field => !['hidden', 'password', 'file', 'submit', 'button'].includes(field.type) &&
      field.getClientRects().length && !field.disabled)
    .map(field => ({ label: field.labels?.[0]?.textContent?.trim() || field.closest('label')?.textContent?.trim() ||
      field.parentElement?.querySelector('label')?.textContent?.trim() || field.getAttribute('aria-label') ||
      field.name || field.getAttribute('placeholder') || field.id || field.type,
      type: field.type, value: field.type === 'checkbox' || field.type === 'radio'
        ? (field as HTMLInputElement).checked : field.value }));
}

export function editorDrafts(): object[] {
  const snapshots: object[] = [];
  window.dispatchEvent(new CustomEvent('hypatia:context-request', {
    detail: { provide: (snapshot: object) => snapshots.push(snapshot) },
  }));
  return snapshots;
}
