import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db } from '@/data/db';
import { subjectRepo, questionRepo } from '@/data/repos';
import { Button, TypeBadge, Difficulty } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { renderMd } from '@/utils/renderMd';
import type { Subject, Topic, Question } from '@/domain/models';

export function ReadModePage() {
  const { subjectId, topicId } = useParams<{ subjectId: string; topicId: string }>();
  const navigate = useNavigate();

  const [subject, setSubject] = useState<Subject | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  useEffect(() => {
    if (!subjectId || !topicId) return;
    (async () => {
      const s = await subjectRepo.getById(subjectId);
      const t = await db.topics.get(topicId);
      if (!s || !t) { navigate('/'); return; }
      const qs = await questionRepo.getBySubject(subjectId);
      const topicQs = qs.filter(
        (q) => q.topicId === topicId || (q.topicIds ?? []).includes(topicId)
      );
      setSubject(s);
      setTopic(t);
      setQuestions(topicQs);
      setLoading(false);
    })();
  }, [subjectId, topicId]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input, textarea')) return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setFocusIdx((prev) => Math.min(prev + 1, questions.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setFocusIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setExpandedIdx((prev) => (prev === focusIdx ? null : focusIdx));
      } else if (e.key === 'Escape') {
        setExpandedIdx(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusIdx, questions.length]);

  // Scroll focused item into view
  useEffect(() => {
    document.getElementById(`read-q-${focusIdx}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusIdx]);

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 animate-pulse">Cargando...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-ink-800 bg-ink-900/50 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate(`/subject/${subjectId}`)}
              className="text-ink-500 hover:text-ink-300 text-sm transition-colors"
            >
              ← Volver
            </button>
            <span className="text-sm text-ink-400">
              {questions.length} pregunta{questions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <h1 className="font-display text-lg text-ink-100 mt-1">
            📖 Lectura — {topic?.title}
          </h1>
          <div className="flex gap-3 mt-1 text-[10px] text-ink-600">
            <span>↑↓ navegar</span>
            <span>⏎ expandir/colapsar</span>
            <span>Esc cerrar</span>
          </div>
        </div>
      </header>

      {/* Questions list */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-4 sm:py-6">
        {questions.length === 0 ? (
          <div className="text-center text-ink-500 py-12">
            No hay preguntas en este tema.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {questions.map((q, idx) => {
              const isFocused = focusIdx === idx;
              const isExpanded = expandedIdx === idx;
              return (
                <div
                  key={q.id}
                  id={`read-q-${idx}`}
                  onClick={() => {
                    setFocusIdx(idx);
                    setExpandedIdx(isExpanded ? null : idx);
                  }}
                  className={`cursor-pointer rounded-xl border p-4 transition-all ${
                    isFocused
                      ? 'border-amber-500/50 bg-ink-800/80 ring-1 ring-amber-500/20'
                      : 'border-ink-700 bg-ink-800/40 hover:border-ink-600'
                  }`}
                >
                  {/* Question header */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs text-ink-600">{idx + 1}.</span>
                    <TypeBadge type={q.type} />
                    {q.difficulty && <Difficulty level={q.difficulty} />}
                    {(q.tags ?? []).slice(0, 2).map((tag) => (
                      <span key={tag} className="text-xs bg-ink-800 text-ink-400 px-2 py-0.5 rounded">{tag}</span>
                    ))}
                    <span className="ml-auto text-xs text-ink-600">{isExpanded ? '▼' : '▶'}</span>
                  </div>

                  {/* Prompt — always visible */}
                  <MdContent
                    content={q.prompt}
                    className="text-sm text-ink-200 leading-relaxed prose prose-invert prose-sm max-w-none"
                  />

                  {/* Expanded: Answer */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-ink-700 flex flex-col gap-3 animate-fade-in">
                      {/* For TEST: show options with correct highlighted */}
                      {q.type === 'TEST' && (q.options ?? []).length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {(q.options ?? []).map((opt) => {
                            const isCorrect = (q.correctOptionIds ?? []).includes(opt.id);
                            return (
                              <div
                                key={opt.id}
                                className={`text-sm px-3 py-2 rounded-lg border ${
                                  isCorrect
                                    ? 'bg-sage-600/10 border-sage-600/30 text-sage-400'
                                    : 'bg-ink-800/50 border-ink-700 text-ink-400'
                                }`}
                              >
                                {isCorrect && <span className="mr-2">✓</span>}
                                {opt.text}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* For COMPLETAR: show cloze with answers */}
                      {q.type === 'COMPLETAR' && (q.blanks ?? []).length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {(q.blanks ?? []).map((b) => (
                            <p key={b.id} className="text-sm text-sage-400">
                              <span className="text-ink-500">{b.id}: </span>
                              {b.accepted.join(' / ')}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* For DESARROLLO/PRACTICO: model answer */}
                      {(q.type === 'DESARROLLO' || q.type === 'PRACTICO') && q.modelAnswer && (
                        <div className="bg-sage-600/5 border border-sage-600/20 rounded-lg p-3">
                          <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Respuesta modelo</p>
                          <div
                            className="text-sm text-sage-400 prose prose-invert prose-sm max-w-none"
                            dangerouslySetInnerHTML={{ __html: renderMd(q.modelAnswer) }}
                          />
                        </div>
                      )}

                      {/* Explanation */}
                      {q.explanation && (
                        <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                          <p className="text-xs text-amber-600 uppercase tracking-widest mb-1">Explicación</p>
                          <MdContent
                            content={q.explanation}
                            className="text-sm text-ink-300 leading-relaxed prose prose-invert prose-sm max-w-none"
                          />
                        </div>
                      )}

                      {/* Notes */}
                      {q.notes && (
                        <p className="text-xs text-ink-500 italic">📝 {q.notes}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
