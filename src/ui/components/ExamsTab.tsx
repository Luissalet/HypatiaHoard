import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Modal, Input, EmptyState, Badge, TypeBadge, Select } from '@/ui/components';
import { QuestionPreviewContent } from '@/ui/components/QuestionPreview';
import type { Exam, Question, Topic, QuestionType, QuestionOrigin } from '@/domain/models';
import { exportExams, importExams, downloadJSON, parseImportFile } from '@/data/exportImport';
import { PdfExportModal } from '@/ui/components/PdfExportModal';
import { generateExamsPDF, downloadBlob } from '@/utils/pdfExport';

// ── Props ────────────────────────────────────────────────────────────────────

interface ExamsTabProps {
  subjectId: string;
  exams: Exam[];
  questions: Question[];
  topics: Topic[];
  onCreate: (data: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Exam>;
  onUpdate: (id: string, data: Partial<Exam>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ORIGIN_LABELS: Record<QuestionOrigin, string> = {
  test: 'Test',
  examen_anterior: 'Examen ant.',
  clase: 'Clase',
  alumno: 'Alumno',
};

const ORIGIN_COLORS: Record<QuestionOrigin, 'amber' | 'rose' | 'blue' | 'sage'> = {
  test: 'amber',
  examen_anterior: 'rose',
  clase: 'blue',
  alumno: 'sage',
};

function questionBelongsToTopic(q: Question, topicId: string): boolean {
  if (q.topicId === topicId) return true;
  if (q.topicIds && q.topicIds.includes(topicId)) return true;
  return false;
}

// ── Main component ───────────────────────────────────────────────────────────

export function ExamsTab({ subjectId, exams, questions, topics, onCreate, onUpdate, onDelete, onDuplicate }: ExamsTabProps) {
  const navigate = useNavigate();
  const [editModal, setEditModal] = useState(false);
  const [editingExam, setEditingExam] = useState<Exam | null>(null);
  const [previewExam, setPreviewExam] = useState<Exam | null>(null);

  // ── Selection mode for export ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── PDF export modal ──
  const [pdfExportOpen, setPdfExportOpen] = useState(false);

  // ── Import state ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<{ examsAdded: number; questionsMatched: number; questionsMissing: number; errors: string[] } | null>(null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === exams.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(exams.map((e) => e.id)));
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleExport = async () => {
    if (selectedIds.size === 0) return;
    const data = await exportExams([...selectedIds]);
    const name = selectedIds.size === 1
      ? exams.find((e) => e.id === [...selectedIds][0])?.name ?? 'examen'
      : `${selectedIds.size}_examenes`;
    downloadJSON(data, `${name}.json`);
    exitSelectMode();
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await parseImportFile(file);
      const result = await importExams(raw, subjectId);
      setImportResult(result);
      // Reload exams in parent via store
      const { useStore } = await import('@/ui/store');
      await useStore.getState().loadExams(subjectId);
    } catch (err) {
      setImportResult({ examsAdded: 0, questionsMatched: 0, questionsMissing: 0, errors: [(err as Error).message] });
    }
    // Reset file input so the same file can be re-imported
    e.target.value = '';
  };

  const openCreate = () => {
    setEditingExam(null);
    setEditModal(true);
  };

  const openEdit = (exam: Exam) => {
    setEditingExam(exam);
    setEditModal(true);
  };

  const handleSave = async (data: { name: string; description: string; questionIds: string[] }) => {
    if (editingExam) {
      await onUpdate(editingExam.id, data);
    } else {
      await onCreate({ subjectId, ...data });
    }
    setEditModal(false);
    setEditingExam(null);
  };

  const handlePractice = async (exam: Exam) => {
    if (exam.questionIds.length === 0) return;
    const { sessionRepo } = await import('@/data/repos');
    const session = await sessionRepo.create({
      subjectId,
      mode: 'exam',
      questionIds: exam.questionIds,
    });
    navigate(`/practice/${session.id}`);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-ink-400 text-sm flex-1 min-w-0">
          Crea exámenes personalizados seleccionando y ordenando preguntas del banco.
        </p>
        <div className="flex gap-2 items-center flex-shrink-0">
          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button size="sm" variant="ghost" onClick={handleImportClick} title="Importar exámenes desde archivo JSON">
            Importar
          </Button>
          {exams.length > 0 && !selectMode && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setPdfExportOpen(true)} title="Exportar exámenes como PDF">
                PDF
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectMode(true)} title="Seleccionar exámenes para exportar JSON">
                Seleccionar
              </Button>
            </>
          )}
          {selectMode && (
            <>
              <Button size="sm" variant="ghost" onClick={toggleSelectAll} title={selectedIds.size === exams.length ? 'Deseleccionar todos' : 'Seleccionar todos'}>
                {selectedIds.size === exams.length ? 'Ninguno' : 'Todos'}
              </Button>
              <Button size="sm" onClick={handleExport} disabled={selectedIds.size === 0}>
                Exportar ({selectedIds.size})
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelectMode}>
                Cancelar
              </Button>
            </>
          )}
          {!selectMode && (
            <Button size="sm" onClick={openCreate}>+ Nuevo examen</Button>
          )}
        </div>
      </div>

      {/* ── Import result toast ── */}
      {importResult && (
        <div className={`rounded-xl border p-3 text-sm ${importResult.errors.length > 0 && importResult.examsAdded === 0 ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              {importResult.examsAdded > 0 && (
                <p>{importResult.examsAdded} examen{importResult.examsAdded !== 1 ? 'es' : ''} importado{importResult.examsAdded !== 1 ? 's' : ''}. {importResult.questionsMatched} pregunta{importResult.questionsMatched !== 1 ? 's' : ''} vinculada{importResult.questionsMatched !== 1 ? 's' : ''}.</p>
              )}
              {importResult.questionsMissing > 0 && (
                <p className="text-ink-400">{importResult.questionsMissing} pregunta{importResult.questionsMissing !== 1 ? 's' : ''} no encontrada{importResult.questionsMissing !== 1 ? 's' : ''} en el banco (omitida{importResult.questionsMissing !== 1 ? 's' : ''}).</p>
              )}
              {importResult.errors.map((err, i) => (
                <p key={i} className="text-rose-400">{err}</p>
              ))}
            </div>
            <button onClick={() => setImportResult(null)} className="text-ink-500 hover:text-ink-300 transition-colors">✕</button>
          </div>
        </div>
      )}

      {exams.length === 0 ? (
        <EmptyState
          icon={<span>📝</span>}
          title="Sin exámenes"
          description="Crea un examen para organizar y practicar un set de preguntas curado."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {exams.map((exam) => {
            const resolvedQuestions = exam.questionIds
              .map((id) => questions.find((q) => q.id === id))
              .filter(Boolean) as Question[];
            const deletedCount = exam.questionIds.length - resolvedQuestions.length;

            const byType: Record<string, number> = {};
            for (const q of resolvedQuestions) {
              byType[q.type] = (byType[q.type] || 0) + 1;
            }

            const isSelected = selectedIds.has(exam.id);

            return (
              <Card
                key={exam.id}
                className={`group cursor-pointer ${isSelected ? 'ring-1 ring-amber-500/50' : ''}`}
                onClick={() => selectMode ? toggleSelect(exam.id) : setPreviewExam(exam)}
              >
                <div className="flex items-start justify-between gap-4">
                  {/* Checkbox in select mode */}
                  {selectMode && (
                    <div className="flex items-center pt-1 flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(exam.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 rounded border-ink-600 bg-ink-900 text-amber-500 focus:ring-amber-500 focus:ring-offset-0 cursor-pointer accent-amber-500"
                      />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium text-ink-100">{exam.name}</h4>
                      <span className="text-xs text-ink-500">
                        {resolvedQuestions.length} pregunta{resolvedQuestions.length !== 1 ? 's' : ''}
                      </span>
                      {deletedCount > 0 && (
                        <span className="text-xs text-rose-400" title="Preguntas eliminadas del banco">
                          ({deletedCount} eliminada{deletedCount !== 1 ? 's' : ''})
                        </span>
                      )}
                    </div>
                    {exam.description && (
                      <p className="text-sm text-ink-400 mb-2">{exam.description}</p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      {Object.entries(byType).map(([type]) => (
                        <TypeBadge key={type} type={type as QuestionType} />
                      ))}
                      <span className="text-xs text-ink-600">
                        {new Date(exam.createdAt).toLocaleDateString('es-ES')}
                      </span>
                    </div>
                  </div>

                  {!selectMode && (
                    <div className="flex gap-2 items-center flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        onClick={() => handlePractice(exam)}
                        disabled={resolvedQuestions.length === 0}
                      >
                        Practicar
                      </Button>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(exam)} title="Editar">✎</Button>
                        <Button size="sm" variant="ghost" onClick={() => onDuplicate(exam.id)} title="Duplicar">⧉</Button>
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm(`¿Eliminar "${exam.name}"?`)) onDelete(exam.id); }} title="Eliminar">
                          <span className="text-rose-400">✕</span>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal preview examen — todas las preguntas resueltas */}
      {previewExam && (
        <Modal
          open={!!previewExam}
          onClose={() => setPreviewExam(null)}
          title={previewExam.name}
          size="xl"
        >
          <ExamPreview
            exam={previewExam}
            questions={questions}
            topics={topics}
            onPractice={() => { setPreviewExam(null); handlePractice(previewExam); }}
            onEdit={() => { setPreviewExam(null); openEdit(previewExam); }}
            onClose={() => setPreviewExam(null)}
          />
        </Modal>
      )}

      {/* Modal exportar PDF */}
      <PdfExportModal
        open={pdfExportOpen}
        onClose={() => setPdfExportOpen(false)}
        title="Exportar exámenes como PDF"
        items={exams}
        getId={(e) => e.id}
        renderItem={(exam) => {
          const resolvedQs = exam.questionIds.map((id) => questions.find((q) => q.id === id)).filter(Boolean);
          return (
            <div>
              <span className="text-sm text-ink-100 font-medium">{exam.name}</span>
              <span className="text-xs text-ink-500 ml-2">
                {resolvedQs.length} pregunta{resolvedQs.length !== 1 ? 's' : ''}
              </span>
              {exam.description && (
                <p className="text-xs text-ink-400 mt-0.5 line-clamp-1">{exam.description}</p>
              )}
            </div>
          );
        }}
        onExport={async (selectedIds) => {
          const blob = await generateExamsPDF(exams, questions, topics, '', selectedIds);
          const name = selectedIds.size === 1
            ? exams.find((e) => selectedIds.has(e.id))?.name ?? 'examen'
            : `${selectedIds.size}_examenes`;
          downloadBlob(blob, `${name}.pdf`);
        }}
      />

      {/* Modal crear/editar examen */}
      <Modal
        open={editModal}
        onClose={() => { setEditModal(false); setEditingExam(null); }}
        title={editingExam ? 'Editar examen' : 'Nuevo examen'}
        size="xl"
      >
        <ExamEditor
          initial={editingExam}
          questions={questions}
          topics={topics}
          onSave={handleSave}
          onCancel={() => { setEditModal(false); setEditingExam(null); }}
        />
      </Modal>
    </div>
  );
}

// ── Exam Editor (modal content) ──────────────────────────────────────────────

interface ExamEditorProps {
  initial: Exam | null;
  questions: Question[];
  topics: Topic[];
  onSave: (data: { name: string; description: string; questionIds: string[] }) => void;
  onCancel: () => void;
}

function ExamEditor({ initial, questions, topics, onSave, onCancel }: ExamEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(initial?.questionIds ?? []);

  // Internal tab: 'bank' or 'selected'
  const [view, setView] = useState<'bank' | 'selected'>('bank');

  // Filters for the question picker
  const [filterTopic, setFilterTopic] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  // Preview state
  const [previewQuestion, setPreviewQuestion] = useState<Question | null>(null);

  // Drag state for reordering
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const selectedSet = new Set(selectedIds);

  // Filter available questions (exclude already selected)
  const filteredQuestions = questions.filter((q) => {
    if (selectedSet.has(q.id)) return false;
    if (filterTopic && !questionBelongsToTopic(q, filterTopic)) return false;
    if (filterType && q.type !== filterType) return false;
    if (filterSearch.trim()) {
      const terms = filterSearch.toLowerCase().split(/\s+/);
      const hay = [q.prompt, q.explanation ?? '', ...(q.tags ?? [])].join(' ').toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const addQuestion = (id: string) => {
    setSelectedIds((prev) => [...prev, id]);
  };

  const removeQuestion = (id: string) => {
    setSelectedIds((prev) => prev.filter((qid) => qid !== id));
  };

  const addAll = () => {
    setSelectedIds((prev) => [...prev, ...filteredQuestions.map((q) => q.id)]);
  };

  const handleReorder = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const reordered = [...selectedIds];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setSelectedIds(reordered);
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSave({ name: name.trim(), description: description.trim(), questionIds: selectedIds });
  };

  // Resolve selected questions preserving order
  const selectedQuestions = selectedIds
    .map((id) => questions.find((q) => q.id === id))
    .filter(Boolean) as Question[];

  return (
    <div className="flex flex-col gap-4">
      {/* Name & description */}
      <div className="flex gap-3">
        <Input
          label="Nombre del examen"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej: Parcial Temas 1-5"
          autoFocus
        />
        <Input
          label="Descripción (opcional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ej: Simulacro para el parcial de marzo"
        />
      </div>

      {/* View toggle tabs */}
      <div className="flex gap-1 bg-ink-800/50 rounded-lg p-1">
        <button
          onClick={() => setView('bank')}
          className={`flex-1 text-sm font-medium px-3 py-1.5 rounded-md transition-all ${
            view === 'bank'
              ? 'bg-ink-700 text-ink-100 shadow-sm'
              : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Banco de preguntas ({filteredQuestions.length})
        </button>
        <button
          onClick={() => setView('selected')}
          className={`flex-1 text-sm font-medium px-3 py-1.5 rounded-md transition-all ${
            view === 'selected'
              ? 'bg-ink-700 text-ink-100 shadow-sm'
              : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          Seleccionadas ({selectedIds.length})
        </button>
      </div>

      {/* Bank view */}
      {view === 'bank' && (
        <div className="flex flex-col gap-3">
          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            <input
              type="search"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Buscar en preguntas..."
              className="flex-1 min-w-[150px] bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-amber-500"
            />
            <Select value={filterTopic} onChange={(e) => setFilterTopic(e.target.value)} className="text-sm">
              <option value="">Todos los temas</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </Select>
            <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="text-sm">
              <option value="">Todos los tipos</option>
              <option value="TEST">Test</option>
              <option value="DESARROLLO">Desarrollo</option>
              <option value="COMPLETAR">Completar</option>
              <option value="PRACTICO">Práctico</option>
            </Select>
          </div>

          {/* Add all */}
          {filteredQuestions.length > 0 && (
            <button
              onClick={addAll}
              className="text-xs text-amber-400 hover:text-amber-300 transition-colors text-left"
            >
              + Añadir todas ({filteredQuestions.length})
            </button>
          )}

          {/* Question list */}
          <div className="max-h-[40vh] overflow-y-auto space-y-2">
            {filteredQuestions.length === 0 ? (
              <p className="text-sm text-ink-500 text-center py-8">
                {questions.length === 0 ? 'No hay preguntas en el banco' : 'Sin resultados para los filtros aplicados'}
              </p>
            ) : (
              filteredQuestions.map((q) => {
                const topic = topics.find((t) => t.id === q.topicId);
                return (
                  <div
                    key={q.id}
                    className="rounded-xl border border-ink-800 hover:border-ink-700 transition-all"
                  >
                    <div className="flex items-center">
                      {/* Clickable area → opens preview */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setPreviewQuestion(q)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setPreviewQuestion(q); }}
                        className="p-3 flex-1 min-w-0 cursor-pointer hover:bg-ink-800/40 transition-colors"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <TypeBadge type={q.type} />
                          {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                          {q.difficulty && <span className="text-xs text-ink-600">{'★'.repeat(q.difficulty)}</span>}
                        </div>
                        <p className="text-sm text-ink-200 line-clamp-2">{q.prompt}</p>
                      </div>
                      {/* Add button */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => addQuestion(q.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addQuestion(q.id); }}
                        className="px-4 py-3 cursor-pointer text-sm font-medium text-amber-500 hover:bg-amber-500/10 hover:text-amber-400 transition-colors border-l border-ink-800 self-stretch flex items-center"
                      >
                        +
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Selected view */}
      {view === 'selected' && (
        <div className="flex flex-col gap-3">
          {selectedIds.length > 0 && (
            <div className="flex justify-between items-center">
              <p className="text-xs text-ink-500">Arrastra ⠿ para reordenar</p>
              <button
                onClick={() => setSelectedIds([])}
                className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
              >
                Quitar todas
              </button>
            </div>
          )}

          <div className="max-h-[40vh] overflow-y-auto space-y-2">
            {selectedQuestions.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-ink-500 mb-2">No hay preguntas seleccionadas.</p>
                <button
                  onClick={() => setView('bank')}
                  className="text-sm text-amber-400 hover:text-amber-300 transition-colors"
                >
                  Ir al banco de preguntas
                </button>
              </div>
            ) : (
              selectedQuestions.map((q, idx) => {
                const topic = topics.find((t) => t.id === q.topicId);
                const isOver = dragOverIdx === idx && dragIdx !== idx;
                return (
                  <div
                    key={q.id}
                    draggable
                    onDragStart={(e) => {
                      setDragIdx(idx);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverIdx(idx);
                    }}
                    onDragLeave={() => setDragOverIdx(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIdx != null) handleReorder(dragIdx, idx);
                      setDragIdx(null);
                      setDragOverIdx(null);
                    }}
                    onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                    className={`rounded-xl border transition-all ${
                      isOver
                        ? 'border-amber-500/60 bg-amber-500/5'
                        : 'border-ink-800 bg-ink-900/50 hover:border-ink-700'
                    }`}
                  >
                    <div className="flex items-center p-3 gap-2">
                      {/* Drag handle */}
                      <span
                        className="text-ink-600 hover:text-ink-400 text-sm cursor-grab active:cursor-grabbing select-none"
                        title="Arrastra para reordenar"
                      >
                        ⠿
                      </span>
                      <span className="text-ink-500 text-xs font-mono w-6 text-right">
                        {idx + 1}.
                      </span>
                      {/* Click to preview */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setPreviewQuestion(q)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setPreviewQuestion(q); }}
                        className="flex-1 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <TypeBadge type={q.type} />
                          {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                        </div>
                        <p className="text-sm text-ink-200 line-clamp-2">{q.prompt}</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeQuestion(q.id); }}
                        className="text-sm text-ink-600 hover:text-rose-400 transition-colors px-2"
                        title="Quitar"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 border-t border-ink-800 pt-3">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button onClick={handleSubmit} disabled={!name.trim() || selectedIds.length === 0}>
          {initial ? 'Guardar' : 'Crear examen'} ({selectedIds.length} preguntas)
        </Button>
      </div>

      {/* Preview modal */}
      {previewQuestion && (
        <Modal
          open={!!previewQuestion}
          onClose={() => setPreviewQuestion(null)}
          title={previewQuestion.prompt.slice(0, 60) + (previewQuestion.prompt.length > 60 ? '...' : '')}
          size="lg"
        >
          <div className="flex flex-col gap-4">
            {/* Badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <TypeBadge type={previewQuestion.type} />
              {previewQuestion.origin && (
                <Badge color={ORIGIN_COLORS[previewQuestion.origin]}>
                  {ORIGIN_LABELS[previewQuestion.origin]}
                </Badge>
              )}
              {previewQuestion.difficulty && (
                <span className="text-xs text-ink-500">{'★'.repeat(previewQuestion.difficulty)}</span>
              )}
            </div>

            <QuestionPreviewContent question={previewQuestion} />

            <div className="flex justify-end gap-2 pt-2 border-t border-ink-800">
              {!selectedSet.has(previewQuestion.id) ? (
                <Button
                  size="sm"
                  onClick={() => {
                    addQuestion(previewQuestion.id);
                    setPreviewQuestion(null);
                  }}
                >
                  + Añadir al examen
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    removeQuestion(previewQuestion.id);
                    setPreviewQuestion(null);
                  }}
                >
                  <span className="text-rose-400">Quitar del examen</span>
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPreviewQuestion(null)}>
                Cerrar
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Exam Preview (all questions solved) ──────────────────────────────────────

interface ExamPreviewProps {
  exam: Exam;
  questions: Question[];
  topics: Topic[];
  onPractice: () => void;
  onEdit: () => void;
  onClose: () => void;
}

function ExamPreview({ exam, questions, topics, onPractice, onEdit, onClose }: ExamPreviewProps) {
  const resolvedQuestions = exam.questionIds
    .map((id) => questions.find((q) => q.id === id))
    .filter(Boolean) as Question[];

  return (
    <div className="flex flex-col gap-4">
      {/* Header info */}
      {exam.description && (
        <p className="text-sm text-ink-400">{exam.description}</p>
      )}
      <div className="flex items-center gap-3 text-xs text-ink-500">
        <span>{resolvedQuestions.length} pregunta{resolvedQuestions.length !== 1 ? 's' : ''}</span>
        <span>Creado: {new Date(exam.createdAt).toLocaleDateString('es-ES')}</span>
      </div>

      {/* All questions */}
      <div className="max-h-[60vh] overflow-y-auto space-y-6 pr-1">
        {resolvedQuestions.map((q, idx) => {
          const topic = topics.find((t) => t.id === q.topicId);
          return (
            <div key={q.id}>
              {/* Question header */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-mono text-ink-500 font-medium">
                  {idx + 1}/{resolvedQuestions.length}
                </span>
                <TypeBadge type={q.type} />
                {q.origin && (
                  <Badge color={ORIGIN_COLORS[q.origin]}>
                    {ORIGIN_LABELS[q.origin]}
                  </Badge>
                )}
                {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                {q.difficulty && (
                  <span className="text-xs text-ink-600">{'★'.repeat(q.difficulty)}</span>
                )}
              </div>

              {/* Question content (enunciado + respuesta + explicación) */}
              <div className="border border-ink-800 rounded-xl p-4 bg-ink-900/30">
                <QuestionPreviewContent question={q} />
              </div>

              {/* Separator between questions (except last) */}
              {idx < resolvedQuestions.length - 1 && (
                <div className="border-t border-ink-800/50 mt-6" />
              )}
            </div>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="flex justify-end gap-2 pt-2 border-t border-ink-800">
        <Button size="sm" onClick={onPractice} disabled={resolvedQuestions.length === 0}>
          Practicar
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          ✎ Editar
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    </div>
  );
}
