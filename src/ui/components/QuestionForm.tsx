import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Question, Topic, QuestionType, QuestionOption, ClozeBlank, QuestionOrigin } from '@/domain/models';
import { Button, Input, Textarea, Select } from './index';
import { MdContent } from '@/ui/components/MdContent';
import { saveQuestionImage } from '@/data/questionImageStorage';

interface QuestionFormProps {
  topics: Topic[];
  initial?: Partial<Question>;
  onSave: (data: Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>) => void;
  onCancel: () => void;
  subjectId: string;
}

const ORIGIN_LABELS: Record<QuestionOrigin, string> = {
  test: 'Test / Práctica',
  examen_anterior: 'Examen anterior',
  clase: 'Clase',
  alumno: 'Alumno',
};

// ─── Where a card came from ───────────────────────────────────────────────────

const REF_APPS: Record<string, string> = { links: 'Links Hoard', funes: 'Funes', people: "People's Hoard", kafka: "Kafka's Hoard" };

/** hoard://links/highlight/<id> -> "De Links Hoard · highlight"; an http(s) reference is a real link. */
export function sourceRefLabel(ref: string): string {
  const m = /^hoard:\/\/([^/]+)\/([^/]+)/.exec(ref);
  return m ? `De ${REF_APPS[m[1]] ?? m[1]} · ${m[2] === 'highlight' ? 'subrayado' : m[2]}` : ref;
}

function SourceRefChip({ sourceRef }: { sourceRef: string }) {
  const isWeb = /^https?:\/\//i.test(sourceRef);
  const className = 'inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-800 px-2.5 py-0.5 text-xs text-ink-300';
  return (
    <div className="flex items-center gap-2" data-testid="source-ref">
      <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Origen</span>
      {isWeb
        ? <a href={sourceRef} target="_blank" rel="noreferrer" className={className}>{sourceRef}</a>
        : <span className={className} title={sourceRef}>{sourceRefLabel(sourceRef)}</span>}
    </div>
  );
}

// ─── Expandable Textarea with MD preview + drag & drop images ─────────────────

interface ExpandableTextareaProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  /** When true: enables MD preview, drag-and-drop images, and paste images */
  supportsMd?: boolean;
}

function ExpandableTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  required,
  supportsMd,
}: ExpandableTextareaProps) {
  const [expanded, setExpanded] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounterRef = useRef(0); // track nested drag enter/leave

  // Auto-resize when expanded
  useEffect(() => {
    if (expanded && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [expanded, value]);

  // ── Insert text at cursor ──
  const insertAtCursor = useCallback(
    (insertion: string) => {
      const textarea = textareaRef.current;
      const pos = textarea?.selectionStart ?? value.length;
      const newValue = value.slice(0, pos) + insertion + value.slice(pos);
      onChange(newValue);
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        if (textarea) {
          const newPos = pos + insertion.length;
          textarea.selectionStart = newPos;
          textarea.selectionEnd = newPos;
          textarea.focus();
        }
      });
    },
    [value, onChange]
  );

  // ── Upload image files and insert markdown ──
  const handleImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      setUploading(true);
      try {
        for (const file of imageFiles) {
          const filename = await saveQuestionImage(file);
          insertAtCursor(`\n![](question-images/${filename})\n`);
        }
      } finally {
        setUploading(false);
      }
    },
    [insertAtCursor]
  );

  // ── Drag & drop ──
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!supportsMd) return;
      e.preventDefault();
      dragCounterRef.current++;
      if (e.dataTransfer.types.includes('Files')) setDragging(true);
    },
    [supportsMd]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragging(false);
      if (!supportsMd) return;
      const files = Array.from(e.dataTransfer.files);
      await handleImageFiles(files);
    },
    [supportsMd, handleImageFiles]
  );

  // ── Paste (Ctrl+V with image in clipboard) ──
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!supportsMd) return;
      const imageItems = Array.from(e.clipboardData.items).filter((i) =>
        i.type.startsWith('image/')
      );
      if (imageItems.length === 0) return;
      e.preventDefault();
      const files = imageItems.map((i) => i.getAsFile()).filter(Boolean) as File[];
      await handleImageFiles(files);
    },
    [supportsMd, handleImageFiles]
  );

  return (
    <div
      className="flex flex-col gap-1"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          {label}
          {uploading && (
            <span className="ml-2 text-amber-400 animate-pulse">↑ subiendo imagen…</span>
          )}
        </label>
        <div className="flex items-center gap-2">
          {supportsMd && value && (
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className="text-xs text-ink-500 hover:text-ink-300 transition-colors px-1.5 py-0.5 rounded hover:bg-ink-700"
              title={showPreview ? 'Editar' : 'Vista previa MD'}
            >
              {showPreview ? '✎ Editar' : '👁 Preview'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-ink-500 hover:text-ink-300 transition-colors px-1.5 py-0.5 rounded hover:bg-ink-700"
            title={expanded ? 'Contraer' : 'Expandir'}
          >
            {expanded ? '↗ Contraer' : '↙ Expandir'}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className={`relative rounded-lg ${dragging ? 'ring-2 ring-amber-400' : ''}`}>
        {showPreview && supportsMd ? (
          <MdContent
            content={value}
            className={`bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body prose prose-invert prose-sm max-w-none min-h-[60px] overflow-auto ${
              expanded ? 'max-h-[60vh]' : 'max-h-[200px]'
            }`}
          />
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            placeholder={placeholder}
            required={required}
            rows={expanded ? undefined : rows}
            className={`w-full bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all ${
              expanded ? 'min-h-[200px] max-h-[60vh] overflow-auto resize-y' : 'resize-none'
            }`}
            style={expanded ? { height: 'auto', minHeight: '200px' } : undefined}
          />
        )}

        {/* Drag overlay */}
        {dragging && (
          <div className="absolute inset-0 rounded-lg bg-amber-500/10 border-2 border-dashed border-amber-400 flex items-center justify-center pointer-events-none z-10">
            <span className="text-amber-300 text-sm font-medium">📎 Suelta la imagen para insertarla</span>
          </div>
        )}
      </div>

      {/* Hints */}
      {supportsMd && !showPreview && (
        <p className="text-xs text-ink-600">
          Soporta Markdown: **negrita**, *cursiva*, tablas, listas… · Arrastra o pega imágenes para insertarlas inline
        </p>
      )}
    </div>
  );
}

// ─── Multi-topic selector ────────────────────────────────────────────────────

interface MultiTopicSelectorProps {
  topics: Topic[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function MultiTopicSelector({ topics, selectedIds, onChange }: MultiTopicSelectorProps) {
  const [showAll, setShowAll] = useState(false);

  const toggleTopic = (id: string) => {
    if (selectedIds.includes(id)) {
      if (selectedIds.length > 1) {
        onChange(selectedIds.filter((s) => s !== id));
      }
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          Temas ({selectedIds.length} seleccionado{selectedIds.length !== 1 ? 's' : ''})
        </label>
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="text-xs text-ink-500 hover:text-ink-300 transition-colors"
        >
          {showAll ? 'Ocultar' : 'Mostrar todos'}
        </button>
      </div>
      {!showAll ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {selectedIds.map((id) => {
              const t = topics.find((tp) => tp.id === id);
              if (!t) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 bg-amber-500/15 text-amber-300 border border-amber-500/25 rounded-md px-2 py-0.5 text-xs"
                >
                  {t.title}
                  {selectedIds.length > 1 && (
                    <button
                      type="button"
                      onClick={() => toggleTopic(id)}
                      className="text-amber-500/60 hover:text-amber-300 ml-0.5"
                    >
                      ✕
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          <select
            value=""
            onChange={(e) => { if (e.target.value) toggleTopic(e.target.value); }}
            className="bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
          >
            <option value="">+ Añadir tema…</option>
            {topics.filter((t) => !selectedIds.includes(t.id)).map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-col gap-1 max-h-52 overflow-y-auto rounded-lg border border-ink-700 p-2 bg-ink-800/50">
          {topics.map((t) => (
            <label
              key={t.id}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                selectedIds.includes(t.id) ? 'bg-amber-500/10 text-amber-300' : 'text-ink-300 hover:bg-ink-700'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(t.id)}
                onChange={() => toggleTopic(t.id)}
                className="accent-amber-500"
              />
              {t.title}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main form ────────────────────────────────────────────────────────────────

export function QuestionForm({ topics, initial, onSave, onCancel, subjectId }: QuestionFormProps) {
  const [type, setType] = useState<QuestionType>(initial?.type ?? 'TEST');

  // Multi-topic support
  const initialTopicIds = initial?.topicIds?.length
    ? initial.topicIds
    : initial?.topicId
    ? [initial.topicId]
    : topics[0]?.id
    ? [topics[0].id]
    : [];
  const [selectedTopicIds, setSelectedTopicIds] = useState<string[]>(initialTopicIds);

  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [explanation, setExplanation] = useState(initial?.explanation ?? '');
  const [difficulty, setDifficulty] = useState<string>(String(initial?.difficulty ?? ''));
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [origin, setOrigin] = useState<QuestionOrigin | ''>(initial?.origin ?? '');

  // TEST
  const [options, setOptions] = useState<QuestionOption[]>(
    initial?.options ?? [
      { id: uuidv4(), text: '' },
      { id: uuidv4(), text: '' },
    ]
  );
  const [correctOptionIds, setCorrectOptionIds] = useState<string[]>(initial?.correctOptionIds ?? []);

  // DESARROLLO / PRACTICO
  const [modelAnswer, setModelAnswer] = useState(initial?.modelAnswer ?? '');
  const [keywords, setKeywords] = useState(initial?.keywords?.join(', ') ?? '');
  const [numericAnswer, setNumericAnswer] = useState(initial?.numericAnswer ?? '');

  // COMPLETAR
  const [clozeText, setClozeText] = useState(initial?.clozeText ?? '');
  const [blanks, setBlanks] = useState<ClozeBlank[]>(initial?.blanks ?? []);

  // Notas personales (LOCAL — nunca exportadas)
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const addOption = () => setOptions([...options, { id: uuidv4(), text: '' }]);
  const removeOption = (id: string) => {
    setOptions(options.filter((o) => o.id !== id));
    setCorrectOptionIds(correctOptionIds.filter((c) => c !== id));
  };
  const updateOption = (id: string, text: string) =>
    setOptions(options.map((o) => (o.id === id ? { ...o, text } : o)));
  const toggleCorrect = (id: string) => {
    setCorrectOptionIds((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  // Parse cloze text to extract blanks ({{blank}})
  const parseCloze = () => {
    const regex = /\{\{([^}]+)\}\}/g;
    const found: ClozeBlank[] = [];
    let match;
    while ((match = regex.exec(clozeText)) !== null) {
      const existing = blanks.find((b) => b.id === match![1]);
      found.push(existing ?? { id: match![1], accepted: [match![1]] });
    }
    setBlanks(found);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    const parsedKeywords = keywords.split(',').map((k) => k.trim()).filter(Boolean);
    const diff = difficulty ? (parseInt(difficulty) as Question['difficulty']) : undefined;

    const primaryTopicId = selectedTopicIds[0] ?? '';

    onSave({
      subjectId,
      topicId: primaryTopicId,
      topicIds: selectedTopicIds.length > 1 ? selectedTopicIds : undefined,
      type,
      prompt,
      explanation: explanation || undefined,
      difficulty: diff,
      tags: parsedTags.length > 0 ? parsedTags : undefined,
      origin: origin || undefined,
      options: type === 'TEST' ? options.filter((o) => o.text.trim()) : undefined,
      correctOptionIds: type === 'TEST' ? correctOptionIds : undefined,
      modelAnswer: (type === 'DESARROLLO' || type === 'PRACTICO') ? modelAnswer : undefined,
      keywords: (type === 'DESARROLLO' || type === 'PRACTICO') && parsedKeywords.length > 0 ? parsedKeywords : undefined,
      numericAnswer: type === 'PRACTICO' && numericAnswer ? numericAnswer : undefined,
      clozeText: type === 'COMPLETAR' ? clozeText : undefined,
      blanks: type === 'COMPLETAR' ? blanks : undefined,
      // Keep legacy imageDataUrls from initial (backward compat) but don't add new ones —
      // new images go inline in the prompt markdown
      imageDataUrls: initial?.imageDataUrls?.length ? initial.imageDataUrls : undefined,
      // Notas personales (LOCAL — no se exportan ni hashean)
      notes: notes.trim() || undefined,
      // Starred se preserva del initial, no se edita desde el formulario (se hace inline)
      starred: initial?.starred,
      // De dónde vino la tarjeta (la pone el servidor); se conserva al editar
      sourceRef: initial?.sourceRef,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Row 1: type + origin */}
      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Tipo"
          value={type}
          onChange={(e) => setType(e.target.value as QuestionType)}
        >
          <option value="TEST">Test</option>
          <option value="DESARROLLO">Desarrollo</option>
          <option value="COMPLETAR">Completar</option>
          <option value="PRACTICO">Práctico</option>
        </Select>
        <Select
          label="Origen"
          value={origin}
          onChange={(e) => setOrigin(e.target.value as QuestionOrigin | '')}
        >
          <option value="">Sin especificar</option>
          {(Object.keys(ORIGIN_LABELS) as QuestionOrigin[]).map((key) => (
            <option key={key} value={key}>{ORIGIN_LABELS[key]}</option>
          ))}
        </Select>
      </div>

      {/* Multi-topic selector */}
      <MultiTopicSelector
        topics={topics}
        selectedIds={selectedTopicIds}
        onChange={setSelectedTopicIds}
      />

      {/* Difficulty */}
      <Select
        label="Dificultad"
        value={difficulty}
        onChange={(e) => setDifficulty(e.target.value)}
      >
        <option value="">Sin especificar</option>
        <option value="1">★ Muy fácil</option>
        <option value="2">★★ Fácil</option>
        <option value="3">★★★ Media</option>
        <option value="4">★★★★ Difícil</option>
        <option value="5">★★★★★ Muy difícil</option>
      </Select>

      {/* Prompt — drag & drop + paste images enabled */}
      <ExpandableTextarea
        label="Enunciado"
        value={prompt}
        onChange={setPrompt}
        required
        rows={3}
        placeholder="Escribe la pregunta aquí… Arrastra o pega imágenes para insertarlas."
        supportsMd
      />

      {/* TEST options */}
      {type === 'TEST' && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-ink-400 uppercase tracking-widest">Opciones (marca las correctas)</p>
          {options.map((opt, i) => (
            <div key={opt.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleCorrect(opt.id)}
                className={`w-5 h-5 rounded flex-shrink-0 border-2 transition-colors ${
                  correctOptionIds.includes(opt.id)
                    ? 'bg-sage-600 border-sage-600'
                    : 'bg-transparent border-ink-500 hover:border-sage-600'
                }`}
                title="Marcar como correcta"
              />
              <input
                type="text"
                value={opt.text}
                onChange={(e) => updateOption(opt.id, e.target.value)}
                placeholder={`Opción ${String.fromCharCode(65 + i)}`}
                className="flex-1 bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(opt.id)}
                  className="text-ink-600 hover:text-rose-400 transition-colors text-sm"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addOption}
            className="self-start text-xs text-ink-500 hover:text-ink-300 transition-colors"
          >
            + Añadir opción
          </button>
        </div>
      )}

      {/* DESARROLLO / PRACTICO */}
      {(type === 'DESARROLLO' || type === 'PRACTICO') && (
        <div className="flex flex-col gap-3">
          <ExpandableTextarea
            label="Respuesta modelo (opcional)"
            value={modelAnswer}
            onChange={setModelAnswer}
            rows={3}
            placeholder="Respuesta esperada o criterios de corrección…"
            supportsMd
          />
          <Input
            label="Palabras clave esperadas (separadas por coma)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="ej: gradiente, función de pérdida, backprop"
          />
          {type === 'PRACTICO' && (
            <Input
              label="Resultado numérico esperado (opcional)"
              value={numericAnswer}
              onChange={(e) => setNumericAnswer(e.target.value)}
              placeholder="ej: 0.857 o 85.7%"
            />
          )}
        </div>
      )}

      {/* COMPLETAR */}
      {type === 'COMPLETAR' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <ExpandableTextarea
              label="Texto con huecos (usa {{respuesta}} para cada hueco)"
              value={clozeText}
              onChange={setClozeText}
              rows={3}
              placeholder="El proceso de {{tokenización}} divide el texto en unidades mínimas."
              supportsMd
            />
            <button
              type="button"
              onClick={parseCloze}
              className="mt-2 text-xs text-amber-400 hover:text-amber-300 transition-colors"
            >
              ↻ Detectar huecos
            </button>
          </div>
          {blanks.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-ink-400 uppercase tracking-widest">
                Respuestas aceptadas por hueco
              </p>
              {blanks.map((b) => (
                <div key={b.id} className="flex items-center gap-3">
                  <span className="text-xs text-ink-500 font-mono w-28 truncate">{'{{'}{b.id}{'}}'}</span>
                  <input
                    type="text"
                    value={b.accepted.join(', ')}
                    onChange={(e) =>
                      setBlanks(
                        blanks.map((bl) =>
                          bl.id === b.id
                            ? { ...bl, accepted: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }
                            : bl
                        )
                      )
                    }
                    className="flex-1 bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-1.5 text-xs font-body focus:outline-none focus:ring-2 focus:ring-amber-500"
                    placeholder="respuesta1, resp alternativa…"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Explanation + tags */}
      <ExpandableTextarea
        label="Explicación / feedback (opcional)"
        value={explanation}
        onChange={setExplanation}
        rows={2}
        placeholder="Se muestra al revisar resultados…"
        supportsMd
      />
      <Input
        label="Tags (separados por coma)"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="ej: busqueda, heuristica, A*"
      />

      {initial?.sourceRef && <SourceRefChip sourceRef={initial.sourceRef} />}

      {/* A4: Notas personales — LOCAL, nunca exportadas */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          Mis notas (privadas) <span className="text-ink-600 normal-case font-normal">· solo visibles por ti</span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Apunta algo que quieras recordar…"
          className="w-full bg-ink-800 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-600 focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 justify-end pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" disabled={!prompt.trim() || selectedTopicIds.length === 0}>
          {initial?.id ? 'Guardar cambios' : 'Crear pregunta'}
        </Button>
      </div>
    </form>
  );
}