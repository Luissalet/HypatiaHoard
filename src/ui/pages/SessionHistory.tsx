import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/data/db';
import { subjectRepo } from '@/data/repos';
import { Button, Card, Select } from '@/ui/components';
import type { Subject, PracticeSession, SessionMode } from '@/domain/models';

const MODE_LABELS: Record<string, string> = {
  random: 'Aleatorio',
  all: 'Todas',
  failed: 'Falladas',
  topic: 'Por tema',
  smart: 'Repaso SM-2',
  exam: 'Simulacro',
};

export function SessionHistoryPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSubject, setFilterSubject] = useState('');
  const [filterMode, setFilterMode] = useState('');

  useEffect(() => {
    (async () => {
      const [allSessions, allSubjects] = await Promise.all([
        db.sessions
          .orderBy('createdAt')
          .reverse()
          .filter(s => s.finishedAt != null)
          .toArray(),
        subjectRepo.getAll(),
      ]);
      setSessions(allSessions);
      setSubjects(allSubjects);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 animate-pulse">Cargando historial…</p>
      </div>
    );
  }

  const subjectMap = Object.fromEntries(subjects.map(s => [s.id, s]));

  const filtered = sessions.filter(s => {
    if (filterSubject) {
      const ids = s.subjectIds ?? [s.subjectId];
      if (!ids.includes(filterSubject)) return false;
    }
    if (filterMode && s.mode !== filterMode) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
      <header className="border-b border-ink-800 bg-ink-900/50 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <button onClick={() => navigate('/')} className="text-ink-400 hover:text-ink-200 text-sm transition-colors flex-shrink-0">
              ←
            </button>
            <h1 className="font-display text-lg sm:text-xl text-ink-100 truncate">Historial de sesiones</h1>
          </div>
          <span className="text-sm text-ink-500 flex-shrink-0">{filtered.length} sesiones</span>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {/* Filters */}
        <div className="flex gap-3 mb-6 flex-wrap">
          <Select value={filterSubject} onChange={e => setFilterSubject(e.target.value)} className="text-xs py-1.5">
            <option value="">Todas las asignaturas</option>
            {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select value={filterMode} onChange={e => setFilterMode(e.target.value)} className="text-xs py-1.5">
            <option value="">Todos los modos</option>
            {Object.entries(MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          {(filterSubject || filterMode) && (
            <Button size="sm" variant="ghost" onClick={() => { setFilterSubject(''); setFilterMode(''); }}>
              × Limpiar
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <Card className="py-12 text-center">
            <p className="text-ink-500">No hay sesiones terminadas{filterSubject || filterMode ? ' con estos filtros' : ''}.</p>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-700 text-ink-500 text-xs text-left">
                    <th className="pb-2 font-normal">Fecha</th>
                    <th className="pb-2 font-normal">Asignatura</th>
                    <th className="pb-2 font-normal">Modo</th>
                    <th className="pb-2 font-normal text-center">Preguntas</th>
                    <th className="pb-2 font-normal text-center">% Acierto</th>
                    <th className="pb-2 font-normal text-center">Duración</th>
                    <th className="pb-2 font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const correct = s.answers.filter(a => a.result === 'CORRECT').length;
                    const total = s.questionIds.length;
                    const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
                    const sub = subjectMap[s.subjectId];
                    const duration = s.finishedAt
                      ? Math.round((new Date(s.finishedAt).getTime() - new Date(s.createdAt).getTime()) / 60000)
                      : null;

                    return (
                      <tr
                        key={s.id}
                        className="border-b border-ink-800 last:border-0 hover:bg-ink-800/30 cursor-pointer transition-colors"
                        onClick={() => navigate(`/results/${s.id}`)}
                      >
                        <td className="py-2.5 text-ink-300">
                          {new Date(s.createdAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="py-2.5">
                          {s.subjectIds && s.subjectIds.length > 1 ? (
                            <div className="flex items-center gap-1.5">
                              <div className="flex -space-x-1">
                                {s.subjectIds.slice(0, 3).map((id) => (
                                  <div
                                    key={id}
                                    className="w-2.5 h-2.5 rounded-full border border-ink-800"
                                    style={{ backgroundColor: subjectMap[id]?.color ?? '#888' }}
                                    title={subjectMap[id]?.name}
                                  />
                                ))}
                              </div>
                              <span className="text-ink-200 text-xs">Mixta ({s.subjectIds.length})</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {sub?.color && (
                                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sub.color }} />
                              )}
                              <span className="text-ink-200">{sub?.name ?? 'Desconocida'}</span>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5">
                          <span className="text-xs bg-ink-800 text-ink-400 px-2 py-0.5 rounded">
                            {MODE_LABELS[s.mode] ?? s.mode}
                          </span>
                        </td>
                        <td className="py-2.5 text-center text-ink-300">{total}</td>
                        <td className="py-2.5 text-center">
                          <span className={`font-bold ${pct >= 70 ? 'text-sage-400' : pct >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                            {pct}%
                          </span>
                        </td>
                        <td className="py-2.5 text-center text-ink-500">
                          {duration !== null ? `${duration} min` : '—'}
                        </td>
                        <td className="py-2.5 text-right">
                          <span className="text-xs text-amber-500 hover:text-amber-400 transition-colors">
                            Ver →
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
