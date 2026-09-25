/**
 * hoardClient.ts
 *
 * HTTP client for the local Hypatia's Hoard server (same origin, /api/*).
 * Only loaded/used in hoard mode (see hoardMode.ts). Every call except
 * detectHoard() refuses to run when isHoardMode() is false, so nothing here
 * can reach the network from the public PWA.
 *
 * Server responses are normalised defensively (snake_case or camelCase,
 * bare arrays or wrapped lists) so small shape drifts don't break the UI.
 */

import { HOARD_BUILD, isHoardMode, setHoardDetection } from './hoardMode';

const API = '/api';

// ─── Errors / fetch ──────────────────────────────────────────────────────────

export class HoardError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
    this.name = 'HoardError';
  }
}

/** Raw fetch against the hoard API (path relative to /api, e.g. '/sync/state'). */
export async function hoardFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!isHoardMode()) throw new HoardError('Hypatia no está disponible.');
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new HoardError('No se puede conectar con Hypatia (servidor local).');
  }
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body = await res.clone().json();
      const detail = body?.detail ?? body?.error ?? body?.message;
      if (typeof detail === 'string') message = detail;
      else if (Array.isArray(detail) && detail[0]?.msg) message = String(detail[0].msg);
    } catch {
      try {
        const text = await res.text();
        if (text) message = text.slice(0, 200);
      } catch { /* ignore */ }
    }
    throw new HoardError(message, res.status);
  }
  return res;
}

export async function hoardJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await hoardFetch(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * Checks GET /api/health → { service: 'hypatia-hoard' }. Flips hoard mode on
 * or off. Always false (and no request) in the public build.
 */
export async function detectHoard(timeoutMs = 3000): Promise<boolean> {
  if (!HOARD_BUILD) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/health`, { signal: ctrl.signal, cache: 'no-store' });
    const body = res.ok ? await res.json() : null;
    const ok = body?.service === 'hypatia-hoard';
    setHoardDetection(ok ? 'on' : 'off');
    return ok;
  } catch {
    setHoardDetection('off');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Capabilities ────────────────────────────────────────────────────────────

export interface HoardCapabilities {
  llm: boolean;
  embeddings: boolean;
  tts: boolean;
  vision: boolean;
}

export const NO_CAPABILITIES: HoardCapabilities = { llm: false, embeddings: false, tts: false, vision: false };

let capsCache: { at: number; caps: HoardCapabilities } | null = null;

export function normalizeCapabilities(status: unknown): HoardCapabilities {
  const s = (status ?? {}) as Record<string, unknown>;
  const models = (s.models ?? s.capabilities ?? {}) as Record<string, unknown>;
  const flag = (k: string) => {
    const v = models[k];
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') return Boolean((v as Record<string, unknown>).available ?? (v as Record<string, unknown>).ok ?? true);
    return Boolean(v);
  };
  return { llm: flag('llm'), embeddings: flag('embeddings'), tts: flag('tts'), vision: flag('vision') };
}

/** Capabilities from GET /api/status (cached 30 s). Never throws. */
export async function getCapabilities(force = false): Promise<HoardCapabilities> {
  if (!isHoardMode()) return NO_CAPABILITIES;
  if (!force && capsCache && Date.now() - capsCache.at < 30_000) return capsCache.caps;
  try {
    const caps = normalizeCapabilities(await hoardJson('/status'));
    capsCache = { at: Date.now(), caps };
    return caps;
  } catch {
    return capsCache?.caps ?? NO_CAPABILITIES;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function pick<T = unknown>(o: Obj, ...keys: string[]): T | undefined {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T;
  return undefined;
}

function asList(r: unknown, ...keys: string[]): Obj[] {
  if (Array.isArray(r)) return r as Obj[];
  const o = (r ?? {}) as Obj;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as Obj[];
  return [];
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

// ─── Citations ───────────────────────────────────────────────────────────────

export interface Citation {
  n: number;
  sourceId?: string;
  filename?: string;
  title?: string;
  page?: number;
  snippet?: string;
}

export function normalizeCitation(raw: unknown, index = 0): Citation {
  const o = (raw ?? {}) as Obj;
  const n = Number(pick(o, 'n', 'index', 'ref') ?? index + 1);
  const page = pick<number | string>(o, 'page', 'pageNumber', 'page_number');
  return {
    n: Number.isFinite(n) ? n : index + 1,
    sourceId: pick(o, 'sourceId', 'source_id'),
    filename: pick(o, 'filename', 'file'),
    title: pick(o, 'title', 'heading'),
    page: page === undefined ? undefined : Number(page) || undefined,
    snippet: pick(o, 'snippet', 'text', 'passage'),
  };
}

export function normalizeCitations(raw: unknown): Citation[] {
  return Array.isArray(raw) ? raw.map((c, i) => normalizeCitation(c, i)) : [];
}

// ─── Sources ─────────────────────────────────────────────────────────────────

export type SourceStatus = 'pending' | 'indexed' | 'error' | string;

export interface NotebookSource {
  id: string;
  subjectId?: string;
  origin: string;
  filename: string;
  title?: string;
  kind?: string;
  pages?: number;
  chunks?: number;
  bytes?: number;
  status: SourceStatus;
  error?: string;
  addedAt?: string;
  indexedAt?: string;
}

function normalizeSource(o: Obj): NotebookSource {
  return {
    id: String(pick(o, 'id') ?? ''),
    subjectId: pick(o, 'subjectId', 'subject_id'),
    origin: String(pick(o, 'origin') ?? ''),
    filename: String(pick(o, 'filename', 'path') ?? ''),
    title: pick(o, 'title'),
    kind: pick(o, 'kind'),
    pages: pick(o, 'pages'),
    chunks: pick(o, 'chunks', 'chunkCount', 'chunk_count'),
    bytes: pick(o, 'bytes', 'size'),
    status: String(pick(o, 'status') ?? 'pending'),
    error: pick(o, 'error'),
    addedAt: pick(o, 'addedAt', 'added_at'),
    indexedAt: pick(o, 'indexedAt', 'indexed_at'),
  };
}

export async function listSources(subject: string): Promise<NotebookSource[]> {
  const r = await hoardJson(`/notebook/sources${qs({ subject })}`);
  return asList(r, 'sources', 'items').map(normalizeSource);
}

export async function uploadSource(subject: string, filename: string, body: Blob): Promise<unknown> {
  const lower = filename.toLowerCase();
  const type = body.type || (lower.endsWith('.pdf') ? 'application/pdf'
    : lower.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : lower.endsWith('.md') ? 'text/markdown' : 'text/plain');
  return hoardJson(`/sources/upload${qs({ subject, filename })}`, {
    method: 'PUT',
    headers: { 'Content-Type': type },
    body,
  });
}

export async function rescanSources(subject?: string): Promise<unknown> {
  return hoardJson('/notebook/sources/rescan', jsonInit('POST', subject ? { subject } : {}));
}

export async function deleteSource(id: string): Promise<void> {
  await hoardJson(`/notebook/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Ask / tutor / chats ─────────────────────────────────────────────────────

export interface Passage extends Citation {}

export interface AskResult {
  answer: string | null;
  citations: Citation[];
  passages: Passage[];
  chatId?: string;
  model?: string;
  note?: string;
}

export async function ask(params: {
  subject: string; question: string; topic?: string; sourceIds?: string[]; chatId?: string;
}): Promise<AskResult> {
  const r = (await hoardJson('/notebook/ask', jsonInit('POST', params))) as Obj;
  return {
    answer: (pick<string>(r, 'answer') ?? null),
    citations: normalizeCitations(r.citations),
    passages: normalizeCitations(r.passages),
    chatId: pick(r, 'chatId', 'chat_id'),
    model: pick(r, 'model'),
    note: pick(r, 'note'),
  };
}

export interface TutorResult {
  reply: string | null;
  citations: Citation[];
  passages: Passage[];
  weak: Obj[];
  chatId?: string;
  note?: string;
}

export async function tutorTurn(params: {
  subject: string; message: string; topic?: string; chatId?: string;
}): Promise<TutorResult> {
  const r = (await hoardJson('/notebook/tutor', jsonInit('POST', params))) as Obj;
  return {
    reply: (pick<string>(r, 'reply', 'answer') ?? null),
    citations: normalizeCitations(r.citations),
    passages: normalizeCitations(r.passages),
    weak: asList(r.weak),
    chatId: pick(r, 'chatId', 'chat_id'),
    note: pick(r, 'note'),
  };
}

export interface ChatSummary {
  id: string;
  mode: string;
  title?: string;
  topic?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | string;
  content: string;
  citations: Citation[];
  createdAt?: string;
}

function normalizeChat(o: Obj): ChatSummary {
  return {
    id: String(pick(o, 'id') ?? ''),
    mode: String(pick(o, 'mode') ?? 'sources'),
    title: pick(o, 'title', 'firstMessage', 'first_message'),
    topic: pick(o, 'topic', 'topicId', 'topic_id'),
    updatedAt: pick(o, 'updatedAt', 'updated_at', 'createdAt', 'created_at'),
  };
}

export async function listChats(subject: string): Promise<ChatSummary[]> {
  const r = await hoardJson(`/notebook/chats${qs({ subject })}`);
  return asList(r, 'chats', 'items').map(normalizeChat);
}

export async function getChat(id: string): Promise<{ chat: ChatSummary; messages: ChatMessage[] }> {
  const r = (await hoardJson(`/notebook/chats/${encodeURIComponent(id)}`)) as Obj;
  const chatObj = ((r.chat as Obj) ?? r) as Obj;
  // The server nests messages inside `chat` ({chat: {..., messages}}); accept top level too.
  const rawMessages = asList(chatObj, 'messages').length ? asList(chatObj, 'messages') : asList(r, 'messages');
  const messages = rawMessages.map((m) => ({
    role: String(pick(m, 'role') ?? 'assistant'),
    content: String(pick(m, 'content', 'text') ?? ''),
    citations: normalizeCitations(pick(m, 'citations')),
    createdAt: pick<string>(m, 'createdAt', 'created_at'),
  }));
  return { chat: normalizeChat(chatObj), messages };
}

export async function deleteChat(id: string): Promise<void> {
  await hoardJson(`/notebook/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Studio ──────────────────────────────────────────────────────────────────

export type StudioKind = 'study_guide' | 'briefing' | 'faq' | 'glossary' | 'timeline' | 'mindmap' | 'podcast';
export type StudioStatus = 'queued' | 'running' | 'done' | 'error';

export interface MindMapNode {
  label: string;
  children?: MindMapNode[];
  refs?: number[];
}

export interface StudioItem {
  id: string;
  kind: StudioKind;
  title: string;
  status: StudioStatus;
  content?: string;
  data?: unknown;
  hasAudio: boolean;
  citations: Citation[];
  model?: string;
  error?: string;
  note?: string;
  progress?: string;
  createdAt?: string;
  finishedAt?: string;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function normalizeStudioItem(o: Obj): StudioItem {
  const audio = pick(o, 'audioPath', 'audio_path', 'audioUrl', 'audio_url', 'hasAudio', 'has_audio');
  return {
    id: String(pick(o, 'id') ?? ''),
    kind: String(pick(o, 'kind') ?? 'study_guide') as StudioKind,
    title: String(pick(o, 'title') ?? ''),
    status: String(pick(o, 'status') ?? 'queued') as StudioStatus,
    content: pick(o, 'content'),
    data: parseMaybeJson(pick(o, 'data')),
    hasAudio: Boolean(audio),
    citations: normalizeCitations(parseMaybeJson(pick(o, 'citations'))),
    model: pick(o, 'model'),
    error: pick(o, 'error'),
    note: pick(o, 'note'),
    progress: pick(o, 'progress', 'stage'),
    createdAt: pick(o, 'createdAt', 'created_at'),
    finishedAt: pick(o, 'finishedAt', 'finished_at'),
  };
}

export async function createStudioItem(params: {
  subject: string; kind: StudioKind; topic?: string; sourceIds?: string[]; instructions?: string;
}): Promise<StudioItem> {
  const r = (await hoardJson('/notebook/studio', jsonInit('POST', params))) as Obj;
  // {item: null, note} (nothing indexed) or {item: null, material, note} (no model): nothing was queued.
  if (r.item === null || (r.item === undefined && !pick(r, 'id', 'jobId', 'job_id'))) {
    throw new HoardError(String(pick(r, 'note') ?? 'No se pudo generar: no hay fuentes indexadas o modelo disponible.'));
  }
  const obj = ((r.item as Obj) ?? r) as Obj;
  const item = normalizeStudioItem(obj);
  if (!item.id) item.id = String(pick(r, 'jobId', 'job_id') ?? '');
  item.kind = item.kind || params.kind;
  return item;
}

export async function listStudioItems(subject: string): Promise<StudioItem[]> {
  const r = await hoardJson(`/notebook/studio${qs({ subject })}`);
  return asList(r, 'items', 'studio').map(normalizeStudioItem);
}

export async function getStudioItem(id: string): Promise<StudioItem> {
  const r = (await hoardJson(`/notebook/studio/${encodeURIComponent(id)}`)) as Obj;
  return normalizeStudioItem(((r.item as Obj) ?? r) as Obj);
}

export async function deleteStudioItem(id: string): Promise<void> {
  await hoardJson(`/notebook/studio/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function studioAudioUrl(id: string): string {
  return `${API}/notebook/studio/${encodeURIComponent(id)}/audio`;
}

export async function studioToConcepts(id: string): Promise<Obj> {
  return (await hoardJson(`/notebook/studio/${encodeURIComponent(id)}/to-concepts`, jsonInit('POST', {}))) as Obj;
}

export async function studioToQuestions(id: string): Promise<Obj> {
  return (await hoardJson(`/notebook/studio/${encodeURIComponent(id)}/to-questions`, jsonInit('POST', {}))) as Obj;
}

/**
 * Polls GET /api/notebook/studio/{id} every `intervalMs` until done/error.
 * `onUpdate` gets every intermediate state. Abort with the signal.
 */
export async function pollStudioItem(
  id: string,
  onUpdate: (item: StudioItem) => void,
  signal?: AbortSignal,
  intervalMs = 2000,
): Promise<StudioItem> {
  for (;;) {
    if (signal?.aborted) throw new HoardError('Cancelado');
    const item = await getStudioItem(id);
    onUpdate(item);
    if (item.status === 'done' || item.status === 'error') return item;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

// ─── Sync API (used by hoardSync.ts) ─────────────────────────────────────────

export interface SyncState {
  rev: number;
  counts?: Record<string, number>;
  deviceIds?: string[];
  lastPushAt?: string;
}

export async function getSyncState(): Promise<SyncState> {
  const r = (await hoardJson('/sync/state')) as Obj;
  return { ...(r as object), rev: Number(r.rev ?? 0) } as SyncState;
}
