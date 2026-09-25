/**
 * KeyConceptsSidebar.tsx
 *
 * Panel lateral de conceptos clave para consultar durante las prácticas.
 * Muestra fórmulas, definiciones y observaciones con búsqueda y filtro
 * por categoría. Renderiza contenido Markdown + LaTeX via MdContent.
 * Borde izquierdo redimensionable arrastrando.
 */

import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { MdContent } from '@/ui/components/MdContent';
import { Badge } from '@/ui/components';
import type { KeyConcept, KeyConceptCategory, Topic } from '@/domain/models';

// ─── Category config (misma estructura que KeyConceptsTab) ──────────────────

const CATEGORY_CONFIG: Record<
  KeyConceptCategory,
  { label: string; plural: string; icon: string; borderColor: string; badgeColor: 'amber' | 'blue' | 'sage' }
> = {
  formula: {
    label: 'Fórmula',
    plural: 'Fórmulas',
    icon: '📐',
    borderColor: 'border-l-blue-500',
    badgeColor: 'blue',
  },
  definition: {
    label: 'Definición',
    plural: 'Definiciones',
    icon: '📖',
    borderColor: 'border-l-amber-500',
    badgeColor: 'amber',
  },
  remark: {
    label: 'Observación',
    plural: 'Observaciones',
    icon: '💡',
    borderColor: 'border-l-sage-500',
    badgeColor: 'sage',
  },
};

const CATEGORIES: KeyConceptCategory[] = ['formula', 'definition', 'remark'];

const MIN_WIDTH = 280;
const MAX_WIDTH_RATIO = 0.75; // max 75% of viewport

// ─── Props ──────────────────────────────────────────────────────────────────

interface KeyConceptsSidebarProps {
  concepts: KeyConcept[];
  topics: Topic[];
  open: boolean;
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function KeyConceptsSidebar({ concepts, topics, open, onClose }: KeyConceptsSidebarProps) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<KeyConceptCategory | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // ─── Resize state ───────────────────────────────────────────────────────
  const [width, setWidth] = useState(384); // default ~max-w-sm
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(384);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = startX.current - e.clientX; // dragging left = bigger
      const maxW = window.innerWidth * MAX_WIDTH_RATIO;
      const newWidth = Math.min(maxW, Math.max(MIN_WIDTH, startWidth.current + delta));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const topicMap = useMemo(() => {
    const m = new Map<string, Topic>();
    for (const t of topics) m.set(t.id, t);
    return m;
  }, [topics]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return concepts.filter((kc) => {
      if (activeCategory !== 'all' && kc.category !== activeCategory) return false;
      if (!q) return true;
      return (
        kc.title.toLowerCase().includes(q) ||
        kc.content.toLowerCase().includes(q) ||
        (kc.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [concepts, search, activeCategory]);

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<KeyConceptCategory, KeyConcept[]>();
    for (const cat of CATEGORIES) map.set(cat, []);
    for (const kc of filtered) {
      map.get(kc.category)?.push(kc);
    }
    return map;
  }, [filtered]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40 lg:hidden"
        onClick={onClose}
      />

      {/* Sidebar panel */}
      <div
        className="fixed right-0 top-0 h-full bg-ink-950 border-l border-ink-700 z-50 flex flex-col shadow-xl animate-slide-in-right"
        style={{ width }}
      >
        {/* Resize handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize z-10 group hover:bg-amber-500/30 active:bg-amber-500/40 transition-colors"
          title="Arrastra para redimensionar"
        >
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-12 rounded-full bg-ink-600 group-hover:bg-amber-500 transition-colors" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
          <h2 className="text-lg font-semibold text-ink-100 flex items-center gap-2">
            Conceptos clave
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-ink-700 text-ink-500 transition-colors"
            title="Cerrar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar conceptos..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-ink-600 bg-ink-800 text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* Category filters */}
        <div className="px-4 pb-3 flex gap-1.5 flex-wrap">
          <button
            onClick={() => setActiveCategory('all')}
            className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
              activeCategory === 'all'
                ? 'bg-ink-200 text-ink-900'
                : 'bg-ink-700 text-ink-300 hover:bg-ink-600'
            }`}
          >
            Todos ({concepts.length})
          </button>
          {CATEGORIES.map((cat) => {
            const cfg = CATEGORY_CONFIG[cat];
            const count = concepts.filter((kc) => kc.category === cat).length;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(activeCategory === cat ? 'all' : cat)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  activeCategory === cat
                    ? 'bg-ink-200 text-ink-900'
                    : 'bg-ink-700 text-ink-300 hover:bg-ink-600'
                }`}
              >
                {cfg.icon} {cfg.plural} ({count})
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-ink-500 text-sm">
              {search ? 'Sin resultados para esta búsqueda' : 'No hay conceptos clave para esta asignatura'}
            </div>
          ) : (
            CATEGORIES.map((cat) => {
              const items = grouped.get(cat);
              if (!items || items.length === 0) return null;
              const cfg = CATEGORY_CONFIG[cat];
              return (
                <div key={cat}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400 mb-2 flex items-center gap-1.5">
                    {cfg.icon} {cfg.plural} ({items.length})
                  </h3>
                  <div className="space-y-2">
                    {items.map((kc) => {
                      const expanded = expandedIds.has(kc.id);
                      const topic = kc.topicId ? topicMap.get(kc.topicId) : null;
                      return (
                        <div
                          key={kc.id}
                          className={`border-l-4 ${cfg.borderColor} bg-ink-800 rounded-r-lg`}
                        >
                          <button
                            onClick={() => toggleExpand(kc.id)}
                            className="w-full text-left px-3 py-2.5 flex items-start justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-ink-100 leading-tight">
                                {kc.title}
                              </span>
                              {topic && (
                                <span className="ml-2 text-xs text-ink-500">
                                  {topic.title}
                                </span>
                              )}
                            </div>
                            <svg
                              className={`w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                          {expanded && (
                            <div className="px-3 pb-3 border-t border-ink-700">
                              <MdContent
                                content={kc.content}
                                className="prose prose-sm prose-invert max-w-none pt-2 text-ink-300 [&_table]:text-xs [&_pre]:text-xs"
                              />
                              {kc.tags && kc.tags.length > 0 && (
                                <div className="flex gap-1 flex-wrap mt-2">
                                  {kc.tags.map((tag) => (
                                    <Badge key={tag} color="ink">{tag}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
