/** Entregas: un lote por examen + clase (una entrega por alumno). */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Select } from '@/ui/components';
import { db } from '@/data/db';
import { batchRepo, classRepo, teacherExamRepo } from '@/data/teacherRepo';
import type { GradingBatch, Submission, TeacherClass, TeacherExam } from '@/domain/teacher';
import { useLoad, useTeacherTick } from './shared';

const STATUS: Record<GradingBatch['status'], string> = { open: 'Abierta', grading: 'Corrigiendo', review: 'En revisión', closed: 'Cerrada' };

export function BatchesTab() {
  const tick = useTeacherTick();
  const navigate = useNavigate();
  const [data] = useLoad(async () => ({
    batches: await batchRepo.list(), exams: await teacherExamRepo.list(), classes: await classRepo.list(),
    subs: await db.submissions.toArray(),
  }), [tick], { batches: [] as GradingBatch[], exams: [] as TeacherExam[], classes: [] as TeacherClass[], subs: [] as Submission[] });
  const [examId, setExamId] = useState('');
  const [classId, setClassId] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    const exam = data.exams.find((e) => e.id === examId);
    const klass = data.classes.find((c) => c.id === classId);
    if (!exam || !klass) return;
    if (!exam.items.length) { setError('El examen no tiene preguntas todavía.'); return; }
    const batch = await batchRepo.create(exam, klass);
    navigate(`/teacher/batch/${batch.id}`);
  };
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1"><Select label="Examen" value={examId} onChange={(e) => setExamId(e.target.value)}>
          <option value="">—</option>{data.exams.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </Select></div>
        <div className="flex-1"><Select label="Clase" value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">—</option>{data.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></div>
        <Button onClick={create} disabled={!examId || !classId}>Nueva entrega</Button>
      </Card>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {data.batches.map((b) => {
          const subs = data.subs.filter((s) => s.batchId === b.id);
          const done = subs.filter((s) => s.confirmed).length;
          return (
            <Card key={b.id} hover onClick={() => navigate(`/teacher/batch/${b.id}`)} className="!p-4">
              <p className="text-sm text-ink-100 font-medium">{b.title}</p>
              <p className="text-xs text-ink-500 mb-2">{new Date(b.createdAt).toLocaleDateString('es-ES')}</p>
              <div className="flex flex-wrap gap-1">
                <Badge color={b.status === 'closed' ? 'sage' : b.status === 'review' ? 'amber' : 'ink'}>{STATUS[b.status]}</Badge>
                <Badge>{done}/{subs.length} notas confirmadas</Badge>
              </div>
            </Card>
          );
        })}
      </div>
      {data.batches.length === 0 && <p className="text-xs text-ink-500">Elige un examen y una clase para empezar a corregir.</p>}
    </div>
  );
}
