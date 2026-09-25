import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/data/db';
import { subjectRepo } from '@/data/repos';
import { Button, Card, Progress } from '@/ui/components';
import type { Subject, Question, PracticeSession } from '@/domain/models';

function calcStreak(sessions: PracticeSession[]): number {
  const days = new Set(sessions.filter(s => s.finishedAt).map(s => s.finishedAt!.split('T')[0]));
  let streak = 0;
  const d = new Date();
  while (days.has(d.toISOString().split('T')[0])) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

interface DayData { date: string; pct: number; count: number; }

function PerformanceCurve({ data }: { data: DayData[] }) {
  if (data.length < 2) return <p className="text-sm text-ink-600 text-center py-4">No hay suficientes datos para mostrar la curva.</p>;
  const W = 600; const H = 120; const pad = 20;
  const xs = data.map((_, i) => pad + (i / (data.length - 1)) * (W - 2 * pad));
  const ys = data.map(d => H - pad - (d.pct / 100) * (H - 2 * pad));
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 200 }}>
        <path d={path} stroke="#4ade80" strokeWidth={2} fill="none" strokeLinejoin="round" />
        {data.map((d, i) => (
          <circle key={i} cx={xs[i]} cy={ys[i]} r={3} fill="#4ade80">
            <title>{d.date}: {d.pct}% ({d.count} sesiones)</title>
          </circle>
        ))}
        <line x1={pad} y1={H - pad - (70 / 100) * (H - 2 * pad)} x2={W - pad} y2={H - pad - (70 / 100) * (H - 2 * pad)} stroke="#4ade80" strokeWidth={0.5} strokeDasharray="4 3" opacity={0.3} />
      </svg>
      <div className="flex justify-between text-xs text-ink-600 px-1 mt-1">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export function GlobalStatsPage() {
  const navigate = useNavigate();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [subs, qs, sess] = await Promise.all([
        subjectRepo.getAll(),
        db.questions.toArray(),
        db.sessions.filter(s => s.finishedAt != null).toArray(),
      ]);
      setSubjects(subs);
      setQuestions(qs);
      setSessions(sess);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 animate-pulse-soft">Cargando estadísticas…</p>
      </div>
    );
  }

  const today = new Date().toISOString().split('T')[0];
  const streak = calcStreak(sessions);
  const totalQ = questions.length;
  const seenQ = questions.filter(q => q.stats.seen > 0).length;
  const seenPct = totalQ === 0 ? 0 : Math.round((seenQ / totalQ) * 100);
  const goodQ = questions.filter(q => q.stats.seen > 0 && q.stats.correct / q.stats.seen >= 0.7).length;
  const goodPct = seenQ === 0 ? 0 : Math.round((goodQ / seenQ) * 100);

  // SM-2: due today
  const dueToday = questions.filter(q => !q.stats.nextReviewAt || q.stats.nextReviewAt <= today);
  const dueBySubject: Record<string, number> = {};
  for (const q of dueToday) dueBySubject[q.subjectId] = (dueBySubject[q.subjectId] ?? 0) + 1;

  // Curva histórica: últimas 4 semanas
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const recentSessions = sessions.filter(s => s.finishedAt && s.finishedAt >= fourWeeksAgo.toISOString());
  const sessionsByDay: Record<string, PracticeSession[]> = {};
  for (const s of recentSessions) {
    const day = s.finishedAt!.split('T')[0];
    if (!sessionsByDay[day]) sessionsByDay[day] = [];
    sessionsByDay[day].push(s);
  }
  const curveData: DayData[] = Object.entries(sessionsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySessions]) => {
      const correct = daySessions.flatMap(s => s.answers).filter(a => a.result === 'CORRECT').length;
      const total = daySessions.flatMap(s => s.answers).filter(a => a.result != null).length;
      return { date, pct: total === 0 ? 0 : Math.round((correct / total) * 100), count: daySessions.length };
    });

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <header className="border-b border-ink-800 bg-ink-900/50 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-4">
          <button onClick={() => navigate('/')} className="text-ink-400 hover:text-ink-200 text-sm transition-colors">
            ← Dashboard
          </button>
          <h1 className="font-display text-xl text-ink-100">Estadísticas globales</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6 sm:gap-8">

        {/* Resumen global */}
        <section>
          <h2 className="font-display text-lg text-ink-200 mb-4">Resumen global</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="text-center py-5">
              <p className="text-3xl font-display text-amber-400">{streak}</p>
              <p className="text-xs text-ink-500 mt-1">Racha (días)</p>
            </Card>
            <Card className="text-center py-5">
              <p className="text-3xl font-display text-ink-100">{totalQ}</p>
              <p className="text-xs text-ink-500 mt-1">Preguntas totales</p>
            </Card>
            <Card className="text-center py-5">
              <p className="text-3xl font-display text-sage-400">{seenPct}%</p>
              <p className="text-xs text-ink-500 mt-1">Vistas al menos 1×</p>
            </Card>
            <Card className="text-center py-5">
              <p className="text-3xl font-display text-sage-400">{goodPct}%</p>
              <p className="text-xs text-ink-500 mt-1">Con ≥70% acierto</p>
            </Card>
          </div>
        </section>

        {/* Repaso de hoy SM-2 */}
        <section>
          <h2 className="font-display text-lg text-ink-200 mb-4">Repaso de hoy (SM-2)</h2>
          {subjects.filter(s => (dueBySubject[s.id] ?? 0) > 0).length === 0 ? (
            <Card className="py-8 text-center">
              <p className="text-2xl mb-2">🎉</p>
              <p className="text-ink-300 font-medium">¡Todo al día!</p>
              <p className="text-ink-500 text-sm mt-1">No tienes preguntas pendientes de repaso hoy.</p>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {subjects
                .filter(s => (dueBySubject[s.id] ?? 0) > 0)
                .sort((a, b) => (dueBySubject[b.id] ?? 0) - (dueBySubject[a.id] ?? 0))
                .map(s => (
                  <Card key={s.id} className="flex items-center justify-between gap-4 py-4 px-5">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: s.color ?? '#f59e0b' }} />
                      <div>
                        <p className="text-ink-100 font-medium text-sm">{s.name}</p>
                        <p className="text-ink-500 text-xs">{dueBySubject[s.id]} pregunta{dueBySubject[s.id] !== 1 ? 's' : ''} para repasar</p>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => navigate(`/subject/${s.id}?mode=smart`)}>
                      Practicar →
                    </Button>
                  </Card>
                ))}
            </div>
          )}
        </section>

        {/* Progreso por asignatura */}
        <section>
          <h2 className="font-display text-lg text-ink-200 mb-4">Progreso por asignatura</h2>
          <div className="flex flex-col gap-3">
            {subjects.map(s => {
              const sqs = questions.filter(q => q.subjectId === s.id);
              const seen = sqs.filter(q => q.stats.seen > 0).length;
              const correct = sqs.reduce((a, q) => a + q.stats.correct, 0);
              const seenCount = sqs.reduce((a, q) => a + q.stats.seen, 0);
              const pct = seenCount === 0 ? 0 : Math.round((correct / seenCount) * 100);
              const due = dueBySubject[s.id] ?? 0;
              return (
                <Card key={s.id} className="py-4 px-5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color ?? '#f59e0b' }} />
                      <span className="text-sm font-medium text-ink-100">{s.name}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-500">
                      {due > 0 && <span className="text-amber-400">{due} pendientes hoy</span>}
                      <span>{seen}/{sqs.length} vistas</span>
                      {seenCount > 0 && (
                        <span className={pct >= 70 ? 'text-sage-400' : pct >= 40 ? 'text-amber-400' : 'text-rose-400'}>
                          {pct}% acierto
                        </span>
                      )}
                    </div>
                  </div>
                  {sqs.length > 0 && (
                    <Progress value={seen} max={sqs.length} color={pct >= 70 ? 'sage' : pct >= 40 ? 'amber' : 'rose'} />
                  )}
                </Card>
              );
            })}
          </div>
        </section>

        {/* Curva de rendimiento */}
        <section>
          <h2 className="font-display text-lg text-ink-200 mb-4">Rendimiento (últimas 4 semanas)</h2>
          <Card className="py-5 px-5">
            <PerformanceCurve data={curveData} />
          </Card>
        </section>

      </main>
    </div>
  );
}
