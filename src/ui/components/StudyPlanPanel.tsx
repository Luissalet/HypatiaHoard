/**
 * StudyPlanPanel.tsx
 *
 * "Plan" tab of a subject (local Hoard app): every day until the exam with its reviews,
 * new cards, timed mock exams and final review, computed by the server from the bank and
 * the review schedule. Buttons start today's session or a timed mock weighted to the
 * weak topics; the settings are saved per subject (the family agenda shows the days).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Input } from '@/ui/components';
import { HoardError } from '@/data/hoardClient';
import { clearStudyPlan, getStudyPlan, mockExamIds, type PlanDay, type StudyPlan } from '@/data/planClient';
import { localIdsFor, serverIdFor } from '@/data/hoardSync';
import { db } from '@/data/db';

const WEEK = [
  { id: 0, short: 'L', name: 'lunes' },
  { id: 1, short: 'M', name: 'martes' },
  { id: 2, short: 'X', name: 'miércoles' },
  { id: 3, short: 'J', name: 'jueves' },
  { id: 4, short: 'V', name: 'viernes' },
  { id: 5, short: 'S', name: 'sábado' },
  { id: 6, short: 'D', name: 'domingo' },
];

const KIND_LABEL: Record<PlanDay['kind'], string> = {
  study: 'Estudio',
  mock: 'Simulacro',
  final: 'Repaso final',
  rest: 'Descanso',
  exam: 'Examen',
};

const KIND_COLOR: Record<PlanDay['kind'], 'amber' | 'sage' | 'rose' | 'ink' | 'blue'> = {
  study: 'sage',
  mock: 'blue',
  final: 'amber',
  rest: 'ink',
  exam: 'rose',
};

interface Props {
  subjectId: string;
  /** The subject's exam date known to this device, if any (fills the form). */
  examDate?: string;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

export function StudyPlanPanel({ subjectId, examDate }: Props) {
  const navigate = useNavigate();
  const serverSubjectId = serverIdFor('subject', subjectId);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'today' | 'mock' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(examDate ?? '');
  const [minutes, setMinutes] = useState('60');
  const [rest, setRest] = useState<number[]>([]);
  const [mockN, setMockN] = useState('20');
  const [mockMin, setMockMin] = useState('30');
  const [showAll, setShowAll] = useState(false);

  const fill = useCallback((p: StudyPlan) => {
    setPlan(p);
    setDate(p.settings.examDate);
    setMinutes(String(p.settings.minutesPerDay));
    setRest(p.settings.restDays);
    setMockN(String(p.settings.mockQuestions));
    setMockMin(String(p.settings.mockMinutes));
  }, []);

  // First look: the saved plan, else the exam date the server or this device knows (preview, not saved).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStudyPlan({ subject: serverSubjectId })
      .catch((e) => {
        if (examDate && e instanceof HoardError && e.status === 400) {
          return getStudyPlan({ subject: serverSubjectId, exam_date: examDate });
        }
        throw e;
      })
      .then((p) => { if (!cancelled) fill(p); })
      .catch((e) => {
        if (cancelled) return;
        setPlan(null);
        const msg = e instanceof Error ? e.message : String(e);
        if (!/fecha del examen/i.test(msg)) setError(msg);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverSubjectId, examDate, fill]);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      fill(await getStudyPlan({
        subject: serverSubjectId,
        exam_date: date || undefined,
        minutes_per_day: Number(minutes) || 60,
        rest_days: rest,
        mock_questions: Number(mockN) || 20,
        mock_minutes: Number(mockMin) || undefined,
        save: true,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    if (!confirm('¿Olvidar el plan de esta asignatura? Tus tarjetas y tu progreso no cambian.')) return;
    setBusy('clear');
    try {
      await clearStudyPlan(serverSubjectId);
      setPlan((p) => (p ? { ...p, saved: false } : p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Local ids of server question ids that exist in this browser. */
  const toLocal = async (serverIds: string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const sid of serverIds) {
      for (const id of localIdsFor('question', sid)) {
        if (await db.questions.get(id)) { out.push(id); break; }
      }
    }
    return out;
  };

  const startToday = async () => {
    if (!plan) return;
    setBusy('today');
    setError(null);
    try {
      const ids = await toLocal(plan.todayPlan.questionIds);
      if (ids.length === 0) {
        setError('Hoy no hay tarjetas que repasar ni nuevas: el plan está al día.');
        return;
      }
      const { sessionRepo } = await import('@/data/repos');
      const session = await sessionRepo.create({ subjectId, mode: 'smart', questionIds: ids });
      navigate(`/practice/${session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startMock = async () => {
    if (!plan) return;
    setBusy('mock');
    setError(null);
    try {
      const ids = await toLocal(await mockExamIds(serverSubjectId, plan.settings.mockQuestions));
      if (ids.length === 0) {
        setError('No hay preguntas para el simulacro.');
        return;
      }
      const { sessionRepo } = await import('@/data/repos');
      const session = await sessionRepo.create({ subjectId, mode: 'exam', questionIds: ids });
      navigate(`/practice/${session.id}?examMode=true&duration=${plan.settings.mockMinutes}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const today = plan?.days.find((d) => d.date === plan.today) ?? null;
  const visibleDays = useMemo(() => {
    if (!plan) return [];
    const rest = plan.days.filter((d) => d.date !== plan.today);
    return showAll ? rest : rest.slice(0, 14);
  }, [plan, showAll]);

  return (
    <div className="flex flex-col gap-5" data-testid="study-plan">
      {/* Settings */}
      <section className="bg-ink-800 border border-ink-700 rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="font-display text-lg text-ink-100">Plan de estudio</h2>
            <p className="text-xs text-ink-400 mt-0.5">
              Cada día hasta el examen: repasos que tocan, tarjetas nuevas, simulacros cronometrados y repaso final.
              Se recalcula con lo que vas estudiando.
            </p>
          </div>
          {plan?.saved && (
            <Button size="sm" variant="ghost" onClick={() => void forget()} loading={busy === 'clear'}>Olvidar plan</Button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Input label="Fecha del examen" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Minutos al día" type="number" min={10} max={600} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <Input label="Preguntas por simulacro" type="number" min={5} max={100} value={mockN} onChange={(e) => setMockN(e.target.value)} />
          <Input label="Minutos por simulacro" type="number" min={5} max={300} value={mockMin} onChange={(e) => setMockMin(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Días de descanso</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEK.map((w) => {
              const on = rest.includes(w.id);
              return (
                <button
                  key={w.id}
                  type="button"
                  aria-pressed={on}
                  title={on ? `El ${w.name} no se estudia` : `Descansar el ${w.name}`}
                  onClick={() => setRest((r) => (on ? r.filter((x) => x !== w.id) : [...r, w.id].sort()))}
                  className={`w-9 h-9 rounded-lg text-sm font-medium border transition-all ${
                    on ? 'bg-ink-600 text-ink-100 border-ink-500' : 'bg-ink-900 text-ink-400 border-ink-600 hover:border-amber-500/60'
                  }`}
                >
                  {w.short}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void save()} loading={busy === 'save'} disabled={!date}>
            {plan?.saved ? 'Actualizar plan' : 'Guardar plan'}
          </Button>
          {!plan?.saved && plan && (
            <span className="text-xs text-ink-500">Vista previa: guárdalo para verlo también en la agenda de la familia.</span>
          )}
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </section>

      {loading && <p className="text-sm text-ink-500">Calculando…</p>}
      {!loading && !plan && !error && (
        <p className="text-sm text-ink-400">Pon la fecha del examen y pulsa «Guardar plan».</p>
      )}

      {plan && (
        <>
          {/* Summary */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Días para el examen" value={String(plan.daysLeft)} hint={`${plan.studyDays} de estudio`} />
            <Stat label="Banco visto" value={`${plan.totals.seenPct}%`} hint={`${plan.totals.unseen} sin ver de ${plan.totals.questions}`} />
            <Stat label="Para repasar hoy" value={String(plan.totals.dueNow)} hint="tarjetas vencidas" />
            <Stat label="Simulacros" value={String(plan.totals.mocks)} hint={`día más cargado: ${plan.totals.peakMinutes} min`} />
          </section>

          {plan.weakTopics.length > 0 && (
            <section className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-400">Temas flojos:</span>
              {plan.weakTopics.map((w) => (
                <Badge key={w.topicId} color="rose">
                  {w.topic}{w.accuracy !== null ? ` · ${Math.round(w.accuracy * 100)}% acierto` : ''}
                </Badge>
              ))}
            </section>
          )}

          {plan.warnings.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
              {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          {/* Today */}
          {today && (
            <section className="bg-ink-800 border border-amber-500/40 rounded-xl p-4 flex flex-col gap-3" data-testid="plan-today">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-display text-base text-ink-100">Hoy</h3>
                <Badge color={KIND_COLOR[today.kind]}>{KIND_LABEL[today.kind]}</Badge>
                {today.minutes > 0 && <span className="text-xs text-ink-400">~{today.minutes} min</span>}
              </div>
              <ul className="list-disc pl-5 text-sm text-ink-200 flex flex-col gap-1">
                {today.tasks.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
              <div className="flex flex-wrap gap-2">
                {today.kind !== 'rest' && today.kind !== 'exam' && (
                  <Button size="sm" onClick={() => void startToday()} loading={busy === 'today'}
                    disabled={plan.todayPlan.questionIds.length === 0}>
                    Empezar la sesión de hoy ({plan.todayPlan.questionIds.length})
                  </Button>
                )}
                <Button size="sm" variant={today.kind === 'mock' ? 'primary' : 'secondary'} onClick={() => void startMock()}
                  loading={busy === 'mock'} disabled={plan.totals.questions === 0}>
                  Simulacro cronometrado ({plan.settings.mockQuestions} preguntas · {plan.settings.mockMinutes} min)
                </Button>
              </div>
            </section>
          )}

          {/* Days */}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-ink-400 uppercase tracking-widest">Próximos días</h3>
            <ol className="flex flex-col divide-y divide-ink-800 border border-ink-700 rounded-xl bg-ink-800/40">
              {visibleDays.map((d) => (
                <li key={d.date} className={`px-4 py-2.5 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 ${d.kind === 'rest' ? 'opacity-60' : ''}`}>
                  <div className="sm:w-40 flex-shrink-0 flex items-center gap-2">
                    <span className="text-sm text-ink-100 tabular-nums">{formatDay(d.date)}</span>
                    <span className="text-xs text-ink-500">{d.weekday}</span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge color={KIND_COLOR[d.kind]}>{KIND_LABEL[d.kind]}</Badge>
                      {d.minutes > 0 && (
                        <span className={`text-xs ${d.overload ? 'text-rose-400' : 'text-ink-400'}`}>
                          ~{d.minutes} min{d.overload ? ' · por encima de tu tiempo' : ''}
                        </span>
                      )}
                    </div>
                    {d.kind !== 'rest' && (
                      <p className="text-xs text-ink-300 break-words">{d.tasks.join(' ')}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {plan.days.length - 1 > 14 && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="self-start text-xs text-ink-400 hover:text-amber-400">
                {showAll ? 'Ver solo dos semanas' : `Ver los ${plan.days.length - 1} días`}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-ink-800 border border-ink-700 rounded-xl px-4 py-3 min-w-0">
      <p className="text-[11px] uppercase tracking-widest text-ink-500 truncate">{label}</p>
      <p className="font-display text-2xl text-ink-100">{value}</p>
      {hint && <p className="text-xs text-ink-500 truncate">{hint}</p>}
    </div>
  );
}
