/**
 * PdfExportModal.tsx
 *
 * Modal genérico reutilizable para seleccionar items y exportarlos como PDF.
 * Usado desde las tabs de Preguntas, Conceptos Clave y Exámenes.
 *
 * Features:
 * - Selección individual por item
 * - Seleccionar todo / deseleccionar todo (global)
 * - Seleccionar todo / ninguno por categoría
 * - Categorías contraíbles (collapsible) para scroll rápido
 */

import { useState } from 'react';
import { Button, Modal } from '@/ui/components';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PdfExportModalProps<T> {
  open: boolean;
  onClose: () => void;
  title: string;
  items: T[];
  getId: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Optional: group items visually with section headers */
  groupBy?: (item: T) => string;
  /** Group order (labels in order). If not given, groups appear naturally */
  groupOrder?: string[];
  onExport: (selectedIds: Set<string>) => Promise<void>;
  /** Optional render prop for extra filters above the item list */
  renderFilters?: () => React.ReactNode;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function PdfExportModal<T>({
  open,
  onClose,
  title,
  items,
  getId,
  renderItem,
  groupBy,
  groupOrder,
  onExport,
  renderFilters,
}: PdfExportModalProps<T>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(items.map(getId)),
  );
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const allSelected = selectedIds.size === items.length;
  const noneSelected = selectedIds.size === 0;

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map(getId)));
    }
  };

  const toggleGroupCollapse = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const toggleGroupSelection = (groupItems: T[]) => {
    const ids = groupItems.map(getId);
    const allInGroup = ids.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allInGroup) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const handleExport = async () => {
    if (noneSelected) return;
    setLoading(true);
    try {
      await onExport(selectedIds);
      onClose();
    } catch (err) {
      alert('Error al generar PDF: ' + String(err));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  // Build grouped items
  const groups: { label: string; items: T[] }[] = [];
  if (groupBy) {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = groupBy(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    if (groupOrder) {
      for (const label of groupOrder) {
        if (map.has(label)) groups.push({ label, items: map.get(label)! });
      }
      for (const [label, gItems] of map) {
        if (!groupOrder.includes(label)) groups.push({ label, items: gItems });
      }
    } else {
      for (const [label, gItems] of map) {
        groups.push({ label, items: gItems });
      }
    }
  } else {
    groups.push({ label: '', items });
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <div className="flex flex-col gap-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <button
            onClick={toggleAll}
            className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
          >
            {allSelected ? 'Deseleccionar todo' : 'Seleccionar todo'}
          </button>
          <span className="text-xs text-ink-500">
            {selectedIds.size} de {items.length} seleccionado{selectedIds.size !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Optional extra filters */}
        {renderFilters?.()}

        {/* Item list */}
        <div className="max-h-[50vh] overflow-y-auto space-y-3">
          {groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.label);
            const groupIds = group.items.map(getId);
            const selectedInGroup = groupIds.filter((id) => selectedIds.has(id)).length;
            const allInGroupSelected = selectedInGroup === group.items.length;

            return (
              <div key={group.label || '__all__'} className="rounded-lg border border-ink-700/50 overflow-hidden">
                {group.label && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-ink-800/60 sticky top-0 z-10">
                    {/* Collapse toggle */}
                    <button
                      onClick={() => toggleGroupCollapse(group.label)}
                      className="text-ink-500 hover:text-ink-300 transition-colors text-xs w-4 flex-shrink-0"
                      title={isCollapsed ? 'Expandir' : 'Contraer'}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>

                    {/* Group checkbox */}
                    <input
                      type="checkbox"
                      checked={allInGroupSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedInGroup > 0 && !allInGroupSelected;
                      }}
                      onChange={() => toggleGroupSelection(group.items)}
                      className="accent-amber-500 flex-shrink-0"
                    />

                    {/* Label — click to collapse/expand */}
                    <button
                      onClick={() => toggleGroupCollapse(group.label)}
                      className="flex-1 text-left flex items-center gap-2"
                    >
                      <h4 className="text-xs font-medium text-ink-300 uppercase tracking-wider">
                        {group.label}
                      </h4>
                      <span className="text-[10px] text-ink-500">
                        {selectedInGroup}/{group.items.length}
                      </span>
                    </button>

                    {/* Quick select/deselect text */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleGroupSelection(group.items); }}
                      className="text-[10px] text-amber-500/70 hover:text-amber-400 transition-colors flex-shrink-0"
                    >
                      {allInGroupSelected ? 'ninguno' : 'todos'}
                    </button>
                  </div>
                )}

                {/* Items (hidden when collapsed) */}
                {!isCollapsed && (
                  <div className="space-y-0.5 p-1.5">
                    {group.items.map((item) => {
                      const id = getId(item);
                      const checked = selectedIds.has(id);
                      return (
                        <label
                          key={id}
                          className={`flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-all border ${
                            checked
                              ? 'bg-amber-500/5 border-amber-500/20'
                              : 'bg-transparent border-transparent hover:bg-ink-800/50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(id)}
                            className="mt-0.5 accent-amber-500 flex-shrink-0"
                          />
                          <div className="flex-1 min-w-0">{renderItem(item)}</div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Progress */}
        {loading && progress && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-ink-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full transition-all duration-300"
                style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
              />
            </div>
            <span className="text-xs text-ink-500">
              {progress.current}/{progress.total}
            </span>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-ink-700 pt-3">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleExport} disabled={noneSelected || loading} loading={loading}>
            Exportar PDF ({selectedIds.size})
          </Button>
        </div>
      </div>
    </Modal>
  );
}
