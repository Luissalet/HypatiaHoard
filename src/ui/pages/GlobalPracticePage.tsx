/**
 * GlobalPracticePage.tsx
 *
 * Página de configuración para práctica mixta cross-asignatura.
 * Permite seleccionar asignaturas, temas, tipos de pregunta y modo de sesión.
 */

import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/data/db';
import { sessionRepo } from '@/data/repos';
import { Button, Card, Input, Select, EmptyState } from '@/ui/components';
import { questionBelongsToTopic } from '@/utils/questionUtils';
import type { Subject, Topic, Question, QuestionType } from '@/domain/models';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_TYPES: { type: QuestionType; label: string }[] = [
  { type: 'TEST', label: 'Test' },
  { type: 'DESARROLLO', label: 'Desarrollo' },
  { type: 'COMPLETAR', label: 'Completar' },
  { type: 'PRACTICO', label: 'Práctico' },
];

type GlobalMode = 'random' | 'all' | 'failed' | 'smart';

// ─── Component ────────────────────────────────────────────────────────────────

export function GlobalPracticePage() {
  const navigate = useNavigate();

  // ── Data loading ──────────────────────────────────────────────────────────
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topicsBySubject, setTopicsBySubject] = useState<Record<string, Topic[]>>({});
  const [questionsBySubject, setQuestionsBySubject] = useState<Record<string, Question[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [subs, allTopics, allQuestions] = await Promise.all([
        db.subjects.toArray(),
        db.topics.toArray(),
        db.questions.toArray(),
      ]);
      setSubjects(subs);

      const tByS: Record<string, Topic[]> = {};
      for (const t of allTopics) {
        (tByS[t.subjectId] ??= []).push(t);
      }
      // Sort topics by order within each subject
      for (const key of Object.keys(tByS)) {
        tByS[key].sort((a, b) => a.order - b.order);
      }
      setTopicsBySubject(tByS);

      const qByS: Record<string, Question[]> = {};
      for (const q of allQuestions) {
        (qByS[q.subjectId] ??= []).push(q);
      }
      setQuestionsBySubject(qByS);
      setLoading(false);
    })();
  }, []);

  // ── Selection state ───────────────────────────────────────────────────────
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<Set<string>>(new Set());
  const [selectedTopicIds, setSelectedTopicIds] = useState<Set<string>>(new Set());
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());
  const [enabledTypes, setEnabledTypes] = useState<Set<QuestionType>>(new Set(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']));
  const [mode, setMode] = useState<GlobalMode>('random');
  const [count, setCount] = useState('30');
  const [onlyUnseen, setOnlyUnseen] = useState(false);
  const [selectedDifficulties, setSelectedDifficulties] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));

  // Auto-select all subjects on first load
  useEffect(() => {
    if (subjects.length > 0 && selectedSubjectIds.size === 0) {
      setSelectedSubjectIds(new Set(subjects.map((s) => s.id)));
    }
  }, [subjects]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const toggleSubject = (id: string) => {
    setSelectedSubjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Also deselect all topics of this subject
        const subTopics = topicsBySubject[id] ?? [];
        setSelectedTopicIds((tp) => {
          const n = new Set(tp);
          for (const t of subTopics) n.delete(t.id);
          return n;
        });
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllSubjects = () => {
    if (selectedSubjectIds.size === subjects.length) {
      setSelectedSubjectIds(new Set());
      setSelectedTopicIds(new Set());
    } else {
      setSelectedSubjectIds(new Set(subjects.map((s) => s.id)));
    }
  };

  const toggleExpandSubject = (id: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTopic = (topicId: string) => {
    setSelectedTopicIds((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  const toggleType = (t: QuestionType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        if (next.size > 1) next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  };

  // Pool of questions matching all filters
  const filteredPool = useMemo(() => {
    let pool: Question[] = [];
    for (const subId of selectedSubjectIds) {
      const subQuestions = questionsBySubject[subId] ?? [];
      pool.push(...subQuestions);
    }

    // Filter by type
    pool = pool.filter((q) => enabledTypes.has(q.type));

    // Filter by topic selection (if any topics are selected, only include those)
    if (selectedTopicIds.size > 0) {
      pool = pool.filter((q) => {
        for (const tid of selectedTopicIds) {
          if (questionBelongsToTopic(q, tid)) return true;
        }
        return false;
      });
    }

    // Additional filters
    if (onlyUnseen) {
      pool = pool.filter((q) => q.stats.seen === 0);
    }
    if (selectedDifficulties.size < 5) {
      pool = pool.filter((q) => !q.difficulty || selectedDifficulties.has(q.difficulty));
    }

    return pool;
  }, [selectedSubjectIds, questionsBySubject, enabledTypes, selectedTopicIds, onlyUnseen, selectedDifficulties]);

  // Mode-specific counts
  const availableCount = useMemo(() => {
    if (mode === 'failed') return filteredPool.filter((q) => q.stats.lastResult === 'WRONG').length;
    if (mode === 'smart') {
      const today = new Date().toISOString().split('T')[0];
      const due = filteredPool.filter((q) => !q.stats.nextReviewAt || q.stats.nextReviewAt <= today).length;
      return due > 0 ? due : filteredPool.length; // fallback to all if none due
    }
    return filteredPool.length;
  }, [filteredPool, mode]);

  const failedCount = useMemo(() => filteredPool.filter((q) => q.stats.lastResult === 'WRONG').length, [filteredPool]);
  const smartCount = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return filteredPool.filter((q) => !q.stats.nextReviewAt || q.stats.nextReviewAt <= today).length;
  }, [filteredPool]);

  // Count by type across selected subjects
  const countByType = (type: QuestionType) => {
    let c = 0;
    for (const subId of selectedSubjectIds) {
      c += (questionsBySubject[subId] ?? []).filter((q) => q.type === type).length;
    }
    return c;
  };

  // ── Start session ─────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (availableCount === 0) return;

    let pool = [...filteredPool];

    if (mode === 'all') {
      // Use all filtered questions as-is
    } else if (mode === 'failed') {
      pool = pool.filter((q) => q.stats.lastResult === 'WRONG');
    } else if (mode === 'smart') {
      const { sortByPriority } = await import('@/domain/spacedRepetition');
      const today = new Date().toISOString().split('T')[0];
      let due = pool.filter((q) => !q.stats.nextReviewAt || q.stats.nextReviewAt <= today);
      due = sortByPriority(due);
      if (due.length === 0) {
        pool = sortByPriority(pool).slice(0, 20);
      } else {
        pool = due;
      }
    } else {
      // random
      const n = Math.min(parseInt(count) || 30, pool.length);
      pool = [...pool].sort(() => Math.random() - 0.5).slice(0, n);
    }

    // Shuffle
    pool = pool.sort(() => Math.random() - 0.5);

    const subjectIdsArr = [...selectedSubjectIds];
    const session = await sessionRepo.create({
      subjectId: subjectIdsArr[0], // backward compat
      subjectIds: subjectIdsArr,
      mode: mode as any,
      questionIds: pool.map((q) => q.id),
    });

    navigate(`/practice/${session.id}`);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-400 text-sm animate-pulse">Cargando…</p>
      </div>
    );
  }

  if (subjects.length < 2) {
    return (
      <div className="min-h-screen bg-ink-950">
        <Header onBack={() => navigate('/')} />
        <div className="max-w-3xl mx-auto p-6">
          <EmptyState
            icon={<span className="text-3xl">📚</span>}
            title="Necesitas al menos 2 asignaturas"
            description="Crea más asignaturas desde el Dashboard para usar la práctica mixta."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 flex flex-col">
      <Header onBack={() => navigate('/')} />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

          {/* ── Subject selection ──────────────────────────────────────────── */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-ink-200">Asignaturas</h3>
              <button
                onClick={toggleAllSubjects}
                className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
              >
                {selectedSubjectIds.size === subjects.length ? 'Deseleccionar todas' : 'Seleccionar todas'}
              </button>
            </div>

            <div className="space-y-2">
              {subjects.map((s) => {
                const active = selectedSubjectIds.has(s.id);
                const topics = topicsBySubject[s.id] ?? [];
                const qCount = (questionsBySubject[s.id] ?? []).length;
                const expanded = expandedSubjects.has(s.id);

                return (
                  <div key={s.id}>
                    <div className="flex items-center gap-2">
                      <label
                        className={`flex-1 flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm cursor-pointer transition-all ${
                          active
                            ? 'bg-amber-500/10 border-amber-500/30 text-ink-100'
                            : 'bg-ink-800 border-ink-700 text-ink-500'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => toggleSubject(s.id)}
                          className="accent-amber-500 w-4 h-4"
                        />
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: s.color ?? '#f59e0b' }}
                        />
                        <span className="flex-1 truncate">{s.name}</span>
                        <span className="text-xs text-ink-500">{qCount} preg.</span>
                      </label>

                      {active && topics.length > 0 && (
                        <button
                          onClick={() => toggleExpandSubject(s.id)}
                          className="p-2 text-ink-500 hover:text-ink-300 transition-colors"
                          title="Seleccionar temas"
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
                          >
                            <polygon points="6,3 12,8 6,13" />
                          </svg>
                        </button>
                      )}
                    </div>

                    {/* Topic selection (expandable) */}
                    {active && expanded && topics.length > 0 && (
                      <div className="ml-8 mt-1 mb-2 space-y-1">
                        {topics.map((t) => {
                          const topicActive = selectedTopicIds.has(t.id);
                          const tqCount = (questionsBySubject[s.id] ?? []).filter((q) => questionBelongsToTopic(q, t.id)).length;

                          return (
                            <label
                              key={t.id}
                              className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer transition-all ${
                                topicActive
                                  ? 'bg-amber-500/10 border-amber-500/20 text-ink-200'
                                  : 'bg-ink-900 border-ink-700 text-ink-400 hover:border-ink-600'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={topicActive}
                                onChange={() => toggleTopic(t.id)}
                                className="accent-amber-500 w-3 h-3"
                              />
                              <span className="flex-1 truncate">{t.title}</span>
                              <span className="text-ink-600">({tqCount})</span>
                            </label>
                          );
                        })}
                        <p className="text-[10px] text-ink-600 mt-1 ml-1">
                          {selectedTopicIds.size === 0
                            ? 'Sin filtro de tema (todas las preguntas de la asignatura)'
                            : `${[...selectedTopicIds].filter((id) => topics.some((t) => t.id === id)).length} tema(s) seleccionado(s)`}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── Question type filter ──────────────────────────────────────── */}
          <Card>
            <h3 className="font-display text-ink-200 mb-3">Tipos de pregunta</h3>
            <div className="flex flex-wrap gap-2">
              {ALL_TYPES.map(({ type, label }) => {
                const c = countByType(type);
                const active = enabledTypes.has(type);
                return (
                  <label
                    key={type}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-all ${
                      active
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                        : 'bg-ink-800 border-ink-700 text-ink-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleType(type)}
                      className="accent-amber-500 w-3.5 h-3.5"
                    />
                    {label} <span className="text-xs opacity-60">({c})</span>
                  </label>
                );
              })}
            </div>
          </Card>

          {/* ── Mode & filters ───────────────────────────────────────────── */}
          <Card>
            <div className="flex flex-col gap-4">
              <Select label="Modo" value={mode} onChange={(e) => setMode(e.target.value as GlobalMode)}>
                <option value="random">Aleatorio</option>
                <option value="all">Todas las preguntas</option>
                <option value="failed">Sólo falladas ({failedCount})</option>
                <option value="smart">Repaso inteligente ({smartCount} pendientes)</option>
              </Select>

              {mode === 'random' && (
                <Input
                  label="Número de preguntas"
                  type="number"
                  min="1"
                  max={filteredPool.length}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              )}

              {/* Additional filters */}
              <div className="border-t border-ink-700 pt-3">
                <p className="text-xs font-medium text-ink-400 uppercase tracking-widest mb-2">Filtros adicionales</p>

                <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-ink-700 text-sm cursor-pointer hover:border-ink-600 transition-all mb-2">
                  <input
                    type="checkbox"
                    checked={onlyUnseen}
                    onChange={(e) => setOnlyUnseen(e.target.checked)}
                    className="accent-amber-500 w-3.5 h-3.5"
                  />
                  <span className="text-ink-300">Solo no vistas ({filteredPool.filter((q) => q.stats.seen === 0).length})</span>
                </label>

                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5].map((difficulty) => {
                    const isSelected = selectedDifficulties.has(difficulty);
                    return (
                      <button
                        key={difficulty}
                        onClick={() => {
                          setSelectedDifficulties((prev) => {
                            const next = new Set(prev);
                            if (next.has(difficulty)) {
                              if (next.size > 1) next.delete(difficulty);
                            } else {
                              next.add(difficulty);
                            }
                            return next;
                          });
                        }}
                        className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                          isSelected
                            ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300'
                            : 'bg-ink-800 border border-ink-700 text-ink-500'
                        }`}
                      >
                        {'★'.repeat(difficulty)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>

          {/* ── Start button ──────────────────────────────────────────────── */}
          <div className="pb-8">
            <Button
              size="lg"
              className="w-full"
              onClick={handleStart}
              disabled={availableCount === 0 || selectedSubjectIds.size === 0}
            >
              Empezar práctica mixta ({availableCount} preguntas)
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <header className="sticky top-0 z-20 bg-ink-950/95 backdrop-blur border-b border-ink-800 px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-ink-400 hover:text-ink-200 transition-colors"
          title="Volver"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 4L7 10L13 16" />
          </svg>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">🔀</span>
          <h1 className="font-display text-ink-100 text-lg truncate">
            Práctica mixta
          </h1>
        </div>
      </div>
    </header>
  );
}
