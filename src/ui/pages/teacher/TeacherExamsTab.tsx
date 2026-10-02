/** Exámenes del profesor: lista y «Generar examen» desde el banco y/o el material (IA). */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Input, Select, Textarea } from '@/ui/components';
import { useStore } from '@/ui/store';
import { classRepo, teacherExamRepo } from '@/data/teacherRepo';
import { QTYPES, TYPE_LABEL, createTeacherExam } from '@/data/teacherExams';
import { startGeneration } from '@/data/teacherClient';
import { questionRepo, topicRepo } from '@/data/repos';
import type { QuestionType, Topic } from '@/domain/models';
import type { ExamSource, TeacherClass, TeacherExam } from '@/domain/teacher';
import { TYPE_SHORT, useLoad, useModelCaps, useTeacherTick } from './shared';

export function TeacherExamsTab() {
  const tick = useTeacherTick();
  const navigate = useNavigate();
  const subjects = useStore((s) => s.subjects);
  const [exams] = useLoad(() => teacherExamRepo.list(), [tick], [] as TeacherExam[]);
  const [showForm, setShowForm] = useState(false);
  const names = new Map(subjects.map((s) => [s.id, s.name]));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-400">Exámenes para tus alumnos: del banco o redactados por el modelo a partir de tu material, con su cita.</p>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cerrar' : '+ Generar examen'}</Button>
      </div>
      {showForm && <GenerateForm onCreated={(id, jobId) => navigate(`/teacher/exam/${id}${jobId ? `?job=${jobId}` : ''}`)} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {exams.map((e) => {
          const pending = e.drafts.filter((d) => d.status === 'pending').length;
          return (
            <Card key={e.id} hover onClick={() => navigate(`/teacher/exam/${e.id}`)} className="!p-4">
              <p className="text-sm text-ink-100 font-medium">{e.title}</p>
              <p className="text-xs text-ink-500 mb-2">{names.get(e.subjectId) ?? 'Asignatura borrada'} · {new Date(e.createdAt).toLocaleDateString('es-ES')}</p>
              <div className="flex flex-wrap gap-1">
                <Badge>{e.items.length} preguntas</Badge>
                <Badge>{e.versions.length || 1} {e.versions.length === 1 ? 'versión' : 'versiones'}</Badge>
                {pending > 0 && <Badge color="amber">{pending} borradores por revisar</Badge>}
              </div>
            </Card>
          );
        })}
      </div>
      {exams.length === 0 && !showForm && <p className="text-xs text-ink-500">Todavía no has generado ningún examen.</p>}
    </div>
  );
}

function GenerateForm({ onCreated }: { onCreated: (examId: string, jobId?: string) => void }) {
  const subjects = useStore((s) => s.subjects);
  const caps = useModelCaps();
  const [classes] = useLoad(() => classRepo.list(), [], [] as TeacherClass[]);
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [bankCounts, setBankCounts] = useState<Record<string, number>>({});
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<QuestionType, number>>({ TEST: 8, DESARROLLO: 2, COMPLETAR: 0, PRACTICO: 0 });
  const [points, setPoints] = useState<Record<QuestionType, number>>({ TEST: 1, DESARROLLO: 2, COMPLETAR: 1, PRACTICO: 2 });
  const [useMix, setUseMix] = useState(false);
  const [mix, setMix] = useState({ easy: 30, medium: 50, hard: 20 });
  const [source, setSource] = useState<ExamSource>('bank');
  const [versions, setVersions] = useState(2);
  const [penalty, setPenalty] = useState(0);
  const [classId, setClassId] = useState('');
  const [title, setTitle] = useState('');
  const [header, setHeader] = useState({ centre: '', course: '', date: '', instructions: '', durationMin: 60 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canGenerate = caps.hoard && caps.llm;

  useEffect(() => { if (!subjectId && subjects[0]) setSubjectId(subjects[0].id); }, [subjects, subjectId]);
  useEffect(() => {
    if (!subjectId) return;
    void topicRepo.getBySubject(subjectId).then(setTopics);
    void questionRepo.getBySubject(subjectId).then((qs) => {
      const c: Record<string, number> = {};
      for (const q of qs) c[q.type] = (c[q.type] ?? 0) + 1;
      setBankCounts(c);
    });
    setTopicIds([]);
  }, [subjectId]);
  const total = useMemo(() => QTYPES.reduce((s, t) => s + (counts[t] || 0), 0), [counts]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { exam, toGenerate } = await createTeacherExam({
        spec: {
          subjectId, topicIds, counts, source, versions, testPenalty: penalty,
          difficulty: useMix ? mix : null, pointsByType: points,
        },
        title, header, classId: classId || null,
      });
      let jobId: string | undefined;
      if (Object.values(toGenerate).some((n) => (n ?? 0) > 0) && canGenerate) {
        jobId = (await startGeneration(exam.id, toGenerate)).id;
      }
      onCreated(exam.id, jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Asignatura" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select label="Clase (opcional)" value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">—</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Temas (ninguno = todos)</span>
        <div className="flex flex-wrap gap-2">
          {topics.map((t, i) => {
            const on = topicIds.includes(t.id);
            return (
              <button key={t.id} type="button" onClick={() => setTopicIds(on ? topicIds.filter((x) => x !== t.id) : [...topicIds, t.id])}
                className={`px-2.5 py-1 rounded-lg text-xs border ${on ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-ink-600 text-ink-300 hover:border-ink-400'}`}>
                {i + 1}. {t.title}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Preguntas por tipo · puntos por pregunta</span>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
          {QTYPES.map((t) => (
            <div key={t} className="rounded-lg border border-ink-700 p-2">
              <p className="text-xs text-ink-300 mb-1">{TYPE_SHORT[t]} <span className="text-ink-500">({bankCounts[t] ?? 0} en banco)</span></p>
              <div className="flex gap-1">
                <input aria-label={`Número de ${TYPE_LABEL[t]}`} type="number" min={0} max={50} value={counts[t]} onChange={(e) => setCounts({ ...counts, [t]: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-1/2 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
                <input aria-label={`Puntos de ${TYPE_LABEL[t]}`} type="number" min={0} step={0.25} value={points[t]} onChange={(e) => setPoints({ ...points, [t]: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-1/2 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-500 mt-1">{total} preguntas · {QTYPES.reduce((s, t) => s + counts[t] * points[t], 0).toString().replace('.', ',')} puntos (la nota se lleva a 0-10).</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Origen</span>
          {([['bank', 'Banco de preguntas'], ['mixed', 'Banco + IA para lo que falte'], ['generate', 'Nuevas con IA desde el material']] as [ExamSource, string][]).map(([v, label]) => (
            <label key={v} className={`flex items-center gap-2 text-sm ${v !== 'bank' && !canGenerate ? 'text-ink-500' : 'text-ink-200'}`}>
              <input type="radio" name="source" checked={source === v} disabled={v !== 'bank' && !canGenerate} onChange={() => setSource(v)} />
              {label}
            </label>
          ))}
          {!canGenerate && <p className="text-xs text-ink-500">{caps.hoard ? 'Sin modelo local cargado: solo banco.' : 'La IA necesita Hypatia (servidor local).'}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Select label="Versiones" value={String(versions)} onChange={(e) => setVersions(Number(e.target.value))}>
            <option value="1">Solo A</option><option value="2">A y B</option><option value="3">A, B y C</option><option value="4">A–D</option>
          </Select>
          <Select label="Penalización test" value={String(penalty)} onChange={(e) => setPenalty(Number(e.target.value))}>
            <option value="0">No resta</option><option value="0.25">−1/4 de la pregunta</option><option value="0.33">−1/3 de la pregunta</option><option value="0.5">−1/2 de la pregunta</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-ink-200"><input type="checkbox" checked={useMix} onChange={(e) => setUseMix(e.target.checked)} /> Mezcla de dificultad (%)</label>
          {useMix && (['easy', 'medium', 'hard'] as const).map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-xs text-ink-300">
              {k === 'easy' ? 'Fácil (1-2)' : k === 'medium' ? 'Media (3)' : 'Difícil (4-5)'}
              <input type="number" min={0} max={100} value={mix[k]} onChange={(e) => setMix({ ...mix, [k]: Math.max(0, Number(e.target.value) || 0) })}
                className="w-16 bg-ink-800 border border-ink-600 rounded px-2 py-0.5 text-sm text-ink-100" />
            </label>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Examen · Tema 3" />
        <Input label="Centro" value={header.centre} onChange={(e) => setHeader({ ...header, centre: e.target.value })} />
        <Input label="Curso / grupo" value={header.course} onChange={(e) => setHeader({ ...header, course: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Fecha" type="date" value={header.date} onChange={(e) => setHeader({ ...header, date: e.target.value })} />
          <Input label="Duración (min)" type="number" min={1} value={header.durationMin} onChange={(e) => setHeader({ ...header, durationMin: Number(e.target.value) || 60 })} />
        </div>
      </div>
      <Textarea label="Instrucciones" rows={2} value={header.instructions} onChange={(e) => setHeader({ ...header, instructions: e.target.value })} />
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={submit} loading={busy} disabled={!subjectId || total === 0}>Generar examen</Button>
      </div>
    </Card>
  );
}
