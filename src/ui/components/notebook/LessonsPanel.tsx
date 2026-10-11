/**
 * LessonsPanel.tsx
 *
 * "Lecciones" tab of the Cuaderno (hoard mode): "enséñame este documento". Paste text or pick a
 * .txt/.md/.pdf file, preview the lesson the server drafts (sections, concepts, questions), save it,
 * then study it section by section with the questions interleaved, and see the mastery per concept
 * (computed by the server from the review history).
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { Button, EmptyState } from '@/ui/components';
import {
  createLesson, deleteLesson, getLessonFlow, getLessonMastery, getLessonSection, gradeAnswer, listLessons, reviewQuestion,
  type ConceptMasteryRow, type CreateLessonResult, type GradeResult, type Lesson, type LessonLevel, type LessonMastery,
  type LessonQuestion, type LessonRow, type LessonSectionView, type ReviewGrade,
} from '@/data/lessonsClient';
import { HoardError } from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';

const MAX_CHARS = 60_000;

const LEVEL_STYLE: Record<LessonLevel, { dot: string; bar: string; text: string }> = {
  'sin ver': { dot: 'bg-ink-500', bar: 'bg-ink-500', text: 'text-ink-300' },
  'débil': { dot: 'bg-rose-500', bar: 'bg-rose-500', text: 'text-rose-300' },
  'en progreso': { dot: 'bg-amber-500', bar: 'bg-amber-500', text: 'text-amber-300' },
  'dominado': { dot: 'bg-sage-500', bar: 'bg-sage-500', text: 'text-sage-300' },
};

const GRADES: { id: ReviewGrade; label: string }[] = [
  { id: 'again', label: 'Otra vez' }, { id: 'hard', label: 'Difícil' }, { id: 'good', label: 'Bien' }, { id: 'easy', label: 'Fácil' },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pct = (v: number) => `${Math.round(v * 100)} %`;

function LevelBadge({ level }: { level: LessonLevel }) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE['sin ver'];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${s.text}`}>
      <span className={`w-2 h-2 rounded-full ${s.dot}`} aria-hidden="true" />{level}
    </span>
  );
}

function MasteryBar({ value, level, label }: { value: number; level?: LessonLevel; label: string }) {
  const color = level ? LEVEL_STYLE[level].bar : 'bg-amber-500';
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}
      className="h-2 w-full rounded-full bg-ink-700 overflow-hidden">
      <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} />
    </div>
  );
}

/** Plain text with **bold** spans (the section text is not HTML). */
function Bold({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => (/^\*\*[^*\n]+\*\*$/.test(part) ? <strong key={i} className="text-ink-100">{part.slice(2, -2)}</strong> : part))}</>;
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function LessonsPanel() {
  const { serverSubjectId, subjectName, caps } = useNotebook();
  const ref = subjectName || serverSubjectId; // the name finds (or creates) the subject on the server even if its id was never synced
  const [rows, setRows] = useState<LessonRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listLessons(ref).then(setRows).catch((e) => {
      setRows([]); // 404: the subject has no lessons (or is not on the server yet)
      if (!(e instanceof HoardError && e.status === 404)) setError(errText(e));
    });
  }, [ref]);
  useEffect(refresh, [refresh]);

  if (openId) {
    return <LessonView lessonId={openId} onBack={() => { setOpenId(null); refresh(); }} />;
  }
  return (
    <div className="flex flex-col gap-5">
      <NewLesson subjectRef={ref} hasModel={caps.llm} onCreated={(l) => { refresh(); setOpenId(l.id); }} />
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <section aria-labelledby="lessons-list-h" className="flex flex-col gap-2">
        <h2 id="lessons-list-h" className="text-xs font-medium text-ink-400 uppercase tracking-widest">Mis lecciones</h2>
        {rows === null && <p className="text-sm text-ink-500">Cargando…</p>}
        {rows?.length === 0 && (
          <EmptyState title="Aún no hay lecciones" description="Pega un texto o elige un PDF arriba y Hypatia te armará una lección con preguntas." />
        )}
        <ul className="flex flex-col gap-2">
          {rows?.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setOpenId(r.id)}
                className="w-full text-left bg-ink-800 border border-ink-700 hover:border-amber-500/60 rounded-xl p-4 flex flex-col gap-2 min-h-[44px] focus:outline-none focus:ring-2 focus:ring-amber-500">
                <span className="flex items-start justify-between gap-3">
                  <span className="font-display text-ink-100 break-words min-w-0">{r.title}</span>
                  <span className="text-xs text-ink-400 flex-shrink-0">{pct(r.mastery)}</span>
                </span>
                <MasteryBar value={r.mastery} label={`Dominio de ${r.title}`} />
                <span className="text-[11px] text-ink-500">{r.sections} secciones · {r.concepts} conceptos · {r.source}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ── Create / preview ─────────────────────────────────────────────────────────

function NewLesson({ subjectRef, hasModel, onCreated }: { subjectRef: string; hasModel: boolean; onCreated: (lesson: Lesson) => void }) {
  const ids = { text: useId(), title: useId(), file: useId() };
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<'read' | 'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CreateLessonResult | null>(null);

  const tooLong = text.length > MAX_CHARS;
  const ready = text.trim().length >= 40;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy('read');
    try {
      let content: string;
      if (/\.pdf$/i.test(file.name)) {
        const { extractPdfText } = await import('@/utils/pdfTextExtractor');
        const url = URL.createObjectURL(file);
        try {
          const res = await extractPdfText(url);
          content = res.blocks.map((b) => (b.type === 'heading' ? `# ${b.text}` : b.text)).join('\n\n');
        } finally {
          URL.revokeObjectURL(url);
        }
        if (!content.trim()) throw new Error('El PDF no tiene texto seleccionable (¿es un escaneo?).');
      } else {
        content = await file.text();
      }
      setText(content);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      setPreview(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (save: boolean) => {
    setError(null);
    setBusy(save ? 'save' : 'preview');
    try {
      const res = await createLesson({ subject: subjectRef, text: text.slice(0, MAX_CHARS), title: title.trim() || undefined, save });
      if (save) onCreated(res.lesson);
      else setPreview(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="new-lesson-h" className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-3">
      <div>
        <h2 id="new-lesson-h" className="font-display text-lg text-ink-100">Enséñame este documento</h2>
        <p className="text-xs text-ink-500 mt-0.5">
          Hypatia lo divide en secciones, saca los conceptos clave y prepara una pregunta por concepto.
          {hasModel ? '' : ' No hay modelo de texto disponible: se usarán reglas sencillas (definiciones y títulos).'}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.file} className="text-xs font-medium text-ink-400 uppercase tracking-widest">Fichero (PDF, TXT o MD)</label>
        <input id={ids.file} type="file" accept=".pdf,.txt,.md,.markdown,text/plain,application/pdf"
          onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
          className="text-sm text-ink-300 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-700 file:px-3 file:py-2 file:text-ink-100 file:cursor-pointer" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.text} className="text-xs font-medium text-ink-400 uppercase tracking-widest">O pega el texto</label>
        <textarea id={ids.text} value={text} rows={7} onChange={(e) => { setText(e.target.value); setPreview(null); }}
          aria-describedby={`${ids.text}-hint`} placeholder="Pega aquí los apuntes, un capítulo, un artículo…"
          className="bg-ink-900 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
        <p id={`${ids.text}-hint`} className={`text-[11px] ${tooLong ? 'text-amber-400' : 'text-ink-500'}`}>
          {text.length.toLocaleString('es-ES')} caracteres{tooLong ? ` · solo se usarán los primeros ${MAX_CHARS.toLocaleString('es-ES')}` : ' · mínimo 40'}
        </p>
      </div>
      <div className="flex flex-col gap-1 sm:w-80">
        <label htmlFor={ids.title} className="text-xs font-medium text-ink-400 uppercase tracking-widest">Título (opcional)</label>
        <input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
          className="bg-ink-900 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!ready || busy !== null} loading={busy === 'preview' || busy === 'read'} onClick={() => run(false)} className="min-h-[44px] flex-1 sm:flex-none">
          {busy === 'read' ? 'Leyendo…' : 'Vista previa'}
        </Button>
        <Button disabled={!ready || busy !== null} loading={busy === 'save'} onClick={() => run(true)} className="min-h-[44px] flex-1 sm:flex-none">
          Crear lección
        </Button>
      </div>
      <div aria-live="polite">
        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      </div>
      {preview && <Preview result={preview} onDiscard={() => setPreview(null)} onSave={() => run(true)} saving={busy === 'save'} />}
    </section>
  );
}

function Preview({ result, onDiscard, onSave, saving }: { result: CreateLessonResult; onDiscard: () => void; onSave: () => void; saving: boolean }) {
  const { lesson } = result;
  return (
    <div className="border border-amber-500/40 bg-ink-900/60 rounded-xl p-3 sm:p-4 flex flex-col gap-3" role="region" aria-label="Vista previa de la lección">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-ink-100 break-words">{lesson.title}</h3>
          <p className="text-[11px] text-ink-500">
            {lesson.sections.length} secciones · {lesson.concepts.length} conceptos · {lesson.model ? 'con modelo' : 'con reglas (sin modelo)'} · aún no guardada
          </p>
        </div>
      </div>
      {result.note && <p className="text-xs text-amber-400">{result.note}</p>}
      <ol className="flex flex-col gap-3">
        {lesson.sections.map((s) => (
          <li key={s.n} className="flex flex-col gap-1.5">
            <p className="text-sm text-ink-100"><span className="text-ink-500">{s.n}.</span> {s.title}</p>
            <ul className="flex flex-col gap-1 pl-4">
              {lesson.concepts.filter((c) => c.section === s.n).map((c) => (
                <li key={c.id} className="text-xs text-ink-300">
                  <span className="text-amber-300">{c.name}</span>
                  {c.question && <span className="text-ink-500"> — {c.question.prompt}</span>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onSave} loading={saving} className="min-h-[44px] flex-1 sm:flex-none">Guardar y empezar</Button>
        <Button variant="ghost" onClick={onDiscard} className="min-h-[44px] flex-1 sm:flex-none">Descartar</Button>
      </div>
    </div>
  );
}

// ── Lesson view ──────────────────────────────────────────────────────────────

function LessonView({ lessonId, onBack }: { lessonId: string; onBack: () => void }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [mastery, setMastery] = useState<LessonMastery | null>(null);
  const [section, setSection] = useState(1);
  const [view, setView] = useState<LessonSectionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMastery = useCallback(() => {
    getLessonMastery(lessonId).then(setMastery).catch((e) => setError(errText(e)));
  }, [lessonId]);

  useEffect(() => {
    getLessonFlow(lessonId).then((f) => setLesson(f.lesson)).catch((e) => setError(errText(e)));
    loadMastery();
  }, [lessonId, loadMastery]);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    getLessonSection(lessonId, section).then((v) => { if (!cancelled) setView(v); }).catch((e) => { if (!cancelled) setError(errText(e)); });
    return () => { cancelled = true; };
  }, [lessonId, section]);

  const remove = async () => {
    if (!confirm('¿Borrar esta lección? Las preguntas se quedan en el banco.')) return;
    try { await deleteLesson(lessonId); onBack(); } catch (e) { setError(errText(e)); }
  };

  const total = lesson?.sections.length ?? 0;
  const levels = new Map<string, LessonLevel>(mastery?.concepts.map((c) => [c.conceptId, c.level]) ?? []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="min-h-[44px]">← Lecciones</Button>
        <Button variant="ghost" size="sm" onClick={remove} className="min-h-[44px]">Borrar</Button>
      </div>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      {!lesson && !error && <p className="text-sm text-ink-500">Cargando…</p>}
      {lesson && (
        <>
          <header className="flex flex-col gap-2">
            <h2 className="font-display text-xl text-ink-100 break-words">{lesson.title}</h2>
            <div className="flex items-center gap-3">
              <div className="flex-1"><MasteryBar value={mastery?.mastery ?? 0} label="Dominio de la lección" /></div>
              <span className="text-xs text-ink-300 flex-shrink-0">Dominio {pct(mastery?.mastery ?? 0)}</span>
            </div>
          </header>

          <nav aria-label="Secciones" className="flex gap-1.5 overflow-x-auto pb-1">
            {lesson.sections.map((s) => (
              <button key={s.n} type="button" onClick={() => setSection(s.n)} aria-current={s.n === section ? 'step' : undefined}
                className={`flex-shrink-0 min-h-[44px] min-w-[44px] px-3 rounded-lg text-sm border focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                  s.n === section ? 'bg-amber-500 text-ink-900 border-amber-500' : 'bg-ink-800 text-ink-300 border-ink-700 hover:border-ink-500'}`}
                title={s.title}>
                {s.n}
              </button>
            ))}
          </nav>

          <article aria-labelledby="section-h" className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-3">
            <h3 id="section-h" className="font-display text-lg text-ink-100 break-words">{section}. {view?.section.title ?? lesson.sections[section - 1]?.title}</h3>
            {!view && <p className="text-sm text-ink-500">Cargando sección…</p>}
            {view && (
              <>
                <div className="text-sm text-ink-200 leading-relaxed whitespace-pre-wrap break-words font-body"><Bold text={view.section.text} /></div>
                <ul className="flex flex-wrap gap-2" aria-label="Conceptos de la sección">
                  {view.concepts.map((c) => (
                    <li key={c.id} className="bg-ink-900 border border-ink-700 rounded-lg px-2.5 py-1.5 flex flex-col gap-0.5 max-w-full" title={c.summary}>
                      <span className="text-xs text-amber-300 break-words">{c.name}</span>
                      <LevelBadge level={levels.get(c.id) ?? c.level} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </article>

          {view && view.flow.filter((s) => s.step === 'question').length > 0 && (
            <section aria-labelledby="questions-h" className="flex flex-col gap-3">
              <h3 id="questions-h" className="text-xs font-medium text-ink-400 uppercase tracking-widest">Comprueba lo que has leído</h3>
              {view.flow.filter((s) => s.step === 'question' && s.question).map((s) => (
                <QuestionCard key={s.question!.id} lessonId={lessonId} section={section} step={s} onReviewed={loadMastery} />
              ))}
            </section>
          )}

          <div className="flex justify-between gap-2">
            <Button variant="secondary" disabled={section <= 1} onClick={() => setSection(section - 1)} className="min-h-[44px] flex-1 sm:flex-none">← Anterior</Button>
            <Button variant="secondary" disabled={section >= total} onClick={() => setSection(section + 1)} className="min-h-[44px] flex-1 sm:flex-none">Siguiente →</Button>
          </div>

          {mastery && <MasteryPanel mastery={mastery} onGo={setSection} />}
        </>
      )}
    </div>
  );
}

// ── Question ─────────────────────────────────────────────────────────────────

function QuestionCard({ lessonId, section, step, onReviewed }: {
  lessonId: string; section: number; step: { concept?: string; question?: LessonQuestion }; onReviewed: () => void;
}) {
  const q = step.question!;
  const inputId = useId();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [graded, setGraded] = useState<GradeResult | null>(null);
  const [answers, setAnswers] = useState<LessonQuestion | null>(null);
  const [done, setDone] = useState<ReviewGrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isTest = q.type === 'TEST' && !!q.options?.length;
  const answered = isTest ? picked.length > 0 : text.trim().length > 0;

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const [g, withAnswers] = await Promise.all([
        gradeAnswer(q.id, isTest ? picked : text),
        getLessonSection(lessonId, section, true),
      ]);
      setGraded(g);
      setAnswers(withAnswers.flow.find((s) => s.question?.id === q.id)?.question ?? null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const grade = async (g: ReviewGrade) => {
    setBusy(true);
    setError(null);
    try {
      await reviewQuestion(q.id, g);
      setDone(g);
      onReviewed();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const verdictText = graded?.verdict === 'correct' ? 'Correcto' : graded?.verdict === 'partial' ? 'Parcialmente correcto' : graded?.verdict === 'wrong' ? 'Incorrecto' : null;
  const correctIds = new Set(answers?.correctOptionIds ?? []);

  return (
    <div className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-3">
      {step.concept && <p className="text-[11px] text-amber-300">Concepto: {step.concept}</p>}
      {isTest ? (
        <fieldset className="flex flex-col gap-2" disabled={!!graded}>
          <legend className="text-sm text-ink-100 mb-1 break-words">{q.prompt}</legend>
          {q.options!.map((o) => {
            const mark = graded ? (correctIds.has(o.id) ? 'border-sage-500' : picked.includes(o.id) ? 'border-rose-500' : 'border-ink-700') : 'border-ink-700';
            return (
              <label key={o.id} className={`flex items-start gap-2 text-sm text-ink-200 bg-ink-900 border ${mark} rounded-lg px-3 py-2 min-h-[44px] cursor-pointer`}>
                <input type="checkbox" className="mt-1 accent-amber-500" checked={picked.includes(o.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))} />
                <span className="break-words min-w-0">{o.text}</span>
              </label>
            );
          })}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm text-ink-100 break-words">{q.prompt}</label>
          <textarea id={inputId} value={text} rows={3} disabled={!!graded} onChange={(e) => setText(e.target.value)} placeholder="Tu respuesta con tus palabras"
            className="bg-ink-900 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 resize-y focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
        </div>
      )}

      {!graded && (
        <div><Button onClick={check} disabled={!answered} loading={busy} className="min-h-[44px] w-full sm:w-auto">Comprobar</Button></div>
      )}

      <div aria-live="polite" className="flex flex-col gap-2">
        {graded && (
          <>
            {verdictText && <p className={`text-sm font-medium ${graded.verdict === 'correct' ? 'text-sage-300' : graded.verdict === 'partial' ? 'text-amber-300' : 'text-rose-300'}`}>{verdictText}{graded.feedback && graded.feedback.replace(/\.$/, '') !== verdictText ? `. ${graded.feedback}` : '.'}</p>}
            {graded.missing && graded.missing.length > 0 && <p className="text-xs text-ink-400">Te faltó: {graded.missing.join(', ')}</p>}
            {answers?.modelAnswer && <p className="text-sm text-ink-200 whitespace-pre-wrap break-words"><span className="text-ink-500">Respuesta modelo: </span>{answers.modelAnswer}</p>}
            {answers?.explanation && <p className="text-xs text-ink-400 break-words">{answers.explanation}</p>}
            {!done && (
              <div role="group" aria-label="¿Cómo te ha ido?" className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
                {GRADES.map((g) => (
                  <Button key={g.id} variant={g.id === graded.suggestedGrade ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => grade(g.id)} className="min-h-[44px]">
                    {g.label}{g.id === graded.suggestedGrade ? ' (sugerido)' : ''}
                  </Button>
                ))}
              </div>
            )}
            {done && <p className="text-xs text-sage-300">Registrado: {GRADES.find((g) => g.id === done)?.label}. El dominio se ha actualizado.</p>}
          </>
        )}
        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      </div>
    </div>
  );
}

// ── Mastery panel ────────────────────────────────────────────────────────────

function MasteryPanel({ mastery, onGo }: { mastery: LessonMastery; onGo: (section: number) => void }) {
  const rows: ConceptMasteryRow[] = [...mastery.concepts].sort((a, b) => a.mastery - b.mastery || a.section - b.section);
  const levelOrder: LessonLevel[] = ['dominado', 'en progreso', 'débil', 'sin ver'];
  return (
    <section aria-labelledby="mastery-h" className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-3">
      <h3 id="mastery-h" className="font-display text-lg text-ink-100">Dominio por concepto</h3>
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Resumen por nivel">
        {levelOrder.map((l) => (
          <li key={l} className="text-xs text-ink-300"><LevelBadge level={l} /> <span className="text-ink-500">· {mastery.levels[l] ?? 0}</span></li>
        ))}
      </ul>
      {mastery.weakest.length > 0 && (
        <p className="text-xs text-ink-400"><span className="text-ink-500">Para repasar primero: </span>{mastery.weakest.slice(0, 3).join(', ')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.conceptId}>
            <button type="button" onClick={() => onGo(r.section)}
              className="w-full text-left bg-ink-900 border border-ink-700 hover:border-ink-500 rounded-lg px-3 py-2 flex flex-col gap-1.5 min-h-[44px] focus:outline-none focus:ring-2 focus:ring-amber-500">
              <span className="flex items-start justify-between gap-2">
                <span className="text-sm text-ink-100 break-words min-w-0">{r.concept}</span>
                <span className="text-xs text-ink-400 flex-shrink-0">{pct(r.mastery)}</span>
              </span>
              <MasteryBar value={r.mastery} level={r.level} label={`Dominio de ${r.concept}`} />
              <span className="flex flex-wrap items-center gap-x-3 text-[11px] text-ink-500">
                <LevelBadge level={r.level} />
                <span>sección {r.section}</span>
                <span>{r.attempts} {r.attempts === 1 ? 'respuesta' : 'respuestas'}</span>
                {r.dueNow && <span className="text-amber-400">toca repasar</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
