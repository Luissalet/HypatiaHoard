/**
 * StudioPanel.tsx
 *
 * "Estudio" tab: launch generation jobs (guides, FAQ, glossary, timeline,
 * mind map, audio overview), follow their progress (GET /api/notebook/studio/{id}
 * every 2 s until done/error) and browse the generated items.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Select, EmptyState } from '@/ui/components';
import {
  createStudioItem, listStudioItems, pollStudioItem, deleteStudioItem, getStudioItem,
  type StudioItem, type StudioKind,
} from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';
import { StudioItemView, STUDIO_KINDS, studioKindLabel } from './StudioItemView';

function sortItems(items: StudioItem[]): StudioItem[] {
  return [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export function StudioPanel() {
  const { serverSubjectId, topics, caps, serverTopicId } = useNotebook();
  const [items, setItems] = useState<StudioItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [starting, setStarting] = useState<StudioKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const polling = useRef(new Map<string, AbortController>());

  const upsert = useCallback((item: StudioItem) => {
    setItems((prev) => {
      const list = prev ?? [];
      const i = list.findIndex((x) => x.id === item.id);
      if (i === -1) return sortItems([item, ...list]);
      const next = [...list];
      next[i] = { ...next[i], ...item };
      return next;
    });
  }, []);

  const follow = useCallback((id: string) => {
    if (!id || polling.current.has(id)) return;
    const ctrl = new AbortController();
    polling.current.set(id, ctrl);
    pollStudioItem(id, upsert, ctrl.signal)
      .catch(() => { /* aborted or network: the list shows the last state */ })
      .finally(() => polling.current.delete(id));
  }, [upsert]);

  // Load list; resume polling of unfinished jobs
  useEffect(() => {
    let cancelled = false;
    listStudioItems(serverSubjectId)
      .then((list) => {
        if (cancelled) return;
        const sorted = sortItems(list);
        setItems(sorted);
        setSelectedId((cur) => cur ?? sorted.find((x) => x.status === 'done')?.id ?? sorted[0]?.id ?? null);
        list.filter((x) => x.status === 'queued' || x.status === 'running').forEach((x) => follow(x.id));
      })
      .catch((e) => { if (!cancelled) { setItems([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { cancelled = true; };
  }, [serverSubjectId, follow]);

  // Stop polling on unmount
  useEffect(() => {
    const map = polling.current;
    return () => { map.forEach((c) => c.abort()); map.clear(); };
  }, []);

  const start = async (kind: StudioKind) => {
    setStarting(kind);
    setError(null);
    try {
      const item = await createStudioItem({
        subject: serverSubjectId,
        kind,
        topic: topicId ? serverTopicId(topicId) : undefined,
        instructions: instructions.trim() || undefined,
      });
      if (!item.title) item.title = studioKindLabel(kind);
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      upsert(item);
      setSelectedId(item.id);
      if (item.status !== 'done' && item.status !== 'error') follow(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  const remove = async (item: StudioItem) => {
    if (!confirm(`¿Borrar "${item.title || studioKindLabel(item.kind)}"?`)) return;
    try {
      polling.current.get(item.id)?.abort();
      await deleteStudioItem(item.id);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== item.id));
      setSelectedId((cur) => (cur === item.id ? null : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selected = items?.find((x) => x.id === selectedId) ?? null;

  // The list endpoint may return summaries only: fetch the full item on selection
  const needsFull = !!selected && selected.status === 'done' && !selected.content && selected.data == null;
  useEffect(() => {
    if (!needsFull || !selectedId) return;
    let cancelled = false;
    getStudioItem(selectedId).then((full) => { if (!cancelled) upsert(full); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsFull, selectedId, upsert]);

  return (
    <div className="flex flex-col gap-5">
      {/* Generators */}
      <section className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-64">
            <Select className="w-full" value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Tema">
              <option value="">Toda la asignatura</option>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </Select>
          </div>
          <button
            type="button"
            onClick={() => setShowInstructions((v) => !v)}
            className="text-xs text-ink-400 hover:text-amber-400 transition-colors py-2"
          >
            {showInstructions ? 'Ocultar indicaciones' : 'Añadir indicaciones'}
          </button>
        </div>
        {showInstructions && (
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
            placeholder="Ej.: céntrate en las demostraciones; nivel de examen final"
            className="bg-ink-900 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          />
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {STUDIO_KINDS.map(({ kind, label, hint }) => {
            const disabled = !caps.llm || !!starting;
            const podcastNoVoice = kind === 'podcast' && caps.llm && !caps.tts;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => void start(kind)}
                disabled={disabled}
                title={!caps.llm ? 'Necesita un modelo de texto en Hypatia (Hoard Link)' : podcastNoVoice ? `${hint}. Sin voz disponible: solo se generará el guion.` : hint}
                className="text-left rounded-lg border border-ink-600 bg-ink-900 hover:border-amber-500/60 hover:bg-ink-700 px-3 py-2.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink-100">
                  {starting === kind && (
                    <svg className="animate-spin h-3 w-3 text-amber-500" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {label}
                </span>
                <span className="block text-[11px] text-ink-500 mt-0.5 leading-snug">
                  {podcastNoVoice ? 'Sin voz: solo guion' : hint}
                </span>
              </button>
            );
          })}
        </div>
        {!caps.llm && (
          <p className="text-xs text-ink-400">
            Hypatia no tiene un modelo de texto disponible. Configúralo en Hoard Link para generar contenido; mientras tanto puedes pedírselo a tu asistente.
          </p>
        )}
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </section>

      {/* Items */}
      {items === null && <p className="text-sm text-ink-500">Cargando…</p>}
      {items && items.length === 0 && (
        <EmptyState title="Nada generado todavía" description="Elige un formato arriba. El resultado aparecerá aquí y se guarda en tu PC." />
      )}
      {items && items.length > 0 && (
        <div className="flex flex-col md:flex-row gap-4">
          <ul className="md:w-64 flex-shrink-0 flex md:flex-col gap-1.5 overflow-x-auto md:overflow-visible pb-1 md:pb-0">
            {items.map((it) => {
              const active = it.id === selectedId;
              const running = it.status === 'queued' || it.status === 'running';
              return (
                <li key={it.id} className="flex-shrink-0 md:flex-shrink">
                  <button
                    type="button"
                    onClick={() => setSelectedId(it.id)}
                    className={`w-48 md:w-full text-left rounded-lg px-3 py-2 border transition-all ${
                      active ? 'border-amber-500/60 bg-amber-500/10' : 'border-ink-700 bg-ink-800/50 hover:border-ink-500'
                    }`}
                  >
                    <span className="block text-[10px] uppercase tracking-widest text-ink-500">{studioKindLabel(it.kind)}</span>
                    <span className="block text-sm text-ink-100 truncate">{it.title || studioKindLabel(it.kind)}</span>
                    <span className={`block text-[11px] ${it.status === 'error' ? 'text-rose-400' : running ? 'text-amber-400' : 'text-ink-500'}`}>
                      {it.status === 'error' ? 'Error' : running ? 'Generando…' : it.createdAt ? new Date(it.createdAt).toLocaleDateString('es-ES') : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex-1 min-w-0 bg-ink-800/50 border border-ink-700 rounded-xl p-4 sm:p-5">
            {selected ? (
              <StudioItemView item={selected} onDelete={() => void remove(selected)} />
            ) : (
              <p className="text-sm text-ink-500">Selecciona un elemento.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
