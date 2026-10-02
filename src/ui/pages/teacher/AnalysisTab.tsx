/** Análisis de la clase: acierto por pregunta y tema, errores comunes, notas, y «Reforzar». */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Select } from '@/ui/components';
import { batchRepo, classRepo } from '@/data/teacherRepo';
import { batchAnalysis, createReinforcement, loadBatchContext, type BatchContext } from '@/data/teacherBatch';
import { combineTopics, type ExamAnalysis } from '@/domain/teacherCore';
import type { GradingBatch, TeacherClass } from '@/domain/teacher';
import { TYPE_SHORT, fmt, pct, useLoad, useTeacherTick } from './shared';

function Bar({ value, tone = 'amber' }: { value: number | null; tone?: 'amber' | 'rose' | 'sage' }) {
  const color = tone === 'rose' ? 'bg-rose-500' : tone === 'sage' ? 'bg-sage-500' : 'bg-amber-500';
  return (
    <div className="h-2 bg-ink-700 rounded-full overflow-hidden w-full">
      <div className={`h-full ${color}`} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  );
}

const tone = (v: number | null) => (v === null ? 'amber' : v < 0.5 ? 'rose' : v >= 0.7 ? 'sage' : 'amber');

export function AnalysisTab() {
  const tick = useTeacherTick();
  const [classes] = useLoad(() => classRepo.list(), [tick], [] as TeacherClass[]);
  const [batches] = useLoad(() => batchRepo.list(), [tick], [] as GradingBatch[]);
  const [classId, setClassId] = useState('');
  const [batchId, setBatchId] = useState<string>('all');
  const [contexts, setContexts] = useState<BatchContext[]>([]);
  const [includeOpen, setIncludeOpen] = useState(false);
  useEffect(() => { if (!classId && classes[0]) setClassId(classes[0].id); }, [classes, classId]);
  const ofClass = batches.filter((b) => b.classId === classId);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ids = batchId === 'all' ? ofClass.map((b) => b.id) : [batchId];
      const loaded = (await Promise.all(ids.map((id) => loadBatchContext(id)))).filter(Boolean) as BatchContext[];
      if (alive) setContexts(loaded);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, batchId, tick, batches.length]);
  const analyses = useMemo(() => contexts.map((c) => ({ ctx: c, a: batchAnalysis(c, includeOpen) })), [contexts, includeOpen]);
  const combined = useMemo(() => combineTopics(analyses.map((x) => x.a)), [analyses]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1"><Select label="Clase" value={classId} onChange={(e) => { setClassId(e.target.value); setBatchId('all'); }}>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></div>
        <div className="flex-1"><Select label="Examen" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
          <option value="all">Todos los exámenes de la clase</option>
          {ofClass.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </Select></div>
        <label className="flex items-center gap-2 text-xs text-ink-300 pb-2"><input type="checkbox" checked={includeOpen} onChange={(e) => setIncludeOpen(e.target.checked)} /> Incluir notas sin confirmar</label>
      </Card>
      {!ofClass.length && <p className="text-xs text-ink-500">Esta clase aún no tiene entregas.</p>}
      {analyses.length > 1 && (
        <Card>
          <h3 className="font-display text-base text-ink-200 mb-2">Temas en todos los exámenes</h3>
          <TopicBars rows={combined.map((t) => ({ label: t.topic ?? 'Sin tema', value: t.success, extra: `${t.exams} exámenes` }))} />
        </Card>
      )}
      {analyses.map(({ ctx, a }) => <ExamBlock key={ctx.batch.id} ctx={ctx} a={a} />)}
    </div>
  );
}

function TopicBars({ rows }: { rows: { label: string; value: number | null; extra?: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[220px_1fr_auto] gap-2 items-center">
          <span className={`text-sm truncate ${i === 0 ? 'text-rose-300' : 'text-ink-200'}`}>{r.label}</span>
          <div className="hidden sm:block"><Bar value={r.value} tone={tone(r.value)} /></div>
          <span className="text-xs text-ink-400 whitespace-nowrap">{pct(r.value)}{r.extra ? ` · ${r.extra}` : ''}</span>
        </div>
      ))}
      {!rows.length && <p className="text-xs text-ink-500">Sin notas confirmadas todavía.</p>}
    </div>
  );
}

function ExamBlock({ ctx, a }: { ctx: BatchContext; a: ExamAnalysis }) {
  const navigate = useNavigate();
  const [studentId, setStudentId] = useState('');
  const [msg, setMsg] = useState('');
  const d = a.distribution;
  const maxBin = Math.max(1, ...d.histogram);
  const reinforce = async (subId?: string) => {
    const sub = subId ? ctx.submissions.find((s) => s.id === subId) : undefined;
    const res = await createReinforcement(ctx, sub);
    setMsg(res.examId ? `Creado «${res.name}»: está en la pestaña Exámenes de la asignatura (practicar o tarjetas).` : 'Ningún tema por debajo del 60 %: no hace falta refuerzo.');
  };
  return (
    <Card className="flex flex-col gap-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base text-ink-100">{ctx.batch.title}</h3>
          <p className="text-xs text-ink-500">{a.graded} notas · media {fmt(d.mean)} · mediana {fmt(d.median)} · aprobados {pct(d.passRate)}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate(`/teacher/batch/${ctx.batch.id}`)}>Abrir entrega</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs text-ink-400 uppercase tracking-widest mb-2">Calificaciones</p>
          {d.bands.map((b) => (
            <div key={b.label} className="grid grid-cols-[110px_1fr_auto] gap-2 items-center mb-1">
              <span className="text-xs text-ink-300">{b.label}</span>
              <Bar value={d.count ? b.count / d.count : 0} tone={b.min < 5 ? 'rose' : b.min >= 7 ? 'sage' : 'amber'} />
              <span className="text-xs text-ink-400">{b.count}</span>
            </div>
          ))}
          <div className="flex items-end gap-1 h-20 mt-3" aria-label="Histograma de notas">
            {d.histogram.map((n, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className={`w-full rounded-t ${i < 5 ? 'bg-rose-500/70' : 'bg-amber-500/80'}`} style={{ height: `${(n / maxBin) * 60}px` }} title={`${i}–${i + 1}: ${n}`} />
                <span className="text-[10px] text-ink-500">{i}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs text-ink-400 uppercase tracking-widest mb-2">Temas (peor primero)</p>
          <TopicBars rows={a.topics.map((t) => ({ label: t.topic ?? 'Sin tema', value: t.success }))} />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-xs text-ink-500 border-b border-ink-700">
            <th className="py-1.5 pr-2">#</th><th className="pr-2">Pregunta</th><th className="pr-2">Tipo</th><th className="pr-2 w-28">Acierto</th><th>Errores más comunes</th>
          </tr></thead>
          <tbody>
            {a.items.map((it) => (
              <tr key={it.questionId} className="border-b border-ink-800 align-top">
                <td className="py-1.5 pr-2 text-ink-500 text-xs">{it.position}</td>
                <td className="pr-2 text-ink-200 text-xs max-w-[260px]">{it.prompt}<span className="block text-ink-500">{it.topic ?? ''}</span></td>
                <td className="pr-2 text-xs text-ink-400">{TYPE_SHORT[it.type ?? ''] ?? ''}</td>
                <td className="pr-2"><Bar value={it.success} tone={tone(it.success)} /><span className="text-xs text-ink-400">{pct(it.success)}</span></td>
                <td className="text-xs text-ink-400">
                  {it.wrongOptions.slice(0, 2).map((w) => <div key={w.optionId}>«{w.text}» × {w.count}</div>)}
                  {it.commonWrong.map((w) => <div key={w.answer}>«{w.answer}» × {w.count}</div>)}
                  {it.weakCriteria.slice(0, 2).map((w) => <div key={w.criterionId}>{w.name ?? w.criterionId} flojo × {w.count}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end border-t border-ink-700 pt-3">
        <Button size="sm" onClick={() => reinforce()}>Reforzar a la clase</Button>
        <div className="flex-1 sm:max-w-xs"><Select label="O a un alumno" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
          <option value="">—</option>
          {ctx.submissions.map((s) => <option key={s.id} value={s.id}>{ctx.students[s.studentId]?.displayName ?? '?'}</option>)}
        </Select></div>
        <Button size="sm" variant="secondary" disabled={!studentId} onClick={() => reinforce(studentId)}>Refuerzo individual</Button>
      </div>
      {msg && <p className="text-xs text-sage-400">{msg}</p>}
    </Card>
  );
}
