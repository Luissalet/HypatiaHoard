import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sessionRepo, questionRepo } from '@/data/repos';
import { db } from '@/data/db';
import { Button, TypeBadge, Badge, Modal } from '@/ui/components';
import type { PracticeSession, Question, UserAnswer, Topic } from '@/domain/models';
import { QuestionForm } from '@/ui/components/QuestionForm';
import { renderMd } from '@/utils/renderMd';

export function ResultsPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const [session, setSession] = useState<PracticeSession | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selectedQ, setSelectedQ] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<UserAnswer[]>([]);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);

  // Scroll selected question into view so detail panel aligns with it
  useEffect(() => {
    if (!selectedQ) return;
    document.getElementById(`results-q-${selectedQ}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedQ]);

  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const s = await sessionRepo.getById(sessionId);
      if (!s) { navigate('/'); return; }
      // Support multi-subject (global) sessions
      const subjectIds = s.subjectIds ?? [s.subjectId];
      const [qs, ts] = await Promise.all([
        questionRepo.getManyByIds(s.questionIds),
        db.topics.where('subjectId').anyOf(subjectIds).toArray(),
      ]);
      setSession(s);
      setQuestions(qs);
      setTopics(ts);
      setAnswers(s.answers);
      setLoading(false);
    })();
  }, [sessionId]);

  // All hooks MUST be called before any early return (Rules of Hooks)
  const correct = useMemo(() => answers.filter((a) => a.result === 'CORRECT').length, [answers]);
  const wrong = useMemo(() => answers.filter((a) => a.result === 'WRONG').length, [answers]);
  const pending = useMemo(() => answers.filter((a) => a.result === null || a.result === undefined).length, [answers]);
  const total = session?.questionIds.length ?? 0;
  const pct = useMemo(() => total === 0 ? 0 : Math.round((correct / total) * 100), [correct, total]);

  if (loading || !session) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 animate-pulse-soft">Cargando resultados...</p>
      </div>
    );
  }

  const handleRepeatFailed = async () => {
    const failedIds = answers
      .filter((a) => a.result === 'WRONG')
      .map((a) => a.questionId);
    if (failedIds.length === 0) return;
    const newSession = await sessionRepo.create({
      subjectId: session.subjectId,
      mode: 'failed',
      questionIds: failedIds,
    });
    navigate(`/practice/${newSession.id}`);
  };

  const handleRepeatExact = async () => {
    if (!session) return;
    const newSession = await sessionRepo.create({
      subjectId: session.subjectId,
      mode: session.mode,
      questionIds: [...session.questionIds],
    });
    navigate(`/practice/${newSession.id}`);
  };

  const selectedQuestion = questions.find((q) => q.id === selectedQ);
  const selectedAnswer = answers.find((a) => a.questionId === selectedQ);

  const handleEditSave = async (data: Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>) => {
    if (!editingQuestion) return;
    await questionRepo.update(editingQuestion.id, data);
    setQuestions((prev) =>
      prev.map((q) => q.id === editingQuestion.id ? { ...q, ...data } : q)
    );
    setEditingQuestion(null);
  };

  const handleCorrectAnswer = async (result: 'CORRECT' | 'WRONG') => {
    if (!selectedQ || !sessionId) return;
    await sessionRepo.updateAnswer(sessionId, selectedQ, { manualResult: result, result });
    await questionRepo.updateStats(selectedQ, result);
    setAnswers((prev) =>
      prev.map((a) =>
        a.questionId === selectedQ ? { ...a, manualResult: result, result } : a
      )
    );
  };

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      {/* Header */}
      <header className="border-b border-ink-800 bg-ink-900/50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
          <button
            onClick={() => navigate(`/subject/${session.subjectId}`)}
            className="text-ink-400 hover:text-ink-200 text-sm transition-colors flex-shrink-0"
          >
            ← Volver
          </button>
          <span className="text-sm text-ink-500 flex-shrink-0">
            {new Date(session.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Summary */}
        <div className="mb-8">
          <h1 className="font-display text-2xl text-ink-100 mb-6">Resultados</h1>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-ink-800 border border-ink-700 rounded-xl p-4 text-center">
              <p className="text-3xl font-display text-ink-100">{total}</p>
              <p className="text-xs text-ink-500 mt-1">Total</p>
            </div>
            <div className="bg-sage-600/10 border border-sage-600/20 rounded-xl p-4 text-center">
              <p className="text-3xl font-display text-sage-400">{correct}</p>
              <p className="text-xs text-ink-500 mt-1">Correctas</p>
            </div>
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-center">
              <p className="text-3xl font-display text-rose-400">{wrong}</p>
              <p className="text-xs text-ink-500 mt-1">Incorrectas</p>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
              <p className="text-3xl font-display text-amber-400">{pct}%</p>
              <p className="text-xs text-ink-500 mt-1">Acierto</p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
            <div className="h-full flex rounded-full overflow-hidden">
              {correct > 0 && (
                <div className="bg-sage-500 transition-all" style={{ width: `${(correct / total) * 100}%` }} />
              )}
              {wrong > 0 && (
                <div className="bg-rose-500 transition-all" style={{ width: `${(wrong / total) * 100}%` }} />
              )}
              {pending > 0 && (
                <div className="bg-amber-500 transition-all" style={{ width: `${(pending / total) * 100}%` }} />
              )}
            </div>
          </div>
          {pending > 0 && (
            <p className="text-xs text-ink-500 mt-1">{pending} pregunta{pending !== 1 ? 's' : ''} de desarrollo/práctico pendiente{pending !== 1 ? 's' : ''} de corrección manual</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 mb-8">
          {wrong > 0 && (
            <Button onClick={handleRepeatFailed}>
              🔴 Repetir falladas ({wrong})
            </Button>
          )}
          <Button variant="secondary" onClick={handleRepeatExact}>
            🔄 Repetir sesión
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/subject/${session.subjectId}`)}>
            Nueva sesión
          </Button>
        </div>

        {/* Question list */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-ink-400 uppercase tracking-widest mb-2">Preguntas</h2>
            {session.questionIds.map((qId, i) => {
              const q = questions.find((q) => q.id === qId);
              const a = answers.find((a) => a.questionId === qId);
              if (!q) return null;
              const result = a?.result;
              return (
                <button
                  id={`results-q-${qId}`}
                  key={qId}
                  onClick={() => setSelectedQ(selectedQ === qId ? null : qId)}
                  className={`text-left flex items-start gap-3 p-3 rounded-xl border transition-all ${
                    selectedQ === qId
                      ? 'border-amber-500/50 bg-amber-500/5'
                      : 'border-ink-700 hover:border-ink-600 bg-ink-800/50'
                  }`}
                >
                  <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mt-0.5 ${
                    result === 'CORRECT' ? 'bg-sage-600/20 text-sage-400' :
                    result === 'WRONG' ? 'bg-rose-500/20 text-rose-400' :
                    'bg-amber-500/20 text-amber-400'
                  }`}>
                    {result === 'CORRECT' ? '✓' : result === 'WRONG' ? '✗' : '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <TypeBadge type={q.type} />
                    </div>
                    <p className="text-sm text-ink-300 line-clamp-2 text-left">{q.prompt}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail panel */}
          {selectedQuestion && selectedAnswer && (
            <div className="lg:sticky lg:top-20 lg:self-start flex flex-col gap-4 animate-slide-up">
              <h2 className="text-xs font-medium text-ink-400 uppercase tracking-widest">Detalle</h2>
              <div className={`border rounded-xl p-4 ${
                selectedAnswer.result === 'CORRECT' ? 'border-sage-600/30 bg-sage-600/5' :
                selectedAnswer.result === 'WRONG' ? 'border-rose-500/30 bg-rose-500/5' :
                'border-amber-500/30 bg-amber-500/5'
              }`}>
                {/* Prompt de la pregunta seleccionada */}
              <p className="text-ink-100 text-sm leading-relaxed">{selectedQuestion.prompt}</p>

              {/* Imágenes */}
              {selectedQuestion.imageDataUrls && selectedQuestion.imageDataUrls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {selectedQuestion.imageDataUrls.map((url, idx) => (
                    <img
                      key={idx}
                      src={url}
                      alt={`imagen ${idx + 1}`}
                      className="max-h-48 rounded-lg border border-ink-700 object-contain cursor-pointer"
                      onClick={() => window.open(url, '_blank')}
                    />
                  ))}
                </div>
              )}
                <div className="flex flex-col gap-3">
                  {/* TEST: unified options list showing selected + correct */}
                  {selectedQuestion.type === 'TEST' && selectedQuestion.options && selectedQuestion.options.length > 0 ? (
                    <div>
                      <p className="text-xs text-ink-500 uppercase tracking-widest mb-2">Opciones</p>
                      <div className="flex flex-col gap-1.5">
                        {selectedQuestion.options.map((opt, i) => {
                          const isCorrectOpt = (selectedQuestion.correctOptionIds ?? []).includes(opt.id);
                          const isSelected = (selectedAnswer.selectedOptionIds ?? []).includes(opt.id);
                          return (
                            <div
                              key={opt.id}
                              className={`flex items-start gap-2 rounded-xl px-3 py-2 border text-sm ${
                                isCorrectOpt && isSelected
                                  ? 'bg-sage-600/15 border-sage-500/40 text-sage-200'
                                  : isCorrectOpt
                                  ? 'bg-sage-600/10 border-sage-500/30 text-sage-300'
                                  : isSelected
                                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                                  : 'bg-ink-800/50 border-ink-700 text-ink-500'
                              }`}
                            >
                              <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                                isCorrectOpt ? 'bg-sage-600/30 text-sage-300' :
                                isSelected ? 'bg-rose-500/30 text-rose-300' :
                                'bg-ink-800 border border-ink-600 text-ink-500'
                              }`}>
                                {isCorrectOpt ? '✓' : isSelected ? '✗' : String.fromCharCode(65 + i)}
                              </span>
                              <span
                                className="prose prose-invert prose-sm max-w-none flex-1"
                                dangerouslySetInnerHTML={{ __html: renderMd(opt.text) }}
                              />
                              {isSelected && !isCorrectOpt && (
                                <span className="text-xs text-rose-400 flex-shrink-0 mt-0.5">tu respuesta</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Tu respuesta</p>
                        <UserAnswerSummary question={selectedQuestion} answer={selectedAnswer} />
                      </div>
                      <div>
                        <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Respuesta correcta</p>
                        <CorrectAnswerSummary question={selectedQuestion} />
                      </div>
                    </>
                  )}

                  {/* Display modelAnswer and keywords for DESARROLLO/PRACTICO before correction */}
                  {(selectedQuestion.type === 'DESARROLLO' || selectedQuestion.type === 'PRACTICO') && selectedAnswer.result === null && (
                    <>
                      {selectedQuestion.modelAnswer && (
                        <div className="mt-3 pt-3 border-t border-amber-500/30">
                          <p className="text-xs text-amber-600 uppercase tracking-widest mb-1">Respuesta modelo</p>
                          <p className="text-sm text-ink-300 whitespace-pre-wrap">{selectedQuestion.modelAnswer}</p>
                        </div>
                      )}
                      {selectedQuestion.keywords && selectedQuestion.keywords.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <p className="text-xs text-amber-600 uppercase tracking-widest w-full">Keywords</p>
                          {selectedQuestion.keywords.map((kw) => (
                            <span key={kw} className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-2 py-0.5">
                              {kw}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Manual correction buttons for DESARROLLO/PRACTICO */}
                  {selectedAnswer.result === null && (selectedQuestion.type === 'DESARROLLO' || selectedQuestion.type === 'PRACTICO') && (
                    <div className="mt-4 pt-3 border-t border-amber-500/30 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleCorrectAnswer('CORRECT')}
                        className="flex-1 bg-sage-600 hover:bg-sage-700 text-white"
                      >
                        ✓ Correcto
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleCorrectAnswer('WRONG')}
                        className="flex-1 bg-rose-500 hover:bg-rose-600 text-white"
                      >
                        ✗ Incorrecto
                      </Button>
                    </div>
                  )}

                  {selectedQuestion.explanation && (
                    <div className="mt-2 pt-3 border-t border-ink-700">
                      <p className="text-xs text-amber-600 uppercase tracking-widest mb-1">Explicación</p>
                      <p className="text-sm text-ink-300">{selectedQuestion.explanation}</p>
                    </div>
                  )}

                  {/* A4: Notas personales */}
                  {selectedQuestion.notes && (
                    <div className="mt-3 pt-3 border-t border-ink-700">
                      <p className="text-xs text-ink-500 uppercase tracking-widest mb-1">Mis notas</p>
                      <p className="text-sm text-ink-300 whitespace-pre-wrap">{selectedQuestion.notes}</p>
                    </div>
                  )}

                  {/* Botón editar */}
                  <div className="mt-3 pt-3 border-t border-ink-800">
                    <button
                      onClick={() => setEditingQuestion(selectedQuestion)}
                      className="text-xs text-ink-600 hover:text-amber-400 transition-colors flex items-center gap-1"
                    >
                      ✎ Editar esta pregunta
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Modal edición de pregunta */}
      {editingQuestion && session && (
        <Modal open onClose={() => setEditingQuestion(null)} title="Editar pregunta">
          <QuestionForm
            subjectId={session.subjectId}
            topics={topics}
            initial={editingQuestion}
            onSave={handleEditSave}
            onCancel={() => setEditingQuestion(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function UserAnswerSummary({ question, answer }: { question: Question; answer: import('@/domain/models').UserAnswer }) {
  if (question.type === 'TEST') {
    const selected = answer.selectedOptionIds ?? [];
    if (!selected.length) return <p className="text-sm text-ink-600 italic">Sin respuesta</p>;
    const texts = (question.options ?? []).filter((o) => selected.includes(o.id)).map((o) => o.text);
    return <p className="text-sm text-ink-200">{texts.join(', ')}</p>;
  }
  if (question.type === 'COMPLETAR') {
    const entries = Object.entries(answer.blankAnswers ?? {});
    if (!entries.length) return <p className="text-sm text-ink-600 italic">Sin respuesta</p>;
    return (
      <div>
        {entries.map(([id, val]) => (
          <p key={id} className="text-sm text-ink-200"><span className="text-ink-500">{id}:</span> {val}</p>
        ))}
      </div>
    );
  }
  return <p className="text-sm text-ink-200 whitespace-pre-wrap">{answer.freeText || <span className="italic text-ink-600">Sin respuesta</span>}</p>;
}

function CorrectAnswerSummary({ question }: { question: Question }) {
  if (question.type === 'TEST') {
    const correctIds = new Set(question.correctOptionIds ?? []);
    const texts = (question.options ?? []).filter((o) => correctIds.has(o.id)).map((o) => o.text);
    return <p className="text-sm text-sage-400">{texts.join(', ')}</p>;
  }
  if (question.type === 'COMPLETAR') {
    return (
      <div>
        {(question.blanks ?? []).map((b) => (
          <p key={b.id} className="text-sm text-sage-400"><span className="text-ink-500">{b.id}:</span> {b.accepted.join(' / ')}</p>
        ))}
      </div>
    );
  }
  return <p className="text-sm text-sage-400 whitespace-pre-wrap">{question.modelAnswer}</p>;
}
