/**
 * Flashcard.tsx
 *
 * Modo repaso rápido: tarjetas con animación de flip.
 * No guarda sesión ni estadísticas — es solo para repasar visualmente.
 *
 * URL: /flashcard/:subjectId?topic=X&types=TEST,COMPLETAR&mode=random|all|topic|failed&count=20
 *
 * Teclado:
 *   Espacio / Enter  → voltear tarjeta
 *   →  / L           → siguiente
 *   ←  / J           → anterior
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '@/ui/store';
import { questionRepo } from '@/data/repos';
import { TypeBadge, Button } from '@/ui/components';
import { renderMd } from '@/utils/renderMd';
import type { Question, QuestionType } from '@/domain/models';
import { MdContent } from '../components/MdContent';


// ─── Cloze renderer ──────────────────────────────────────────────────────────

/**
 * Renders clozeText replacing {{blankId}} with the accepted answer highlighted.
 */
function renderCloze(clozeText: string, blanks: { id: string; accepted: string[] }[]): string {
  const blanksMap = Object.fromEntries(blanks.map((b) => [b.id, b.accepted[0] ?? b.id]));
  const filled = clozeText.replace(/\{\{([^}]+)\}\}/g, (_match, id) => {
    const answer = blanksMap[id] ?? id;
    return `<span class="inline-block bg-sage-600/20 border border-sage-600/40 text-sage-300 rounded px-1.5 py-0.5 font-medium mx-0.5">${answer}</span>`;
  });
  return renderMd(filled);
}

// ─── Back-of-card content by type ────────────────────────────────────────────

function CardBack({ question }: { question: Question }) {
  if (question.type === 'TEST') {
    const correctIds = new Set(question.correctOptionIds ?? []);
    return (
      <div className="flex flex-col gap-2 w-full">
        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Opciones</p>
        {(question.options ?? []).map((opt) => {
          const correct = correctIds.has(opt.id);
          return (
            <div
              key={opt.id}
              className={`flex items-start gap-2 rounded-xl px-4 py-3 border text-sm transition-colors ${
                correct
                  ? 'bg-sage-600/10 border-sage-600/30 text-sage-300'
                  : 'bg-ink-800/50 border-ink-700 text-ink-500 line-through'
              }`}
            >
              <span className={`mt-0.5 flex-shrink-0 text-xs font-bold ${correct ? 'text-sage-400' : 'text-ink-600'}`}>
                {correct ? '✓' : '✗'}
              </span>
              <span
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMd(opt.text) }}
              />
            </div>
          );
        })}
      </div>
    );
  }

  if (question.type === 'COMPLETAR') {
    return (
      <div className="flex flex-col gap-3 w-full">
        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Texto completo</p>
        <div
          className="text-sm text-ink-200 leading-relaxed prose prose-invert prose-sm max-w-none bg-ink-800/50 border border-ink-700 rounded-xl p-4"
          dangerouslySetInnerHTML={{ __html: renderCloze(question.clozeText ?? '', question.blanks ?? []) }}
        />
        {/* Blanks summary */}
        <div className="flex flex-col gap-1">
          {(question.blanks ?? []).map((b) => (
            <div key={b.id} className="flex items-center gap-2 text-xs">
              <span className="text-ink-500 font-mono">{b.id}:</span>
              <span className="text-sage-300">{b.accepted.join(' / ')}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // DESARROLLO / PRACTICO
  return (
    <div className="flex flex-col gap-3 w-full">
      {question.modelAnswer && (
        <>
          <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Respuesta modelo</p>
          <div
            className="text-sm text-ink-200 leading-relaxed prose prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMd(question.modelAnswer) }}
          />
        </>
      )}
      {question.numericAnswer && (
        <div className="mt-2 bg-blue-500/5 border border-blue-500/20 rounded-xl px-4 py-3">
          <p className="text-xs text-blue-400 uppercase tracking-widest mb-1">Resultado numérico</p>
          <p className="text-lg font-mono text-blue-300">{question.numericAnswer}</p>
        </div>
      )}
      {question.keywords && question.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {question.keywords.map((kw) => (
            <span key={kw} className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-2 py-0.5">
              {kw}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Single Flashcard ─────────────────────────────────────────────────────────

interface FlashcardProps {
  question: Question;
  topicTitle: string;
  flipped: boolean;
  onFlip: () => void;
  currentIndex: number;
  selfEvalDone: Set<number>;
  onSelfEval: (result: 'CORRECT' | 'WRONG') => void;
}

function Flashcard({ question, topicTitle, flipped, onFlip, currentIndex, selfEvalDone, onSelfEval }: FlashcardProps) {
  return (
    <div
      className="w-full max-w-2xl cursor-pointer select-none"
      onClick={onFlip}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onFlip(); } }}
      aria-label={flipped ? 'Ver pregunta' : 'Ver respuesta'}
      // Perspective on the outer container
      style={{ perspective: '1400px' }}
    >
      {/*
       * Grid overlay trick: both faces share the same grid cell (1/1).
       * The taller face drives the card height — no fixed minHeight needed.
       * backfaceVisibility + visibility ensure only the active face is readable.
       */}
      <div
        style={{
          display: 'grid',
          transformStyle: 'preserve-3d',
          transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
          transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* ── Front (Pregunta) ── */}
        <div
          className="rounded-2xl bg-ink-900 border border-ink-700 p-7 flex flex-col gap-5"
          style={{
            gridArea: '1 / 1',
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            // Keep in layout but invisible when flipped so height is always driven by both faces
            visibility: flipped ? 'hidden' : 'visible',
            minHeight: '480px',
          }}
        >
          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap">
            <TypeBadge type={question.type} />
            {topicTitle && (
              <span className="text-xs text-ink-500 bg-ink-800 rounded px-2 py-0.5">{topicTitle}</span>
            )}
            {question.difficulty && (
              <span className="text-xs text-ink-600">{'★'.repeat(question.difficulty)}</span>
            )}
          </div>

          {/* Prompt */}
          <MdContent
            content={question.prompt}
            className="text-ink-100 text-base leading-relaxed prose prose-invert max-w-none"
          />

          {/* Images */}
          {question.imageDataUrls && question.imageDataUrls.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {question.imageDataUrls.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`imagen ${i + 1}`}
                  className="max-h-48 rounded-lg border border-ink-700 object-contain"
                  onClick={(e) => { e.stopPropagation(); window.open(url, '_blank'); }}
                />
              ))}
            </div>
          )}

          {/* TEST options — neutrales en el frente, sin revelar la respuesta */}
          {question.type === 'TEST' && question.options && question.options.length > 0 && (
            <div className="flex flex-col gap-2">
              {question.options.map((opt, i) => (
                <div
                  key={opt.id}
                  className="flex items-start gap-3 rounded-xl px-4 py-3 border border-ink-700 bg-ink-800/50 text-sm text-ink-200"
                >
                  <span className="flex-shrink-0 w-5 h-5 rounded-full border border-ink-600 bg-ink-800 flex items-center justify-center text-xs text-ink-500 font-medium mt-0.5">
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMd(opt.text) }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Hint */}
          <p className="text-xs text-ink-600 text-center pt-3 border-t border-ink-800 mt-auto">
            Pulsa para ver la respuesta · <kbd className="bg-ink-800 rounded px-1">Espacio</kbd>
          </p>
        </div>

        {/* ── Back (Respuesta) ── */}
        <div
          className="rounded-2xl bg-ink-900 border border-sage-600/20 p-7 flex flex-col gap-5"
          style={{
            gridArea: '1 / 1',
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
            visibility: flipped ? 'visible' : 'hidden',
            minHeight: '480px',
          }}
        >
          {/* Label */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-sage-500 uppercase tracking-widest font-medium">Respuesta</span>
          </div>

          {/* Answer content */}
          <div className="flex-1">
            <CardBack question={question} />
          </div>

          {/* Explanation */}
          {question.explanation && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
              <p className="text-xs text-amber-500 uppercase tracking-widest mb-2">Explicación</p>
              <div
                className="text-sm text-ink-300 leading-relaxed prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMd(question.explanation) }}
              />
            </div>
          )}

          {/* Self-evaluation buttons */}
          {!selfEvalDone.has(currentIndex) && (
            <div className="flex gap-3 mt-2">
              <button
                onClick={(e) => { e.stopPropagation(); onSelfEval('WRONG'); }}
                className="flex-1 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 text-sm font-medium transition-colors"
              >
                ✗ No lo sabía
                <span className="text-xs opacity-60 ml-1">[1]</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onSelfEval('CORRECT'); }}
                className="flex-1 py-2.5 rounded-xl border border-sage-500/30 bg-sage-500/10 text-sage-400 hover:bg-sage-500/20 text-sm font-medium transition-colors"
              >
                ✓ Lo sabía
                <span className="text-xs opacity-60 ml-1">[2]</span>
              </button>
            </div>
          )}
          {selfEvalDone.has(currentIndex) && (
            <p className="text-xs text-ink-600 text-center mt-2">✓ Evaluada</p>
          )}

          <p className="text-xs text-ink-600 text-center pt-3 border-t border-ink-800 mt-auto">
            <kbd className="bg-ink-800 rounded px-1">←</kbd> Anterior ·{' '}
            <kbd className="bg-ink-800 rounded px-1">→</kbd> Siguiente
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Progress dots ────────────────────────────────────────────────────────────

function ProgressDots({ total, current, seen }: { total: number; current: number; seen: Set<number> }) {
  // Show at most 20 dots; otherwise show a simple bar
  if (total > 20) {
    const pct = Math.round(((current + 1) / total) * 100);
    return (
      <div className="flex items-center gap-3 text-xs text-ink-500">
        <div className="flex-1 h-1 bg-ink-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-sage-600/60 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span>{current + 1} / {total}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-center">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-200 ${
            i === current
              ? 'w-3 h-3 bg-sage-500'
              : seen.has(i)
              ? 'w-2 h-2 bg-ink-600'
              : 'w-2 h-2 bg-ink-800'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FlashcardPage() {
  const { subjectId } = useParams<{ subjectId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { subjects, topics } = useStore();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [seenSet, setSeenSet] = useState<Set<number>>(new Set([0]));
  const [selfEvalDone, setSelfEvalDone] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [finished, setFinished] = useState(false);

  const subject = subjects.find((s) => s.id === subjectId);

  // ── Load questions ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!subjectId) return;
    (async () => {
      setLoading(true);
      let pool = await questionRepo.getBySubject(subjectId);

      // Apply filters from query params
      const topicId = searchParams.get('topic');
      const typesParam = searchParams.get('types');
      const mode = searchParams.get('mode') ?? 'random';
      const count = parseInt(searchParams.get('count') ?? '20');

      const enabledTypes = typesParam
        ? new Set(typesParam.split(',') as QuestionType[])
        : new Set<QuestionType>(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']);

      pool = pool.filter((q) => enabledTypes.has(q.type));

      if (topicId) {
        pool = pool.filter((q) => q.topicId === topicId || q.topicIds?.includes(topicId));
      }

      if (mode === 'failed') {
        pool = pool.filter((q) => q.stats.lastResult === 'WRONG');
      }

      if (mode === 'smart') {
        const { sortByPriority } = await import('@/domain/spacedRepetition');
        pool = sortByPriority(pool);
      } else {
        // Shuffle
        pool = pool.sort(() => Math.random() - 0.5);
      }

      if (mode !== 'all' && mode !== 'smart') {
        pool = pool.slice(0, count);
      }

      setQuestions(pool);
      setCurrentIndex(0);
      setFlipped(false);
      setSeenSet(new Set([0]));
      setSelfEvalDone(new Set());
      setLoading(false);
    })();
  }, [subjectId, searchParams]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (finished) return;
    setFlipped(false);
    setCurrentIndex((i) => {
      const next = i + 1;
      if (next >= questions.length) {
        setFinished(true);
        return i;
      }
      setSeenSet((prev) => new Set([...prev, next]));
      return next;
    });
  }, [questions.length, finished]);

  const goPrev = useCallback(() => {
    setFlipped(false);
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleFlip = useCallback(() => {
    setFlipped((f) => !f);
  }, []);

  const handleSelfEval = useCallback(async (result: 'CORRECT' | 'WRONG') => {
    const q = questions[currentIndex];
    if (!q) return;
    await questionRepo.updateStats(q.id, result);
    setQuestions((prev) =>
      prev.map((question, i) =>
        i === currentIndex
          ? { ...question, stats: { ...question.stats, lastResult: result, seen: question.stats.seen + 1 } }
          : question
      )
    );
    setSelfEvalDone((prev) => new Set([...prev, currentIndex]));
    goNext();
  }, [questions, currentIndex, goNext]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if typing in an input
      if ((e.target as HTMLElement).matches('input, textarea')) return;

      if (e.key === '1' && flipped && !selfEvalDone.has(currentIndex)) {
        e.preventDefault();
        handleSelfEval('WRONG');
      } else if ((e.key === '2' || e.key === 'Enter') && flipped && !selfEvalDone.has(currentIndex)) {
        e.preventDefault();
        handleSelfEval('CORRECT');
      } else if (e.key === ' ') {
        e.preventDefault();
        handleFlip();
      } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        goPrev();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleFlip, handleSelfEval, goNext, goPrev, flipped, currentIndex, selfEvalDone]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const currentQuestion = questions[currentIndex];
  const topicTitle = currentQuestion
    ? (topics.find((t) => t.id === currentQuestion.topicId)?.title ?? '')
    : '';

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 animate-pulse-soft">Preparando flashcards…</p>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="min-h-screen bg-ink-950 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-4xl">🃏</p>
        <p className="text-ink-300 text-lg font-medium">Sin preguntas</p>
        <p className="text-ink-500 text-sm text-center">
          No hay preguntas disponibles con los filtros seleccionados.
        </p>
        <Button variant="secondary" onClick={() => navigate(`/subject/${subjectId}`)}>
          ← Volver
        </Button>
      </div>
    );
  }

  // ── Finished screen ───────────────────────────────────────────────────────

  if (finished) {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col items-center justify-center gap-6 p-6">
        <div className="text-6xl">🎉</div>
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-2">¡Repaso completado!</h2>
          <p className="text-ink-400">
            Has repasado <span className="text-ink-200 font-medium">{questions.length}</span> tarjetas
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 mt-2">
          <Button
            onClick={() => {
              setQuestions((q) => [...q].sort(() => Math.random() - 0.5));
              setCurrentIndex(0);
              setFlipped(false);
              setSeenSet(new Set([0]));
              setSelfEvalDone(new Set());
              setFinished(false);
            }}
          >
            🔀 Repetir barajado
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/subject/${subjectId}`)}>
            ← Volver a la asignatura
          </Button>
        </div>
      </div>
    );
  }

  // ── Main view ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-ink-800 bg-ink-900/50 flex-shrink-0">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button
            onClick={() => navigate(`/subject/${subjectId}`)}
            className="text-ink-400 hover:text-ink-200 text-sm transition-colors"
          >
            ← {subject?.name ?? 'Volver'}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-500 bg-ink-800 rounded-full px-2.5 py-1">
              🃏 Flashcards
            </span>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-8 gap-6">
        {/* Progress */}
        <div className="w-full max-w-2xl">
          <ProgressDots total={questions.length} current={currentIndex} seen={seenSet} />
        </div>

        {/* Flashcard */}
        <Flashcard
          key={currentIndex}
          question={currentQuestion}
          topicTitle={topicTitle}
          flipped={flipped}
          onFlip={handleFlip}
          currentIndex={currentIndex}
          selfEvalDone={selfEvalDone}
          onSelfEval={handleSelfEval}
        />

        {/* Navigation buttons */}
        <div className="flex items-center gap-4">
          <button
            onClick={goPrev}
            disabled={currentIndex === 0}
            className="w-11 h-11 rounded-full border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-100 hover:border-ink-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-lg"
            title="Anterior (←)"
          >
            ←
          </button>

          <button
            onClick={handleFlip}
            className="px-6 py-2.5 rounded-xl border border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-100 transition-colors text-sm font-medium"
            title="Voltear (Espacio)"
          >
            {flipped ? '🔙 Pregunta' : '👁 Respuesta'}
          </button>

          <button
            onClick={goNext}
            className="w-11 h-11 rounded-full border border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-100 hover:border-ink-500 transition-colors flex items-center justify-center text-lg"
            title="Siguiente (→)"
          >
            →
          </button>
        </div>

        {/* Keyboard hint */}
        <p className="text-xs text-ink-700 text-center">
          <kbd className="bg-ink-900 border border-ink-800 rounded px-1">Espacio</kbd> voltear ·{' '}
          <kbd className="bg-ink-900 border border-ink-800 rounded px-1">← →</kbd> navegar
        </p>
      </main>
    </div>
  );
}