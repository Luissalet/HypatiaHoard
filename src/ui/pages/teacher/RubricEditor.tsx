/** Editor de rúbrica (criterios con peso y niveles descriptor + puntos), con «Proponer rúbrica». */

import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button, Input, Modal } from '@/ui/components';
import { rubricRepo } from '@/data/teacherRepo';
import { proposeRubric } from '@/data/teacherClient';
import { validateRubric } from '@/domain/teacherCore';
import type { Question } from '@/domain/models';
import type { Rubric, RubricCriterion, TeacherExam } from '@/domain/teacher';
import { MdContent } from '@/ui/components/MdContent';
import type { ModelCaps } from './shared';

/** Plantilla fija (sin modelo): igual que hypatia/teacher/rubrics.py#template. */
export function templateRubric(q?: Partial<Question>): RubricCriterion[] {
  const kw = (q?.keywords ?? []).slice(0, 6).join(', ');
  const rows: [string, number, string[]][] = q?.type === 'PRACTICO'
    ? [['Planteamiento', 30, ['No plantea el problema', 'Planteamiento incompleto o con errores', 'Planteamiento correcto y justificado']],
       ['Desarrollo y cálculo', 40, ['Sin desarrollo', 'Desarrollo con errores importantes', 'Desarrollo con errores menores', 'Desarrollo correcto']],
       ['Resultado', 30, ['Sin resultado o incorrecto', `Resultado correcto${q?.numericAnswer ? ` (${q.numericAnswer})` : ''}`]]]
    : [['Contenido y conceptos clave', 60, ['No aborda los conceptos pedidos', 'Algunos conceptos, con errores', 'Casi todos los conceptos, sin errores graves', `Todos los conceptos clave correctos${kw ? ` (${kw})` : ''}`]],
       ['Precisión y justificación', 25, ['Imprecisa o sin justificar', 'Parcialmente justificada', 'Precisa y bien justificada']],
       ['Claridad y organización', 15, ['Desordenada o confusa', 'Comprensible', 'Clara y bien estructurada']]];
  return rows.map(([name, weight, levels], i) => ({
    id: `c${i + 1}`, name, weight, levels: levels.map((d, j) => ({ id: `c${i + 1}l${j}`, descriptor: d, points: j })),
  }));
}

interface Props {
  open: boolean;
  onClose: () => void;
  exam: TeacherExam;
  question: Question | null;
  points: number;
  caps: ModelCaps;
}

export function RubricEditor({ open, onClose, exam, question, points, caps }: Props) {
  const [criteria, setCriteria] = useState<RubricCriterion[]>([]);
  const [title, setTitle] = useState('Rúbrica');
  const [origin, setOrigin] = useState<Rubric['origin']>('manual');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setNote('');
    void (async () => {
      const existing = question ? await rubricRepo.forQuestion(exam, question.id) : (await rubricRepo.byExam(exam.id)).find((r) => !r.questionId);
      const own = existing && (question ? existing.questionId === question.id : !existing.questionId) ? existing : undefined;
      if (own) {
        setCriteria(own.criteria);
        setTitle(own.title);
        setOrigin(own.origin);
      } else {
        setCriteria(templateRubric(question ?? undefined));
        setTitle(question ? 'Rúbrica' : 'Rúbrica del examen');
        setOrigin('template');
        if (existing && question) setNote('Ahora se usa la rúbrica del examen entero; guardar crea una propia de esta pregunta.');
      }
    })();
  }, [open, exam, question]);

  const propose = async () => {
    if (!question) return;
    setBusy(true);
    try {
      const res = await proposeRubric(question, points);
      setCriteria(res.rubric.criteria);
      setOrigin(res.rubric.origin);
      setNote(res.note ?? (res.model ? `Propuesta de ${res.model}: revísala y edítala.` : ''));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<RubricCriterion>) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const problems = validateRubric({ criteria });

  const save = async () => {
    await rubricRepo.save(exam, { criteria, title: title.trim() || 'Rúbrica', origin: origin === 'template' ? 'manual' : origin }, question?.id ?? null);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={question ? 'Rúbrica de la pregunta' : 'Rúbrica del examen'} size="xl">
      <div className="flex flex-col gap-3">
        {question && (
          <div className="rounded-lg border border-ink-700 bg-ink-900/40 p-3 text-sm">
            <MdContent content={question.prompt} className="prose prose-invert prose-sm max-w-none" />
            {question.modelAnswer && <p className="text-xs text-ink-400 mt-2"><span className="text-ink-300">Respuesta modelo:</span> {question.modelAnswer}</p>}
            <p className="text-xs text-ink-500 mt-1">{String(points).replace('.', ',')} puntos</p>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[180px]"><Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          {question && (
            <Button size="sm" variant="secondary" onClick={propose} loading={busy} disabled={!caps.hoard}
              title={caps.hoard ? (caps.llm ? 'El modelo local propone criterios y niveles' : 'Sin modelo: se propone la plantilla fija') : 'Necesita Hypatia'}>
              Proponer rúbrica
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setCriteria([...criteria, { id: `c${uuidv4().slice(0, 6)}`, name: 'Nuevo criterio', weight: 10, levels: [{ id: uuidv4().slice(0, 8), descriptor: 'No lo cumple', points: 0 }, { id: uuidv4().slice(0, 8), descriptor: 'Lo cumple', points: 1 }] }])}>+ Criterio</Button>
        </div>
        {note && <p className="text-xs text-amber-300">{note}</p>}
        {criteria.map((c, i) => (
          <div key={c.id} className="rounded-lg border border-ink-700 p-3 flex flex-col gap-2">
            <div className="flex gap-2 items-end">
              <div className="flex-1"><Input label="Criterio" value={c.name} onChange={(e) => update(i, { name: e.target.value })} /></div>
              <div className="w-24"><Input label="Peso" type="number" min={0} value={c.weight} onChange={(e) => update(i, { weight: Math.max(0, Number(e.target.value) || 0) })} /></div>
              <Button size="sm" variant="ghost" onClick={() => setCriteria(criteria.filter((_, j) => j !== i))} title="Quitar criterio">✕</Button>
            </div>
            {c.levels.map((l, k) => (
              <div key={l.id} className="flex gap-2 items-center pl-2">
                <input aria-label="Puntos del nivel" type="number" min={0} step={0.5} value={l.points}
                  onChange={(e) => update(i, { levels: c.levels.map((x, m) => (m === k ? { ...x, points: Math.max(0, Number(e.target.value) || 0) } : x)) })}
                  className="w-16 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
                <input aria-label="Descriptor del nivel" value={l.descriptor}
                  onChange={(e) => update(i, { levels: c.levels.map((x, m) => (m === k ? { ...x, descriptor: e.target.value } : x)) })}
                  className="flex-1 min-w-0 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
                <button className="text-xs text-ink-500 hover:text-rose-400" onClick={() => update(i, { levels: c.levels.filter((_, m) => m !== k) })}>✕</button>
              </div>
            ))}
            <button className="self-start text-xs text-ink-400 hover:text-ink-100 pl-2" onClick={() => update(i, { levels: [...c.levels, { id: uuidv4().slice(0, 8), descriptor: 'Nivel', points: (c.levels[c.levels.length - 1]?.points ?? 0) + 1 }] })}>+ Nivel</button>
          </div>
        ))}
        {problems.length > 0 && <ul className="text-xs text-rose-400 list-disc pl-4">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <p className="text-xs text-ink-500">Cada criterio vale su peso sobre la suma de pesos; el nivel elegido da sus puntos sobre los del mejor nivel.</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button size="sm" onClick={save} disabled={problems.length > 0}>Guardar rúbrica</Button>
        </div>
      </div>
    </Modal>
  );
}
