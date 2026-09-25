/**
 * CitationChip.tsx
 *
 * Citation chips ([n]) and the popover they open: source title, page,
 * snippet and "Abrir PDF en pág. N" when that PDF is stored in this browser.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Citation } from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';

// ─── Chip ────────────────────────────────────────────────────────────────────

interface CitationChipProps {
  citation: Citation;
  /** Show filename + page next to the number. */
  detailed?: boolean;
}

export function CitationChip({ citation, detailed = false }: CitationChipProps) {
  const { showCitation } = useNotebook();
  const label = citation.title || citation.filename || 'Fuente';
  return (
    <button
      type="button"
      onClick={(e) => showCitation(citation, e.currentTarget.getBoundingClientRect())}
      title={`${label}${citation.page ? ` · pág. ${citation.page}` : ''}`}
      className="inline-flex items-center gap-1 max-w-full px-1.5 py-0.5 rounded-md text-[11px] font-medium font-body border bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 transition-colors"
    >
      <span className="font-mono">{citation.n}</span>
      {detailed && (
        <span className="truncate text-ink-300 font-normal">
          {label}{citation.page ? ` · pág. ${citation.page}` : ''}
        </span>
      )}
    </button>
  );
}

/** Row of chips, deduplicated by n. */
export function CitationList({ citations, detailed = true }: { citations: Citation[]; detailed?: boolean }) {
  const seen = new Set<number>();
  const unique = citations.filter((c) => (seen.has(c.n) ? false : (seen.add(c.n), true)));
  if (unique.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {unique.map((c) => (
        <CitationChip key={c.n} citation={c} detailed={detailed} />
      ))}
    </div>
  );
}

// ─── Popover ─────────────────────────────────────────────────────────────────

interface CitationPopoverProps {
  citation: Citation;
  anchor: DOMRect;
  onClose: () => void;
}

const POPOVER_WIDTH = 320;

export function CitationPopover({ citation, anchor, onClose }: CitationPopoverProps) {
  const { findLocalPdf, openPdf } = useNotebook();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: anchor.bottom + 6, left: anchor.left });

  useLayoutEffect(() => {
    const el = ref.current;
    const h = el?.offsetHeight ?? 160;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.left, vw - POPOVER_WIDTH - 8));
    const below = anchor.bottom + 6;
    const top = below + h > vh - 8 ? Math.max(8, anchor.top - h - 6) : below;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const local = findLocalPdf(citation.filename);
  const page = citation.page ?? 1;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH, maxWidth: 'calc(100vw - 16px)' }}
        className="fixed z-50 bg-ink-800 border border-ink-600 rounded-xl shadow-2xl p-3 animate-fade-in"
      >
        <div className="flex items-start gap-2">
          <span className="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/30 flex-shrink-0">
            {citation.n}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink-100 font-medium leading-snug break-words">
              {citation.title || citation.filename || 'Fuente'}
            </p>
            <p className="text-xs text-ink-500 mt-0.5 truncate">
              {citation.title && citation.filename ? `${citation.filename} · ` : ''}
              {citation.page ? `pág. ${citation.page}` : 'sin página'}
            </p>
          </div>
        </div>
        {citation.snippet && (
          <p className="mt-2 text-xs text-ink-300 leading-relaxed border-l-2 border-amber-500/40 pl-2 max-h-40 overflow-y-auto whitespace-pre-line">
            {citation.snippet}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          {local ? (
            <button
              type="button"
              onClick={() => { openPdf(local, page); onClose(); }}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 transition-colors"
            >
              Abrir PDF en pág. {page}
            </button>
          ) : (
            <span className="text-[11px] text-ink-500">
              {citation.filename?.toLowerCase().endsWith('.pdf') ? 'PDF no guardado en este dispositivo' : ''}
            </span>
          )}
          <button type="button" onClick={onClose} className="text-xs text-ink-500 hover:text-ink-300 transition-colors">
            Cerrar
          </button>
        </div>
      </div>
    </>
  );
}
