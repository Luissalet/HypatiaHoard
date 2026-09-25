/**
 * KeyConceptsTab.tsx
 *
 * Tab de "Conceptos clave" para SubjectView.
 * Muestra fórmulas, definiciones y observaciones agrupadas por categoría.
 * Permite crear/editar/eliminar conceptos manualmente e importar/exportar
 * packs JSON compatibles con ChatGPT y compartibles en GitHub.
 */

import React, { useState, useMemo } from 'react';
import { Button, Modal, Input, Select, EmptyState, Badge } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import type { KeyConcept, KeyConceptCategory, Topic } from '@/domain/models';
import { importKeyConceptsPack, exportKeyConceptsPack } from '@/data/keyConceptsImport';
import type { KeyConceptsImportResult } from '@/data/keyConceptsImport';
import { PdfExportModal } from '@/ui/components/PdfExportModal';
import { generateKeyConceptsPDF, downloadBlob } from '@/utils/pdfExport';

// ─── Category config ─────────────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<
  KeyConceptCategory,
  { label: string; plural: string; icon: string; color: string; badgeColor: 'amber' | 'blue' | 'sage' }
> = {
  formula: {
    label: 'Fórmula',
    plural: 'Fórmulas',
    icon: '📐',
    color: 'border-l-blue-500',
    badgeColor: 'blue',
  },
  definition: {
    label: 'Definición',
    plural: 'Definiciones',
    icon: '📖',
    color: 'border-l-amber-500',
    badgeColor: 'amber',
  },
  remark: {
    label: 'Observación',
    plural: 'Observaciones',
    icon: '💡',
    color: 'border-l-sage-500',
    badgeColor: 'sage',
  },
};

const CATEGORIES: KeyConceptCategory[] = ['formula', 'definition', 'remark'];

// ─── Props ───────────────────────────────────────────────────────────────────

interface KeyConceptsTabProps {
  subjectId: string;
  concepts: KeyConcept[];
  topics: Topic[];
  onCreate: (data: {
    category: KeyConceptCategory;
    title: string;
    content: string;
    tags?: string[];
    topicId?: string;
    order: number;
  }) => Promise<void>;
  onUpdate: (id: string, data: Partial<KeyConcept>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReload: () => Promise<void>;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function KeyConceptsTab({
  subjectId,
  concepts,
  topics,
  onCreate,
  onUpdate,
  onDelete,
  onReload,
}: KeyConceptsTabProps) {
  const [formModal, setFormModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [editing, setEditing] = useState<KeyConcept | null>(null);
  const [filterCategory, setFilterCategory] = useState<KeyConceptCategory | ''>('');
  const [searchText, setSearchText] = useState('');

  // Group by category
  const grouped = useMemo(() => {
    let filtered = concepts;
    if (filterCategory) {
      filtered = filtered.filter((c) => c.category === filterCategory);
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.content.toLowerCase().includes(q) ||
          c.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    const result: Record<KeyConceptCategory, KeyConcept[]> = {
      formula: [],
      definition: [],
      remark: [],
    };
    for (const c of filtered) {
      result[c.category].push(c);
    }
    // Sort each group by order
    for (const cat of CATEGORIES) {
      result[cat].sort((a, b) => a.order - b.order);
    }
    return result;
  }, [concepts, filterCategory, searchText]);

  const totalFiltered =
    grouped.formula.length + grouped.definition.length + grouped.remark.length;

  const openCreate = (category?: KeyConceptCategory) => {
    setEditing(null);
    setFormModal(true);
  };

  const openEdit = (concept: KeyConcept) => {
    setEditing(concept);
    setFormModal(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este concepto?')) return;
    await onDelete(id);
  };

  const handleExport = async () => {
    try {
      const pack = await exportKeyConceptsPack(subjectId);
      const json = JSON.stringify(pack, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `conceptos-${pack.subjectKey}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Error al exportar: ' + String(e));
    }
  };

  // Empty state
  if (concepts.length === 0) {
    return (
      <>
        <EmptyState
          icon={<span className="text-5xl">💡</span>}
          title="Sin conceptos clave"
          description="Añade fórmulas, definiciones y observaciones importantes para esta asignatura."
          action={
            <div className="flex gap-2">
              <Button onClick={() => openCreate()}>+ Nuevo concepto</Button>
              <Button variant="secondary" onClick={() => setImportModal(true)}>
                Importar JSON
              </Button>
            </div>
          }
        />
        {formModal && (
          <ConceptFormModal
            editing={null}
            topics={topics}
            concepts={concepts}
            subjectId={subjectId}
            onClose={() => setFormModal(false)}
            onCreate={onCreate}
            onUpdate={onUpdate}
          />
        )}
        {importModal && (
          <ImportConceptsModal
            onClose={() => setImportModal(false)}
            onReload={onReload}
          />
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => openCreate()}>
          + Nuevo concepto
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setImportModal(true)}>
          Importar JSON
        </Button>
        <Button size="sm" variant="secondary" onClick={handleExport}>
          Exportar JSON
        </Button>
        {concepts.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setPdfExportOpen(true)}>
            PDF
          </Button>
        )}

        <div className="ml-auto flex gap-2">
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as KeyConceptCategory | '')}
            className="text-xs bg-ink-800 border border-ink-700 text-ink-200 rounded-lg px-2 py-1.5"
          >
            <option value="">Todas las categorías</option>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_CONFIG[cat].icon} {CATEGORY_CONFIG[cat].plural}
              </option>
            ))}
          </select>

          <input
            type="text"
            placeholder="Buscar..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="text-xs bg-ink-800 border border-ink-700 text-ink-200 rounded-lg px-3 py-1.5 w-40"
          />
        </div>
      </div>

      {/* Counter */}
      <p className="text-xs text-ink-500">
        {totalFiltered} concepto{totalFiltered !== 1 ? 's' : ''}
        {filterCategory || searchText ? ' (filtrado)' : ''}
      </p>

      {/* Sections */}
      {CATEGORIES.map((cat) => {
        const items = grouped[cat];
        if (items.length === 0) return null;
        const cfg = CATEGORY_CONFIG[cat];
        return (
          <section key={cat} className="space-y-3">
            <h3 className="font-display text-sm text-ink-300 flex items-center gap-2">
              <span>{cfg.icon}</span>
              {cfg.plural}
              <span className="text-ink-600">({items.length})</span>
            </h3>
            <div className="space-y-2">
              {items.map((concept) => (
                <ConceptCard
                  key={concept.id}
                  concept={concept}
                  topics={topics}
                  onEdit={() => openEdit(concept)}
                  onDelete={() => handleDelete(concept.id)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {totalFiltered === 0 && (
        <p className="text-center text-ink-500 text-sm py-8">
          No hay conceptos que coincidan con el filtro.
        </p>
      )}

      {/* Modals */}
      {formModal && (
        <ConceptFormModal
          editing={editing}
          topics={topics}
          concepts={concepts}
          subjectId={subjectId}
          onClose={() => {
            setFormModal(false);
            setEditing(null);
          }}
          onCreate={onCreate}
          onUpdate={onUpdate}
        />
      )}
      {importModal && (
        <ImportConceptsModal
          onClose={() => setImportModal(false)}
          onReload={onReload}
        />
      )}
      <PdfExportModal
        open={pdfExportOpen}
        onClose={() => setPdfExportOpen(false)}
        title="Exportar conceptos clave como PDF"
        items={concepts}
        getId={(c) => c.id}
        groupBy={(c) => CATEGORY_CONFIG[c.category].plural}
        groupOrder={CATEGORIES.map((cat) => CATEGORY_CONFIG[cat].plural)}
        renderItem={(c) => {
          const topic = c.topicId ? topics.find((t) => t.id === c.topicId) : undefined;
          return (
            <div>
              <div className="flex items-center gap-2">
                <Badge color={CATEGORY_CONFIG[c.category].badgeColor}>
                  {CATEGORY_CONFIG[c.category].label}
                </Badge>
                <span className="text-sm text-ink-100">{c.title}</span>
                {topic && <span className="text-[10px] text-ink-500">{topic.title}</span>}
              </div>
              <p className="text-xs text-ink-400 mt-0.5 line-clamp-1">{c.content}</p>
            </div>
          );
        }}
        onExport={async (selectedIds) => {
          const blob = await generateKeyConceptsPDF(concepts, topics, '', selectedIds);
          downloadBlob(blob, `conceptos-clave.pdf`);
        }}
      />
    </div>
  );
}

// ─── Concept Card ────────────────────────────────────────────────────────────

function ConceptCard({
  concept,
  topics,
  onEdit,
  onDelete,
}: {
  concept: KeyConcept;
  topics: Topic[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cfg = CATEGORY_CONFIG[concept.category];
  const topic = concept.topicId
    ? topics.find((t) => t.id === concept.topicId)
    : undefined;

  return (
    <div
      className={`bg-ink-800 rounded-lg border border-ink-700 border-l-4 ${cfg.color} p-4 hover:border-ink-600 transition-colors`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-ink-100 text-sm">{concept.title}</h4>
            {topic && (
              <span className="text-[10px] bg-ink-700 text-ink-400 px-1.5 py-0.5 rounded">
                {topic.title}
              </span>
            )}
          </div>
          <div className="prose prose-invert prose-sm max-w-none text-ink-300">
            <MdContent content={concept.content} />
          </div>
          {concept.tags && concept.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {concept.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-ink-700 text-ink-400 px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            ✏️
          </Button>
          <Button size="sm" variant="ghost" className="text-rose-400 hover:text-rose-300" onClick={onDelete}>
            🗑️
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Create / Edit Modal ─────────────────────────────────────────────────────

function ConceptFormModal({
  editing,
  topics,
  concepts,
  subjectId,
  onClose,
  onCreate,
  onUpdate,
}: {
  editing: KeyConcept | null;
  topics: Topic[];
  concepts: KeyConcept[];
  subjectId: string;
  onClose: () => void;
  onCreate: KeyConceptsTabProps['onCreate'];
  onUpdate: KeyConceptsTabProps['onUpdate'];
}) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [content, setContent] = useState(editing?.content ?? '');
  const [category, setCategory] = useState<KeyConceptCategory>(editing?.category ?? 'definition');
  const [topicId, setTopicId] = useState(editing?.topicId ?? '');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState<string[]>(editing?.tags ?? []);
  const [saving, setSaving] = useState(false);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
      setTagInput('');
    }
  };

  const removeTag = (tag: string) => setTags(tags.filter((t) => t !== tag));

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        await onUpdate(editing.id, {
          title: title.trim(),
          content: content.trim(),
          category,
          topicId: topicId || undefined,
          tags: tags.length > 0 ? tags : undefined,
        });
      } else {
        const order = concepts.filter((c) => c.category === category).length;
        await onCreate({
          category,
          title: title.trim(),
          content: content.trim(),
          tags: tags.length > 0 ? tags : undefined,
          topicId: topicId || undefined,
          order,
        });
      }
      onClose();
    } catch (e) {
      alert('Error: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Editar concepto' : 'Nuevo concepto'}
      size="lg"
    >
      <div className="space-y-4">
        {/* Category */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-400">Categoría</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as KeyConceptCategory)}
            className="w-full bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_CONFIG[cat].icon} {CATEGORY_CONFIG[cat].label}
              </option>
            ))}
          </select>
        </div>

        {/* Title */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-400">Título</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej: Teorema de Pitágoras"
            className="w-full bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm placeholder-ink-600"
          />
        </div>

        {/* Topic (optional) */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-400">Tema (opcional)</label>
          <select
            value={topicId}
            onChange={(e) => setTopicId(e.target.value)}
            className="w-full bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Sin tema</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        {/* Content */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-400">
            Contenido (Markdown + LaTeX)
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={'Ej: $$a^2 + b^2 = c^2$$\n\nDonde $a$ y $b$ son los catetos...'}
            rows={5}
            className="w-full bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm placeholder-ink-600 font-mono resize-y"
          />
        </div>

        {/* Live preview */}
        {content.trim() && (
          <div className="border border-ink-700 rounded-lg p-3 bg-ink-900/50">
            <p className="text-[10px] text-ink-500 mb-2 uppercase tracking-wide">Vista previa</p>
            <div className="prose prose-invert prose-sm max-w-none text-ink-300">
              <MdContent content={content} />
            </div>
          </div>
        )}

        {/* Tags */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-ink-400">Tags (opcional)</label>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Añadir tag"
              className="flex-1 bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-1.5 text-sm placeholder-ink-600"
            />
            <Button size="sm" variant="secondary" onClick={addTag}>
              +
            </Button>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 bg-ink-700 text-ink-300 px-2 py-0.5 rounded text-xs"
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    className="hover:text-ink-100 cursor-pointer"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 border-t border-ink-700 pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || !content.trim() || saving}
            loading={saving}
          >
            {editing ? 'Actualizar' : 'Crear'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportConceptsModal({
  onClose,
  onReload,
}: {
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const [jsonText, setJsonText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<KeyConceptsImportResult | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      const text = await f.text();
      setJsonText(text);
    }
  };

  const handleImport = async () => {
    if (!jsonText.trim()) return;
    setImporting(true);
    try {
      const parsed = JSON.parse(jsonText);
      const res = await importKeyConceptsPack(parsed);
      setResult(res);
      if (res.errors.length === 0 && !res.alreadyImported) {
        await onReload();
      }
    } catch (e) {
      setResult({
        packId: '',
        createdBy: '',
        subjectId: '',
        newConcepts: 0,
        duplicates: 0,
        newTopicsCreated: 0,
        alreadyImported: false,
        errors: ['Error al parsear JSON: ' + String(e)],
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Importar conceptos clave" size="lg">
      <div className="space-y-4">
        {!result ? (
          <>
            <p className="text-sm text-ink-400">
              Sube un archivo JSON o pega el contenido directamente. El formato es
              compatible con los packs generados por ChatGPT y con la exportación
              de esta app.
            </p>

            {/* File input */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-ink-400">
                Archivo JSON
              </label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileChange}
                className="text-sm text-ink-300 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-ink-700 file:text-ink-200 hover:file:bg-ink-600"
              />
            </div>

            {/* Or paste */}
            <div className="space-y-1">
              <label className="block text-xs font-medium text-ink-400">
                O pega el JSON aquí
              </label>
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                rows={8}
                placeholder='{"version": 1, "kind": "keyconcepts", ...}'
                className="w-full bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-xs font-mono placeholder-ink-600 resize-y"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-ink-700 pt-4">
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button
                onClick={handleImport}
                disabled={!jsonText.trim() || importing}
                loading={importing}
              >
                Importar
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Result view */}
            <div className="space-y-3">
              {result.alreadyImported ? (
                <div className="bg-amber-900/20 border border-amber-700 rounded-lg p-3 text-sm text-amber-200">
                  Este pack ya fue importado anteriormente.
                </div>
              ) : result.errors.length > 0 ? (
                <div className="bg-rose-900/20 border border-rose-700 rounded-lg p-3 text-sm text-rose-200">
                  <p className="font-semibold mb-1">Errores:</p>
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs">
                      • {err}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="bg-sage-900/20 border border-sage-700 rounded-lg p-3 text-sm text-sage-200">
                  <p className="font-semibold mb-1">Importación completada</p>
                  <p className="text-xs">
                    {result.newConcepts} concepto{result.newConcepts !== 1 ? 's' : ''} nuevos
                    {result.duplicates > 0 && `, ${result.duplicates} duplicados omitidos`}
                    {result.newTopicsCreated > 0 &&
                      `, ${result.newTopicsCreated} tema${result.newTopicsCreated !== 1 ? 's' : ''} creados`}
                  </p>
                  <p className="text-xs text-ink-400 mt-1">
                    Pack de: {result.createdBy}
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end border-t border-ink-700 pt-4">
              <Button onClick={onClose}>Cerrar</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
