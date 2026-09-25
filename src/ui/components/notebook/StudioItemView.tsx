/**
 * StudioItemView.tsx
 *
 * Renders one generated studio item: markdown guides with citations,
 * glossary (→ "Añadir a conceptos clave"), FAQ (→ "Crear preguntas"),
 * mind map (collapsible SVG), podcast (<audio> + script).
 */

import { useState } from 'react';
import { Button } from '@/ui/components';
import {
  studioAudioUrl, studioToConcepts, studioToQuestions, normalizeCitations,
  type StudioItem, type StudioKind, type Citation,
} from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';
import { CitedMarkdown } from './CitedMarkdown';
import { CitationList } from './CitationChip';
import { MindMap, toMindMapRoot } from './MindMap';

export const STUDIO_KINDS: { kind: StudioKind; label: string; hint: string }[] = [
  { kind: 'study_guide', label: 'Guía de estudio', hint: 'Conceptos clave, explicaciones y preguntas de repaso' },
  { kind: 'briefing', label: 'Resumen ejecutivo', hint: 'Lo esencial en una página' },
  { kind: 'faq', label: 'Preguntas frecuentes', hint: 'Preguntas y respuestas; se pueden pasar al banco' },
  { kind: 'glossary', label: 'Glosario', hint: 'Términos y definiciones; se pueden pasar a conceptos clave' },
  { kind: 'timeline', label: 'Cronología', hint: 'Eventos o pasos en orden' },
  { kind: 'mindmap', label: 'Mapa mental', hint: 'Árbol de ideas desplegable' },
  { kind: 'podcast', label: 'Resumen en audio', hint: 'Conversación a dos voces (~10 min)' },
];

export function studioKindLabel(kind: string): string {
  return STUDIO_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** Text that already shows inline [n] chips needs no extra chip row. */
const HAS_MARKER = /\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\]/;

/** Drops a leading "# Title" that just repeats the item title shown in the header. */
function withoutTitleHeading(md: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(md);
  if (m && title && m[1].trim().toLowerCase() === title.trim().toLowerCase()) return md.slice(m[0].length);
  return md;
}

interface GlossaryEntry { term: string; definition: string; citations: Citation[] }
interface FaqEntry { q: string; a: string; citations: Citation[] }
interface PodcastScript { title?: string; turns: { speaker: string; text: string }[] }

function asArray(data: unknown, key?: string): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (key && data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key])) {
    return (data as Record<string, unknown>)[key] as Record<string, unknown>[];
  }
  return [];
}

/** Item-level citations can be numbers (refs into the item's list) or objects. */
function entryCitations(raw: unknown, all: Citation[]): Citation[] {
  if (!Array.isArray(raw)) return [];
  if (raw.every((x) => typeof x === 'number')) {
    const byN = new Map(all.map((c) => [c.n, c]));
    return (raw as number[]).map((n) => byN.get(n) ?? { n });
  }
  return normalizeCitations(raw);
}

function glossary(item: StudioItem): GlossaryEntry[] {
  return asArray(item.data, 'terms').map((e) => ({
    term: String(e.term ?? e.name ?? ''),
    definition: String(e.definition ?? e.text ?? ''),
    citations: entryCitations(e.citations ?? e.refs, item.citations),
  })).filter((e) => e.term);
}

function faq(item: StudioItem): FaqEntry[] {
  return asArray(item.data, 'items').map((e) => ({
    q: String(e.q ?? e.question ?? ''),
    a: String(e.a ?? e.answer ?? ''),
    citations: entryCitations(e.citations ?? e.refs, item.citations),
  })).filter((e) => e.q);
}

function podcast(item: StudioItem): PodcastScript | null {
  const d = item.data as Record<string, unknown> | undefined;
  const turns = asArray(d, 'turns').map((t) => ({ speaker: String(t.speaker ?? 'A'), text: String(t.text ?? '') }));
  if (turns.length === 0) return null;
  return { title: typeof d?.title === 'string' ? d.title : undefined, turns };
}

interface StudioItemViewProps {
  item: StudioItem;
  onDelete: () => void;
}

export function StudioItemView({ item, onDelete }: StudioItemViewProps) {
  const { caps, showCitation } = useNotebook();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const convert = async (which: 'concepts' | 'questions') => {
    setBusy(true);
    setMsg(null);
    try {
      const r = which === 'concepts' ? await studioToConcepts(item.id) : await studioToQuestions(item.id);
      const n = Number(r.added ?? r.created ?? r.count ?? (Array.isArray(r.ids) ? r.ids.length : NaN));
      const skipped = Number(r.skipped ?? 0);
      const what = which === 'concepts'
        ? (n === 1 ? 'concepto clave añadido' : 'conceptos clave añadidos')
        : (n === 1 ? 'pregunta añadida' : 'preguntas añadidas');
      const dup = skipped > 0 ? ` (${skipped} ya existía${skipped === 1 ? '' : 'n'})` : '';
      setMsg({ ok: true, text: Number.isFinite(n) ? `${n} ${what}${dup}. Se sincronizan en unos segundos.` : 'Añadido a la asignatura.' });
      // Bring the new records into IndexedDB now
      const { syncNow } = await import('@/data/hoardSync');
      void syncNow();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const running = item.status === 'queued' || item.status === 'running';
  const date = item.finishedAt ?? item.createdAt;

  return (
    <article className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-widest text-amber-400">{studioKindLabel(item.kind)}</p>
          <h2 className="font-display text-xl text-ink-100 break-words">{item.title || studioKindLabel(item.kind)}</h2>
          <p className="text-xs text-ink-500 mt-0.5">
            {date ? new Date(date).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : ''}
            {item.model ? ` · ${item.model}` : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onDelete} title="Borrar">Borrar</Button>
      </header>

      {running && (
        <div className="flex items-center gap-2 text-sm text-ink-400 bg-ink-800 border border-ink-700 rounded-xl px-4 py-3">
          <svg className="animate-spin h-4 w-4 text-amber-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {item.status === 'queued' ? 'En cola…' : 'Generando…'}
          {item.progress && <span className="text-ink-500">· {item.progress}</span>}
        </div>
      )}

      {item.status === 'error' && (
        <p className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 break-words">
          {item.error || 'No se pudo generar.'}
        </p>
      )}

      {item.note && <p className="text-xs text-ink-400 italic">{item.note}</p>}

      {item.status === 'done' && <Body item={item} caps={caps} showCitation={showCitation} />}

      {item.status === 'done' && item.kind === 'glossary' && glossary(item).length > 0 && (
        <div>
          <Button size="sm" onClick={() => void convert('concepts')} loading={busy}>Añadir a conceptos clave</Button>
        </div>
      )}
      {item.status === 'done' && item.kind === 'faq' && (faq(item).length > 0 || !!item.content) && (
        <div>
          <Button size="sm" onClick={() => void convert('questions')} loading={busy}>Crear preguntas</Button>
        </div>
      )}
      {msg && <p className={`text-xs ${msg.ok ? 'text-sage-400' : 'text-rose-400'}`}>{msg.text}</p>}

      {item.status === 'done' && item.citations.length > 0 && (
        <footer className="pt-3 border-t border-ink-800">
          <p className="text-[11px] uppercase tracking-widest text-ink-500">Fuentes</p>
          <CitationList citations={item.citations} />
        </footer>
      )}
    </article>
  );
}

function Body({
  item, caps, showCitation,
}: {
  item: StudioItem;
  caps: { tts: boolean };
  showCitation: (c: Citation, r: DOMRect) => void;
}) {
  if (item.kind === 'mindmap') {
    const root = toMindMapRoot(item.data, item.title);
    if (!root) return <p className="text-sm text-ink-500">Mapa vacío.</p>;
    const byN = new Map(item.citations.map((c) => [c.n, c]));
    return (
      <MindMap
        root={root}
        onRefs={(refs, rect) => showCitation(byN.get(refs[0]) ?? { n: refs[0] }, rect)}
      />
    );
  }

  if (item.kind === 'glossary') {
    const entries = glossary(item);
    if (entries.length === 0) return <CitedMarkdown content={item.content ?? ''} citations={item.citations} />;
    return (
      <dl className="flex flex-col divide-y divide-ink-800 border border-ink-700 rounded-xl bg-ink-800/50">
        {entries.map((e, i) => (
          <div key={i} className="px-4 py-3">
            <dt className="text-sm font-semibold text-ink-100">{e.term}</dt>
            <dd className="mt-1">
              <CitedMarkdown content={e.definition} citations={e.citations.length ? e.citations : item.citations} />
              {!HAS_MARKER.test(e.definition) && <CitationList citations={e.citations} detailed={false} />}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  if (item.kind === 'faq') {
    const entries = faq(item);
    if (entries.length === 0) return <CitedMarkdown content={item.content ?? ''} citations={item.citations} />;
    return (
      <div className="flex flex-col gap-2">
        {entries.map((e, i) => (
          <details key={i} className="group border border-ink-700 rounded-xl bg-ink-800/50 px-4 py-3" open={i < 2}>
            <summary className="cursor-pointer text-sm font-medium text-ink-100 list-none flex items-start gap-2">
              <span className="text-amber-400 group-open:rotate-90 transition-transform">›</span>
              <span>{e.q}</span>
            </summary>
            <div className="mt-2 pl-4">
              <CitedMarkdown content={e.a} citations={e.citations.length ? e.citations : item.citations} />
              {!HAS_MARKER.test(e.a) && <CitationList citations={e.citations} detailed={false} />}
            </div>
          </details>
        ))}
      </div>
    );
  }

  if (item.kind === 'podcast') {
    const script = podcast(item);
    return (
      <div className="flex flex-col gap-4">
        {item.hasAudio ? (
          <audio controls preload="none" src={studioAudioUrl(item.id)} className="w-full" />
        ) : (
          <p className="text-xs text-ink-400 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
            {caps.tts
              ? 'Sin audio para este guion.'
              : 'Sin voz disponible en Hypatia: solo se ha generado el guion.'}
          </p>
        )}
        {script ? (
          <div className="flex flex-col gap-2">
            {script.title && <h3 className="font-display text-lg text-ink-100">{script.title}</h3>}
            {script.turns.map((t, i) => {
              const a = t.speaker.toUpperCase() !== 'B';
              return (
                <div key={i} className={`flex gap-2 ${a ? '' : 'flex-row-reverse text-right'}`}>
                  <span className={`w-6 h-6 flex-shrink-0 rounded-full text-[11px] font-bold flex items-center justify-center ${a ? 'bg-amber-500 text-ink-900' : 'bg-ink-700 text-ink-200 border border-ink-600'}`}>
                    {a ? 'A' : 'B'}
                  </span>
                  <p className={`text-sm text-ink-200 leading-relaxed rounded-xl px-3 py-2 max-w-[85%] ${a ? 'bg-ink-800 border border-ink-700' : 'bg-amber-500/10 border border-amber-500/25'}`}>
                    {t.text}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          item.content && <CitedMarkdown content={item.content} citations={item.citations} />
        )}
      </div>
    );
  }

  return <CitedMarkdown content={withoutTitleHeading(item.content ?? '', item.title)} citations={item.citations} />;
}
