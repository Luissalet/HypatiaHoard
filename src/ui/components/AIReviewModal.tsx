/**
 * AIReviewModal.tsx
 *
 * Modal para revisar preguntas extraídas/generadas por la IA.
 * Permite aceptar, rechazar y editar cada pregunta antes de importarlas.
 * Cada pregunta tiene su propio tema asignado (detectado por la IA o editable).
 */

import React, { useState, useMemo, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Modal, Button, Badge, TypeBadge, Difficulty } from './index';
import { MdContent } from '@/ui/components/MdContent';
import { slugify } from '@/domain/normalize';
import type { ExtractedQuestion } from '@/services/aiEngine';
import type { Topic } from '@/domain/models';

// ─── Types ───────────────────────────────────────────────────────────────────

type ReviewStatus = 'accepted' | 'rejected';

interface ReviewItem {
  id: string;
  question: ExtractedQuestion;
  status: ReviewStatus;
  /** Edited version (if user modified it) */
  edited?: ExtractedQuestion;
  /** Resolved topic ID for this specific question */
  topicId: string;
}

export interface AcceptedQuestion {
  question: ExtractedQuestion;
  topicId: string;
}

interface AIReviewModalProps {
  open: boolean;
  questions: ExtractedQuestion[];
  topics: Topic[];
  sourceFileName: string;
  mode: 'generate' | 'extract';
  onImport: (accepted: AcceptedQuestion[]) => Promise<void>;
  onCancel: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a topicKey from the AI to a real topic ID, or fall back to default */
function resolveTopicId(topicKey: string | undefined, topics: Topic[], fallbackId: string): string {
  if (!topicKey || topics.length === 0) return fallbackId;

  // Exact slug match
  const bySlug = topics.find((t) => slugify(t.title) === topicKey);
  if (bySlug) return bySlug.id;

  // Partial match: topicKey contains key words from topic title
  const keyLower = topicKey.toLowerCase().replace(/-/g, ' ');
  const byPartial = topics.find((t) => {
    const titleLower = t.title.toLowerCase();
    // Check if most significant words overlap
    const keyWords = keyLower.split(' ').filter((w) => w.length > 3);
    const matchCount = keyWords.filter((w) => titleLower.includes(w)).length;
    return keyWords.length > 0 && matchCount >= keyWords.length * 0.5;
  });
  if (byPartial) return byPartial.id;

  return fallbackId;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AIReviewModal({
  open,
  questions,
  topics,
  sourceFileName,
  mode,
  onImport,
  onCancel,
}: AIReviewModalProps) {
  const fallbackTopicId = topics[0]?.id ?? '';

  const [items, setItems] = useState<ReviewItem[]>(() =>
    questions.map((q) => ({
      id: uuidv4(),
      question: q,
      status: 'accepted' as ReviewStatus,
      topicId: resolveTopicId(q.topicKey, topics, fallbackTopicId),
    })),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Reset items when questions change
  React.useEffect(() => {
    setItems(
      questions.map((q) => ({
        id: uuidv4(),
        question: q,
        status: 'accepted' as ReviewStatus,
        topicId: resolveTopicId(q.topicKey, topics, fallbackTopicId),
      })),
    );
    setExpandedId(null);
    setEditingId(null);
  }, [questions, topics, fallbackTopicId]);

  const acceptedCount = useMemo(() => items.filter((i) => i.status === 'accepted').length, [items]);
  const rejectedCount = useMemo(() => items.filter((i) => i.status === 'rejected').length, [items]);

  // Count unique topics detected
  const detectedTopics = useMemo(() => {
    const topicIds = new Set(items.map((i) => i.topicId));
    return topicIds.size;
  }, [items]);

  const toggleStatus = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, status: item.status === 'accepted' ? 'rejected' : 'accepted' }
          : item,
      ),
    );
  }, []);

  const acceptAll = useCallback(() => {
    setItems((prev) => prev.map((item) => ({ ...item, status: 'accepted' })));
  }, []);

  const rejectAll = useCallback(() => {
    setItems((prev) => prev.map((item) => ({ ...item, status: 'rejected' })));
  }, []);

  const setItemTopicId = useCallback((id: string, topicId: string) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, topicId } : item)),
    );
  }, []);

  /** Set all questions to a specific topic at once */
  const setAllTopics = useCallback((topicId: string) => {
    setItems((prev) => prev.map((item) => ({ ...item, topicId })));
  }, []);

  const handleImport = async () => {
    const accepted: AcceptedQuestion[] = items
      .filter((i) => i.status === 'accepted')
      .map((i) => ({
        question: i.edited ?? i.question,
        topicId: i.topicId,
      }));
    if (accepted.length === 0) return;

    setImporting(true);
    try {
      await onImport(accepted);
    } finally {
      setImporting(false);
    }
  };

  // ── Inline edit handlers ──

  const handleEditField = (id: string, field: string, value: any) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const current = item.edited ?? { ...item.question };
        return { ...item, edited: { ...current, [field]: value } };
      }),
    );
  };

  /** Get topic title by ID for display */
  const getTopicTitle = (topicId: string): string => {
    const t = topics.find((t) => t.id === topicId);
    return t ? t.title : 'Tema desconocido';
  };

  /** Short topic label (e.g. "Tema 5- Búsqueda..." → "T5") */
  const getTopicShort = (topicId: string): string => {
    const title = getTopicTitle(topicId);
    const match = title.match(/Tema\s+(\d+)/i);
    return match ? `T${match[1]}` : title.slice(0, 12);
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Revisión — ${questions.length} preguntas ${mode === 'generate' ? 'generadas' : 'extraídas'}`}
      size="xl"
    >
      <div className="flex flex-col gap-4 max-h-[75vh] overflow-hidden">
        {/* ── Header info ── */}
        <div className="flex items-center gap-3 flex-wrap">
          <Badge color="ink">{sourceFileName}</Badge>
          <Badge color="sage">{acceptedCount} aceptadas</Badge>
          {rejectedCount > 0 && <Badge color="rose">{rejectedCount} rechazadas</Badge>}
          {detectedTopics > 1 && (
            <Badge color="blue">{detectedTopics} temas detectados</Badge>
          )}
        </div>

        {/* ── Bulk topic assignment (fallback) ── */}
        <div className="flex items-center gap-3">
          <label className="text-xs text-ink-400 uppercase tracking-widest whitespace-nowrap">
            Asignar todas a:
          </label>
          <select
            onChange={(e) => setAllTopics(e.target.value)}
            defaultValue=""
            className="flex-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-sm text-ink-100 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
          >
            <option value="" disabled>
              — Mantener temas individuales —
            </option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        {/* ── Bulk actions ── */}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={acceptAll}>
            Aceptar todas
          </Button>
          <Button size="sm" variant="ghost" onClick={rejectAll}>
            Rechazar todas
          </Button>
        </div>

        {/* ── Question list ── */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {items.map((item, idx) => {
            const q = item.edited ?? item.question;
            const isExpanded = expandedId === item.id;
            const isEditing = editingId === item.id;
            const isAccepted = item.status === 'accepted';

            return (
              <div
                key={item.id}
                className={`rounded-lg border transition-colors ${
                  isAccepted
                    ? 'border-ink-700 bg-ink-900'
                    : 'border-rose-800/40 bg-rose-950/20 opacity-60'
                }`}
              >
                {/* ── Row header ── */}
                <div className="flex items-center gap-2 px-4 py-3">
                  {/* Accept/reject toggle */}
                  <button
                    onClick={() => toggleStatus(item.id)}
                    className={`flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center text-xs font-bold transition-colors ${
                      isAccepted
                        ? 'border-sage-500 bg-sage-500/20 text-sage-400'
                        : 'border-rose-500 bg-rose-500/10 text-rose-400'
                    }`}
                    title={isAccepted ? 'Rechazar' : 'Aceptar'}
                  >
                    {isAccepted ? '✓' : '✗'}
                  </button>

                  {/* Question number */}
                  <span className="text-xs text-ink-500 w-5 text-right">{idx + 1}</span>

                  {/* Type badge */}
                  <TypeBadge type={q.type} />

                  {/* Topic badge */}
                  <span
                    className="text-xs bg-ink-800 border border-ink-600 rounded px-1.5 py-0.5 text-ink-300 flex-shrink-0 max-w-[80px] truncate"
                    title={getTopicTitle(item.topicId)}
                  >
                    {getTopicShort(item.topicId)}
                  </span>

                  {/* Difficulty */}
                  {q.difficulty && <Difficulty level={q.difficulty} />}

                  {/* Prompt preview (truncated) */}
                  <button
                    onClick={() => {
                      setExpandedId(isExpanded ? null : item.id);
                      if (isEditing) setEditingId(null);
                    }}
                    className="flex-1 text-left text-sm text-ink-200 truncate hover:text-ink-100 min-w-0"
                  >
                    {q.prompt.replace(/[#*`\n$\\]/g, ' ').trim().slice(0, 80)}
                    {q.prompt.length > 80 ? '...' : ''}
                  </button>

                  {/* Edit button */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(isEditing ? null : item.id);
                      if (!isExpanded) setExpandedId(item.id);
                    }}
                  >
                    {isEditing ? 'Cerrar' : 'Editar'}
                  </Button>
                </div>

                {/* ── Expanded preview ── */}
                {isExpanded && !isEditing && (
                  <div className="px-4 pb-4 border-t border-ink-800">
                    {/* Topic indicator */}
                    <div className="mt-3 mb-2 flex items-center gap-2">
                      <span className="text-xs text-ink-500">Tema:</span>
                      <span className="text-xs text-ink-300">{getTopicTitle(item.topicId)}</span>
                    </div>

                    <div>
                      <p className="text-xs text-ink-500 uppercase tracking-widest mb-2">
                        Enunciado
                      </p>
                      <MdContent
                        content={q.prompt}
                        className="text-ink-100 text-sm leading-relaxed prose prose-invert prose-sm max-w-none"
                      />
                    </div>

                    {/* TEST options */}
                    {q.type === 'TEST' && q.options && (
                      <div className="mt-3 flex flex-col gap-1.5">
                        {q.options.map((opt) => {
                          const isCorrect = q.correctOptionIds?.includes(opt.id);
                          return (
                            <div
                              key={opt.id}
                              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                                isCorrect
                                  ? 'bg-sage-600/10 border border-sage-600/30 text-sage-300'
                                  : 'bg-ink-800/50 border border-ink-700 text-ink-300'
                              }`}
                            >
                              <span className="font-medium">
                                {isCorrect ? '✓' : '○'} {opt.id.toUpperCase()})
                              </span>
                              <MdContent content={opt.text} className="inline text-sm" />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* DESARROLLO / PRACTICO model answer */}
                    {(q.type === 'DESARROLLO' || q.type === 'PRACTICO') && q.modelAnswer && (
                      <div className="mt-3">
                        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">
                          Respuesta modelo
                        </p>
                        <MdContent
                          content={q.modelAnswer}
                          className="text-ink-200 text-sm prose prose-invert prose-sm max-w-none"
                        />
                      </div>
                    )}

                    {/* COMPLETAR cloze */}
                    {q.type === 'COMPLETAR' && q.clozeText && (
                      <div className="mt-3">
                        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">
                          Texto con huecos
                        </p>
                        <p className="text-sm text-ink-200">{q.clozeText}</p>
                      </div>
                    )}

                    {/* Explanation */}
                    {q.explanation && (
                      <div className="mt-3 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
                        <p className="text-xs text-amber-400 uppercase tracking-widest mb-1">
                          Explicación
                        </p>
                        <MdContent
                          content={q.explanation}
                          className="text-ink-200 text-sm prose prose-invert prose-sm max-w-none"
                        />
                      </div>
                    )}

                    {/* Tags */}
                    {q.tags && q.tags.length > 0 && (
                      <div className="mt-3 flex gap-1 flex-wrap">
                        {q.tags.map((tag) => (
                          <Badge key={tag} color="ink">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Inline editor ── */}
                {isEditing && (
                  <div className="px-4 pb-4 border-t border-ink-800">
                    <div className="mt-3 flex flex-col gap-3">
                      {/* Type + Difficulty + Topic */}
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs text-ink-400 uppercase tracking-widest">
                            Tipo
                          </label>
                          <select
                            value={q.type}
                            onChange={(e) =>
                              handleEditField(item.id, 'type', e.target.value)
                            }
                            className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-sm text-ink-100"
                          >
                            <option value="TEST">TEST</option>
                            <option value="DESARROLLO">DESARROLLO</option>
                            <option value="COMPLETAR">COMPLETAR</option>
                            <option value="PRACTICO">PRÁCTICO</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-ink-400 uppercase tracking-widest">
                            Dificultad
                          </label>
                          <select
                            value={q.difficulty ?? 3}
                            onChange={(e) =>
                              handleEditField(item.id, 'difficulty', Number(e.target.value))
                            }
                            className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-sm text-ink-100"
                          >
                            {[1, 2, 3, 4, 5].map((d) => (
                              <option key={d} value={d}>
                                {d} — {['Muy fácil', 'Fácil', 'Medio', 'Difícil', 'Muy difícil'][d - 1]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-ink-400 uppercase tracking-widest">
                            Tema
                          </label>
                          <select
                            value={item.topicId}
                            onChange={(e) => setItemTopicId(item.id, e.target.value)}
                            className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-sm text-ink-100"
                          >
                            {topics.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* Prompt */}
                      <div>
                        <label className="text-xs text-ink-400 uppercase tracking-widest">
                          Enunciado
                        </label>
                        <textarea
                          value={q.prompt}
                          onChange={(e) => handleEditField(item.id, 'prompt', e.target.value)}
                          rows={4}
                          className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 resize-y font-mono"
                        />
                      </div>

                      {/* TEST: options editor */}
                      {q.type === 'TEST' && q.options && (
                        <div>
                          <label className="text-xs text-ink-400 uppercase tracking-widest">
                            Opciones (checkbox = correcta)
                          </label>
                          {q.options.map((opt, optIdx) => (
                            <div key={opt.id} className="flex items-center gap-2 mt-1">
                              <input
                                type="checkbox"
                                checked={q.correctOptionIds?.includes(opt.id) ?? false}
                                onChange={() => {
                                  const current = new Set(q.correctOptionIds ?? []);
                                  if (current.has(opt.id)) current.delete(opt.id);
                                  else current.add(opt.id);
                                  handleEditField(
                                    item.id,
                                    'correctOptionIds',
                                    Array.from(current),
                                  );
                                }}
                                className="accent-sage-500"
                              />
                              <input
                                value={opt.text}
                                onChange={(e) => {
                                  const newOptions = [...(q.options ?? [])];
                                  newOptions[optIdx] = { ...opt, text: e.target.value };
                                  handleEditField(item.id, 'options', newOptions);
                                }}
                                className="flex-1 bg-ink-800 border border-ink-700 rounded px-2 py-1 text-sm text-ink-100"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Explanation */}
                      <div>
                        <label className="text-xs text-ink-400 uppercase tracking-widest">
                          Explicación
                        </label>
                        <textarea
                          value={q.explanation ?? ''}
                          onChange={(e) =>
                            handleEditField(item.id, 'explanation', e.target.value || undefined)
                          }
                          rows={2}
                          className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 resize-y font-mono"
                        />
                      </div>

                      {/* Model answer (DESARROLLO/PRACTICO) */}
                      {(q.type === 'DESARROLLO' || q.type === 'PRACTICO') && (
                        <div>
                          <label className="text-xs text-ink-400 uppercase tracking-widest">
                            Respuesta modelo
                          </label>
                          <textarea
                            value={q.modelAnswer ?? ''}
                            onChange={(e) =>
                              handleEditField(item.id, 'modelAnswer', e.target.value || undefined)
                            }
                            rows={3}
                            className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 resize-y font-mono"
                          />
                        </div>
                      )}

                      {/* Tags */}
                      <div>
                        <label className="text-xs text-ink-400 uppercase tracking-widest">
                          Tags (separados por coma)
                        </label>
                        <input
                          value={(q.tags ?? []).join(', ')}
                          onChange={(e) =>
                            handleEditField(
                              item.id,
                              'tags',
                              e.target.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean),
                            )
                          }
                          className="w-full mt-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-sm text-ink-100"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Footer actions ── */}
        <div className="flex items-center justify-between border-t border-ink-800 pt-4">
          <span className="text-sm text-ink-400">
            {acceptedCount} de {items.length} preguntas seleccionadas
          </span>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
            <Button
              onClick={handleImport}
              loading={importing}
              disabled={acceptedCount === 0}
            >
              Importar {acceptedCount} pregunta{acceptedCount !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
