import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { hoardJson } from '@/data/hoardClient';
import { useHoardMode } from '@/data/hoardMode';
import { editorContext, editorDrafts, routeObjects, serverRecordId } from '@/data/copilotCore';
import { isRecordKind } from '@/data/hoardSyncCore';
import { TEACHER_KIND_TABLE } from '@/data/teacherSyncCore';
import './faustus-copilot.css';
import { FaustusMark } from './FaustusMark';

type Panel = HTMLElement & {
  server: string; locale: string; theme: string; session: string | null;
  fetch: typeof fetch; contextProvider: () => Promise<unknown>;
  loadHistory: () => Promise<void>; refreshConversations: () => Promise<void>; onOpenSettings: () => void;
  draft: string; send: (message: string) => Promise<void>;
};

type NotebookRequest = { chatId?: string; mode: string; topicId?: string; draft?: string; send?: boolean; route?: string };

export function FaustusCopilot() {
  const hoard = useHoardMode();
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const page = useLocation();
  const route = '#' + page.pathname + page.search + page.hash;
  const host = useRef<HTMLDivElement>(null);
  const panelRef = useRef<Panel>();
  const sessionKey = useRef('');
  const pendingNotebook = useRef<NotebookRequest>();
  const notebook = useRef<NotebookRequest>();

  async function continueNotebook(panel: Panel, request: NotebookRequest) {
    notebook.current = request;
    const storageKey = sessionKey.current;
    const context = await panel.contextProvider();
    if (request.chatId) {
      const { chat } = await hoardJson<{ chat: { title: string; messages: {
        id: number; role: string; content: string | null; createdAt: string; citations: unknown[]; meta: object }[] } }>(
          `/notebook/chats/${encodeURIComponent(request.chatId)}`);
      const response = await panel.fetch(new Request(location.origin + '/api/hoard-copilot/imports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          context, source_thread_id: 'notebook:' + request.chatId, name: chat.title,
          messages: chat.messages.map(message => ({ source_id: String(message.id), role: message.role,
            content: message.content || '', created_at: message.createdAt,
            metadata: { ...message.meta, citations: message.citations, notebook_mode: request.mode } })),
        }),
      }));
      if (!response.ok) throw new Error(await response.text());
      const imported = await response.json();
      if (imported.deleted) throw new Error('La conversación importada se borró en Faustus. Abre una conversación nueva.');
      panel.session = imported.session_id;
      if (storageKey) localStorage.setItem(storageKey, imported.session_id);
      await panel.loadHistory();
    }
    if (request.draft) {
      panel.draft = request.draft;
      if (request.send) await panel.send(request.draft);
    }
  }

  useEffect(() => {
    const receive = (event: Event) => {
      const request = { ...(event as CustomEvent<NotebookRequest>).detail, route: location.hash };
      setOpen(true);
      if (panelRef.current?.isConnected) void continueNotebook(panelRef.current, request).catch(problem => setError(String(problem)));
      else pendingNotebook.current = request;
    };
    window.addEventListener('hypatia:open-copilot', receive);
    return () => window.removeEventListener('hypatia:open-copilot', receive);
  }, []);

  useEffect(() => { notebook.current = undefined; }, [route]);

  useEffect(() => {
    if (!open || !hoard) return;
    let disposed = false;
    let panel: Panel;
    let scopeKey = '';
    let lastContext: unknown;
    const saveDraft = () => { if (scopeKey && panel) localStorage.setItem(scopeKey + '-draft', panel.draft || ''); };
    async function mount() {
      try {
        const info = await hoardJson<{ app_id: string; app_name: string; data_space_id: string;
          tool_server_id: string; panel_url: string; settings_url: string }>('/copilot/info');
        await import(/* @vite-ignore */ info.panel_url);
        if (disposed) return;
        panel = document.createElement('faustus-chat') as Panel;
        panelRef.current = panel;
        panel.server = window.location.origin;
        panel.locale = document.documentElement.lang || 'es';
        panel.theme = document.documentElement.dataset.theme || 'dark';
        panel.onOpenSettings = () => { window.open(info.settings_url, '_blank', 'noopener'); };
        panel.fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const envelope: Record<string, unknown> = { path: url.pathname + url.search, method: request.method, headers: {} };
          const headers: Record<string, string> = {};
          for (const key of ['X-Faustus-Client-Version', 'X-Odysseus-Run-Id']) {
            const value = request.headers.get(key);
            if (value) headers[key] = value;
          }
          envelope.headers = headers;
          if (!['GET', 'HEAD'].includes(request.method)) {
            const bytes = new Uint8Array(await request.arrayBuffer());
            const type = request.headers.get('Content-Type') || '';
            if (type.startsWith('application/json')) envelope.body = JSON.parse(new TextDecoder().decode(bytes));
            else {
              envelope.content_type = type;
              let binary = '';
              for (const byte of bytes) binary += String.fromCharCode(byte);
              envelope.raw_body = btoa(binary);
            }
          }
          return fetch('/api/copilot/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope), signal: request.signal });
        };
        panel.contextProvider = async () => {
          // A queued turn on a detached panel still belongs to its original view.
          if (lastContext && (disposed || (location.hash || '#/') !== route)) return lastContext;
          // Capture the editor before any record lookup can yield to navigation.
          const hash = location.hash;
          const text = window.getSelection()?.toString() || '';
          const selection = text ? { kind: 'text', text } : null;
          const view = { route: hash || '#/', title: document.title,
            heading: document.querySelector('h1')?.textContent, locale: panel.locale,
            ...(hash.includes('/notebook') ? { notebook: notebook.current } : {}),
            editor: { fields: editorContext(), objects: editorDrafts() } };
          const origin = { app_id: info.app_id, app_name: info.app_name, data_space_id: info.data_space_id,
            tool_server_id: info.tool_server_id, surface: 'editor' };
          const refs: { kind: string; id: string }[] = routeObjects(hash);
          for (const form of document.querySelectorAll<HTMLElement>('[data-copilot-kind][data-copilot-id]')) {
            const kind = form.dataset.copilotKind, id = form.dataset.copilotId;
            if (kind && (isRecordKind(kind) || kind in TEACHER_KIND_TABLE) && id && id !== 'new') refs.push({ kind, id });
          }
          const teacher = /^#\/teacher\/(exam|batch)\/([^?#]+)/.exec(hash);
          if (teacher && teacher[2] !== 'new') refs.push({ kind: teacher[1] === 'exam' ? 'teacherExam' : 'gradingBatch', id: decodeURIComponent(teacher[2]) });
          const active_objects: { kind: string; object_id: string; title?: string }[] = [];
          for (const ref of refs) {
            const id = isRecordKind(ref.kind) ? serverRecordId(ref.kind, ref.id) : ref.id;
            try {
              const result = await hoardJson<{ record: Record<string, string> }>(`/bank/records/${ref.kind}/${encodeURIComponent(id)}`);
              if (ref.kind === 'topic' && !active_objects.some(item => item.kind === 'subject' && item.object_id === result.record.subjectId)) continue;
              if (!active_objects.some(item => item.kind === ref.kind && item.object_id === result.record.id)) {
                active_objects.push({ kind: ref.kind, object_id: result.record.id,
                  title: result.record.name || result.record.title || result.record.prompt });
              }
              if (result.record.subjectId && !active_objects.some(item => item.kind === 'subject')) {
                try {
                  const parent = await hoardJson<{ record: Record<string, string> }>(`/bank/records/subject/${encodeURIComponent(result.record.subjectId)}`);
                  active_objects.push({ kind: 'subject', object_id: parent.record.id, title: parent.record.name });
                } catch (problem) {
                  if (!(problem instanceof Error && 'status' in problem && problem.status === 404)) throw problem;
                }
              }
            } catch (problem) {
              if (!(problem instanceof Error && 'status' in problem && problem.status === 404)) throw problem;
            }
          }
          const subject = active_objects.find(item => item.kind === 'subject');
          const context = { origin, ...(subject ? { project: { external_project_id: subject.object_id, title: subject.title } } : {}),
            active_objects, selection, view };
          lastContext = context;
          return context;
        };
        const context = await panel.contextProvider() as { project?: { external_project_id: string } };
        if (disposed) return;
        scopeKey = 'hypatia-faustus-' + info.data_space_id + '-' + (context.project?.external_project_id || 'global');
        sessionKey.current = scopeKey;
        panel.session = localStorage.getItem(scopeKey);
        panel.draft = localStorage.getItem(scopeKey + '-draft') || '';
        panel.addEventListener('faustus:session-change', event => {
          const id = (event as CustomEvent).detail.sessionId;
          if (!scopeKey) return;
          if (id) localStorage.setItem(scopeKey, id); else localStorage.removeItem(scopeKey);
        });
        panel.addEventListener('faustus:turn-end', () => {
          void Promise.all([import('@/data/hoardSync').then(m => m.syncNow()),
            import('@/data/teacherSync').then(m => m.teacherSyncNow())]).catch(problem => setError(String(problem)));
        });
        host.current?.replaceChildren(panel);
        await panel.loadHistory();
        if (pendingNotebook.current) {
          const request = pendingNotebook.current;
          pendingNotebook.current = undefined;
          if (!disposed && request.route === location.hash) await continueNotebook(panel, request);
        }
        if (!disposed) setError('');
      } catch (problem) { if (!disposed) setError(String(problem)); }
    }
    void mount();
    return () => { saveDraft(); disposed = true; panel?.remove(); if (panelRef.current === panel) panelRef.current = undefined; };
  }, [open, hoard, route]);

  useEffect(() => { if (panelRef.current) panelRef.current.theme = theme; }, [theme]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (panelRef.current) panelRef.current.locale = document.documentElement.lang || 'es';
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);
  if (!hoard) return null;
  return <>
    <button className="hypatia-copilot-toggle" type="button" aria-label="Faustus" title="Faustus" aria-expanded={open} onClick={() => setOpen(value => !value)}><FaustusMark /></button>
    {open && <aside className="hypatia-copilot" aria-label="Faustus">
      <header><strong>Faustus · Hypatia</strong><button type="button" aria-label="Cerrar Faustus" onClick={() => setOpen(false)}>×</button></header>
      {error && <p role="alert">{error}</p>}<div ref={host} className="hypatia-copilot-host" />
    </aside>}
  </>;
}
