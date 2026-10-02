/** Rúbricas por examen y la escala de notas (0-10, una decimal, bandas configurables). */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Input } from '@/ui/components';
import { db } from '@/data/db';
import { teacherExamRepo, teacherSettingsRepo } from '@/data/teacherRepo';
import { DEFAULT_SCALE, normalizeScale } from '@/domain/teacherCore';
import type { GradeScale, Rubric, TeacherExam } from '@/domain/teacher';
import { useLoad, useTeacherTick } from './shared';

export function RubricsTab() {
  const tick = useTeacherTick();
  const navigate = useNavigate();
  const [data] = useLoad(async () => {
    const exams = await teacherExamRepo.list();
    const rubrics = await db.rubrics.toArray();
    return { exams, rubrics };
  }, [tick], { exams: [] as TeacherExam[], rubrics: [] as Rubric[] });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-400">Las rúbricas se editan desde cada examen (por pregunta o para todo el examen). Aquí tienes todas.</p>
        {data.exams.map((e) => {
          const own = data.rubrics.filter((r) => r.examId === e.id);
          const openQs = e.items.length;
          return (
            <Card key={e.id} className="!p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-ink-100 font-medium truncate">{e.title}</p>
                  <p className="text-xs text-ink-500">{own.length} rúbricas · {openQs} preguntas</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => navigate(`/teacher/exam/${e.id}#rubricas`)}>Abrir</Button>
              </div>
              {own.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {own.map((r) => <Badge key={r.id} color={r.origin === 'llm' ? 'blue' : 'ink'}>{r.title} · {r.criteria.length} criterios{r.questionId ? '' : ' · examen'}</Badge>)}
                </div>
              )}
            </Card>
          );
        })}
        {data.exams.length === 0 && <p className="text-xs text-ink-500">Genera un examen para poder añadirle rúbricas.</p>}
      </div>
      <ScaleEditor tick={tick} />
    </div>
  );
}

function ScaleEditor({ tick }: { tick: number }) {
  const [scale, setScale] = useState<GradeScale>(DEFAULT_SCALE);
  const [saved, setSaved] = useState('');
  useEffect(() => { void teacherSettingsRepo.getScale().then(setScale); }, [tick]);
  const save = async () => {
    await teacherSettingsRepo.saveScale(normalizeScale(scale));
    setSaved('Escala guardada.');
    setTimeout(() => setSaved(''), 2000);
  };
  return (
    <Card className="flex flex-col gap-3 self-start">
      <h3 className="font-display text-base text-ink-200">Escala de notas</h3>
      <div className="grid grid-cols-2 gap-2">
        <Input label="Nota máxima" type="number" min={1} value={scale.max} onChange={(e) => setScale({ ...scale, max: Number(e.target.value) || 10 })} />
        <Input label="Decimales" type="number" min={0} max={3} value={scale.decimals} onChange={(e) => setScale({ ...scale, decimals: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })} />
      </div>
      <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Bandas (desde)</span>
      {scale.bands.map((b, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input aria-label="Nota mínima" type="number" step={0.1} min={0} value={b.min}
            onChange={(e) => setScale({ ...scale, bands: scale.bands.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) || 0 } : x)) })}
            className="w-20 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
          <input aria-label="Nombre de la banda" value={b.label}
            onChange={(e) => setScale({ ...scale, bands: scale.bands.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
            className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
          <button className="text-xs text-ink-500 hover:text-rose-400" onClick={() => setScale({ ...scale, bands: scale.bands.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setScale({ ...scale, bands: [...scale.bands, { min: scale.max, label: 'Matrícula de Honor' }] })}>+ Banda</Button>
        <Button size="sm" variant="ghost" onClick={() => setScale(DEFAULT_SCALE)}>Por defecto</Button>
        <Button size="sm" onClick={save}>Guardar</Button>
      </div>
      {saved && <p className="text-xs text-sage-400">{saved}</p>}
      <p className="text-xs text-ink-500">Por defecto: Suspenso &lt; 5, Aprobado 5–6,9, Notable 7–8,9, Sobresaliente ≥ 9, con una decimal.</p>
    </Card>
  );
}
