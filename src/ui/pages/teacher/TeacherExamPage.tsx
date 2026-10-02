/** Un examen del profesor: cabecera, preguntas y puntos, borradores con su cita, rúbricas, versiones, PDF. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Input, Select, Textarea, TypeBadge } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { db } from '@/data/db';
import { batchRepo, classRepo, rubricRepo, teacherExamRepo } from '@/data/teacherRepo';
import { QTYPES, reviewDrafts, saveExamItems, updateExam } from '@/data/teacherExams';
import { startGeneration } from '@/data/teacherClient';
import { answerKey } from '@/domain/teacherCore';
import type { Question, QuestionType } from '@/domain/models';
import type { Rubric, TeacherClass, TeacherExam } from '@/domain/teacher';
import { generateTeacherExamPDF } from '@/utils/teacherPdf';
import { downloadBlob } from '@/utils/pdfExport';
import { slugify } from '@/domain/normalize';
import { RubricEditor } from './RubricEditor';
import { JobBanner, TYPE_SHORT, fmt, useLoad, useModelCaps, useTeacherTick } from './shared';
import { TeacherHeader } from './shared';

export function TeacherExamPage() {
  const { examId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tick = useTeacherTick();
  const caps = useModelCaps();
  const [data, loading] = useLoad(async () => {
    const exam = await teacherExamRepo.get(examId);
    if (!exam) return null;
    const ids = exam.items.map((i) => i.questionId);
    const qs = await db.questions.where('subjectId').equals(exam.subjectId).toArray();
    const byId: Record<string, Question> = {};
    for (const q of qs) byId[q.id] = q;
    const topics = new Map((await db.topics.where('subjectId').equals(exam.subjectId).toArray()).map((t) => [t.id, t.title]));
    const subject = await db.subjects.get(exam.subjectId);
    return { exam, bank: qs, questions: byId, ids, topics, subjectName: subject?.name ?? '', rubrics: await rubricRepo.byExam(exam.id) };
  }, [examId, tick], null);
  const [classes] = useLoad(() => classRepo.list(), [], [] as TeacherClass[]);
  const [rubricFor, setRubricFor] = useState<{ q: Question | null; points: number } | null>(null);
  const [jobId, setJobId] = useState<string | null>(params.get('job'));
  const [header, setHeader] = useState<TeacherExam['header'] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [pdfOpts, setPdfOpts] = useState({ withKey: true, withRubrics: true });
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState('');
  const [more, setMore] = useState<Record<QuestionType, number>>({ TEST: 2, DESARROLLO: 1, COMPLETAR: 0, PRACTICO: 0 });
  const [classForBatch, setClassForBatch] = useState('');
  const [keyVersion, setKeyVersion] = useState('A');

  useEffect(() => {
    if (data?.exam) {
      setHeader(data.exam.header);
      setTitle(data.exam.title);
      if (!jobId && data.exam.jobId && !params.get('job')) setJobId(data.exam.jobId);
      if (data.exam.classId) setClassForBatch((c) => c || data.exam.classId!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.exam?.id, data?.exam?.updatedAt]);

  const candidates = useMemo(() => {
    if (!data) return [];
    const inExam = new Set(data.ids);
    const needle = search.trim().toLowerCase();
    return data.bank.filter((q) => !inExam.has(q.id) && (!needle || q.prompt.toLowerCase().includes(needle))).slice(0, 40);
  }, [data, search]);

  if (loading && !data) return <div className="min-h-screen bg-ink-950" />;
  if (!data) {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-100">
        <TeacherHeader title="Examen" />
        <p className="max-w-4xl mx-auto p-6 text-sm text-ink-400">Este examen no existe (o aún no ha llegado desde Hypatia).</p>
      </div>
    );
  }
  const { exam, questions } = data;
  const pending = exam.drafts.filter((d) => d.status === 'pending');
  const total = exam.items.reduce((s, i) => s + Number(i.points || 0), 0);
  const rubricOf = (qid: string): Rubric | undefined => {
    const item = exam.items.find((i) => i.questionId === qid);
    return data.rubrics.find((r) => r.id === item?.rubricId) ?? data.rubrics.find((r) => r.questionId === qid);
  };
  const examRubric = data.rubrics.find((r) => !r.questionId);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg('');
    try { await fn(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const saveHeader = () => run('header', async () => {
    await updateExam(exam.id, (fresh) => ({ ...fresh, title: title.trim() || fresh.title, header: header ?? fresh.header }));
    setMsg('Guardado.');
  });
  const move = (questionId: string, d: number) => void saveExamItems(exam.id, (items) => {
    const next = [...items];
    const i = next.findIndex((x) => x.questionId === questionId);
    const j = i + d;
    if (i < 0 || j < 0 || j >= next.length) return items;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const exportPdf = () => run('pdf', async () => {
    const blob = await generateTeacherExamPDF(exam, questions, data.subjectName, data.rubrics, pdfOpts);
    downloadBlob(blob, `${slugify(exam.title) || 'examen'}.pdf`);
  });

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <TeacherHeader title={exam.title} right={<Button size="sm" variant="secondary" onClick={exportPdf} loading={busy === 'pdf'} disabled={!exam.items.length}>Imprimir PDF</Button>} />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        {jobId && caps.hoard && <JobBanner jobId={jobId} />}
        {exam.notes.length > 0 && <div className="text-xs text-amber-300 flex flex-col gap-1">{exam.notes.map((n, i) => <p key={i}>{n}</p>)}</div>}
        {msg && <p className="text-xs text-ink-300">{msg}</p>}

        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 items-center text-xs text-ink-400">
            <Badge color="amber">{data.subjectName}</Badge>
            <Badge>{exam.items.length} preguntas · {fmt(total)} puntos</Badge>
            <Badge>{exam.versions.length} {exam.versions.length === 1 ? 'versión' : 'versiones'}</Badge>
            {exam.practiceExamId && <Badge color="sage">También en Exámenes de la asignatura (practicable)</Badge>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Input label="Centro" value={header?.centre ?? ''} onChange={(e) => setHeader({ ...(header ?? exam.header), centre: e.target.value })} />
            <Input label="Curso / grupo" value={header?.course ?? ''} onChange={(e) => setHeader({ ...(header ?? exam.header), course: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input label="Fecha" type="date" value={header?.date ?? ''} onChange={(e) => setHeader({ ...(header ?? exam.header), date: e.target.value })} />
              <Input label="Duración (min)" type="number" value={header?.durationMin ?? ''} onChange={(e) => setHeader({ ...(header ?? exam.header), durationMin: Number(e.target.value) || null })} />
            </div>
          </div>
          <Textarea label="Instrucciones" rows={2} value={header?.instructions ?? ''} onChange={(e) => setHeader({ ...(header ?? exam.header), instructions: e.target.value })} />
          <div className="flex flex-wrap gap-2 justify-end items-center">
            <Select aria-label="Versiones" value={String(exam.spec.versions)} onChange={(e) => void run('v', async () => {
              const versions = Number(e.target.value);
              await updateExam(exam.id, (fresh) => ({ ...fresh, spec: { ...fresh.spec, versions } }));
            })}>
              <option value="1">Solo A</option><option value="2">A y B</option><option value="3">A, B y C</option><option value="4">A–D</option>
            </Select>
            <Button size="sm" onClick={saveHeader} loading={busy === 'header'}>Guardar cabecera</Button>
          </div>
        </Card>

        {pending.length > 0 && (
          <Card className="flex flex-col gap-3 border-amber-500/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base text-ink-100">Borradores del modelo ({pending.length})</h2>
              <Button size="sm" onClick={() => run('drafts', async () => {
                const res = await reviewDrafts(exam.id, pending.map((d) => d.id), []);
                setMsg(`${res.added} preguntas nuevas en el banco y en el examen.`);
              })} loading={busy === 'drafts'}>Aprobar todos</Button>
            </div>
            <p className="text-xs text-ink-500">Nada entra en el banco hasta que lo apruebas. Cada borrador cita el pasaje de tu material del que sale.</p>
            {pending.map((d) => (
              <div key={d.id} className="rounded-lg border border-ink-700 p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2"><TypeBadge type={d.type} /><span className="text-xs text-ink-500">{fmt(d.points)} p · {data.topics.get(d.topicId ?? '') ?? 'Sin tema'}</span></div>
                <MdContent content={d.question.prompt} className="prose prose-invert prose-sm max-w-none" />
                {d.question.options && (
                  <ul className="text-sm text-ink-300 pl-4">
                    {d.question.options.map((o) => <li key={o.id} className={d.question.correctOptionIds?.includes(o.id) ? 'text-sage-400' : ''}>{o.id}) {o.text}</li>)}
                  </ul>
                )}
                {d.question.modelAnswer && <p className="text-xs text-ink-400"><span className="text-ink-300">Respuesta modelo:</span> {d.question.modelAnswer}</p>}
                {d.question.clozeText && <p className="text-xs text-ink-400">{d.question.clozeText} → {(d.question.blanks ?? []).map((b) => b.accepted.join(' / ')).join(' | ')}</p>}
                <div className="text-xs text-ink-400 border-l-2 border-amber-500/50 pl-2">
                  {d.citations.map((c) => (
                    <p key={`q${c.n}`}><span className="text-ink-300">Fuente:</span> {c.filename}{c.page ? `, p. ${c.page}` : ''} — «{c.snippet}»</p>
                  ))}
                  {(d.answerCitations ?? []).filter((c) => !d.citations.some((x) => x.n === c.n)).map((c) => (
                    <p key={`a${c.n}`}><span className="text-ink-300">Respuesta en:</span> {c.filename}{c.page ? `, p. ${c.page}` : ''} — «{c.snippet}»</p>
                  ))}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => run('d', async () => { await reviewDrafts(exam.id, [], [d.id]); })}>Rechazar</Button>
                  <Button size="sm" onClick={() => run('d', async () => { await reviewDrafts(exam.id, [d.id], []); })}>Aprobar</Button>
                </div>
              </div>
            ))}
          </Card>
        )}

        <Card className="flex flex-col gap-3" >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base text-ink-100" id="rubricas">Preguntas</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setRubricFor({ q: null, points: 1 })}>{examRubric ? 'Rúbrica del examen ✓' : 'Rúbrica del examen'}</Button>
              <Button size="sm" variant="secondary" onClick={() => setPicker((v) => !v)}>{picker ? 'Cerrar banco' : '+ Del banco'}</Button>
            </div>
          </div>
          {picker && (
            <div className="rounded-lg border border-ink-700 p-2 flex flex-col gap-2">
              <Input placeholder="Buscar en el banco de la asignatura" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
                {candidates.map((q) => (
                  <button key={q.id} className="text-left text-xs text-ink-300 hover:bg-ink-700 rounded px-2 py-1.5 flex gap-2 items-start"
                    onClick={() => void saveExamItems(exam.id, (items) => (items.some((x) => x.questionId === q.id) ? items : [...items, { questionId: q.id, points: q.type === 'TEST' || q.type === 'COMPLETAR' ? 1 : 2 }]))}>
                    <span className="text-amber-400 shrink-0">{TYPE_SHORT[q.type]}</span><span className="line-clamp-2">{q.prompt}</span>
                  </button>
                ))}
                {!candidates.length && <p className="text-xs text-ink-500 px-2">No hay más preguntas que coincidan.</p>}
              </div>
            </div>
          )}
          {exam.items.map((item, i) => {
            const q = questions[item.questionId];
            const rub = rubricOf(item.questionId);
            return (
              <div key={item.questionId} className="rounded-lg border border-ink-700 p-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-300">{i + 1}.</span>
                  {q ? <TypeBadge type={q.type} /> : <Badge color="rose">Pregunta borrada</Badge>}
                  <span className="text-xs text-ink-500 truncate">{data.topics.get(q?.topicId ?? '') ?? ''}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <input aria-label="Puntos" type="number" min={0} step={0.25} defaultValue={item.points} key={`${item.questionId}:${item.points}`}
                      onBlur={(e) => {
                        const points = Math.max(0, Number(e.target.value) || 0);
                        if (points !== item.points) void saveExamItems(exam.id, (items) => items.map((x) => (x.questionId === item.questionId ? { ...x, points } : x)));
                      }}
                      className="w-16 bg-ink-800 border border-ink-600 rounded px-2 py-0.5 text-sm text-ink-100" />
                    <span className="text-xs text-ink-500">p</span>
                    <button className="text-ink-400 hover:text-ink-100 px-1" title="Subir" onClick={() => move(item.questionId, -1)}>↑</button>
                    <button className="text-ink-400 hover:text-ink-100 px-1" title="Bajar" onClick={() => move(item.questionId, 1)}>↓</button>
                    <button className="text-rose-400 hover:text-rose-300 px-1" title="Quitar" onClick={() => void saveExamItems(exam.id, (items) => items.filter((x) => x.questionId !== item.questionId))}>✕</button>
                  </div>
                </div>
                {q && <MdContent content={q.prompt} className="prose prose-invert prose-sm max-w-none" />}
                {q && (q.type === 'DESARROLLO' || q.type === 'PRACTICO') && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={rub ? 'secondary' : 'primary'} onClick={() => setRubricFor({ q, points: item.points })}>
                      {rub ? `Rúbrica · ${rub.criteria.length} criterios` : examRubric ? 'Usa la del examen · crear propia' : 'Añadir rúbrica'}
                    </Button>
                    {rub?.origin === 'llm' && <Badge color="blue">propuesta por el modelo, revisada</Badge>}
                  </div>
                )}
              </div>
            );
          })}
          {!exam.items.length && <p className="text-xs text-ink-500">Sin preguntas: añádelas del banco o aprueba borradores.</p>}
        </Card>

        {caps.hoard && (
          <Card className="flex flex-col gap-2">
            <h2 className="font-display text-base text-ink-100">Más preguntas con IA desde tu material</h2>
            <div className="flex flex-wrap gap-2 items-end">
              {QTYPES.map((t) => (
                <label key={t} className="text-xs text-ink-300 flex flex-col gap-1">{TYPE_SHORT[t]}
                  <input type="number" min={0} max={20} value={more[t]} onChange={(e) => setMore({ ...more, [t]: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-16 bg-ink-800 border border-ink-600 rounded px-2 py-1 text-sm text-ink-100" />
                </label>
              ))}
              <Button size="sm" disabled={!caps.llm || !QTYPES.some((t) => more[t] > 0)} loading={busy === 'gen'}
                onClick={() => run('gen', async () => { setJobId((await startGeneration(exam.id, more)).id); })}>Generar borradores</Button>
            </div>
            {!caps.llm && <p className="text-xs text-ink-500">No hay modelo local cargado: no se puede generar.</p>}
          </Card>
        )}

        {exam.items.length > 0 && (
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base text-ink-100">Solucionario</h2>
              <div className="flex gap-1">
                {exam.versions.map((v) => (
                  <button key={v.label} onClick={() => setKeyVersion(v.label)}
                    className={`px-2.5 py-1 rounded-md text-xs ${keyVersion === v.label ? 'bg-amber-500 text-ink-900' : 'text-ink-400 border border-ink-700'}`}>Versión {v.label}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {answerKey(exam, questions, keyVersion).map((r) => (
                    <tr key={r.position} className="border-b border-ink-800 align-top">
                      <td className="py-1 pr-2 text-ink-500 text-xs">{r.position}</td>
                      <td className="pr-2 text-xs text-ink-400">{TYPE_SHORT[r.type ?? ''] ?? ''}</td>
                      <td className="text-xs text-ink-200">
                        {r.letters ? r.letters.join(', ') : r.blanks ? Object.values(r.blanks).map((v) => v.join(' / ')).join(' | ') : (r.modelAnswer ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-3 items-center text-xs text-ink-300">
              <label className="flex items-center gap-1"><input type="checkbox" checked={pdfOpts.withKey} onChange={(e) => setPdfOpts({ ...pdfOpts, withKey: e.target.checked })} /> Solucionario en el PDF</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={pdfOpts.withRubrics} onChange={(e) => setPdfOpts({ ...pdfOpts, withRubrics: e.target.checked })} /> Rúbricas en el PDF</label>
              <Button size="sm" variant="secondary" onClick={exportPdf} loading={busy === 'pdf'}>Imprimir PDF</Button>
            </div>
          </Card>
        )}

        <Card className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1"><Select label="Corregir con la clase" value={classForBatch} onChange={(e) => setClassForBatch(e.target.value)}>
            <option value="">—</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select></div>
          <Button disabled={!classForBatch || !exam.items.length} onClick={() => run('batch', async () => {
            const klass = classes.find((c) => c.id === classForBatch);
            if (klass) navigate(`/teacher/batch/${(await batchRepo.create(exam, klass)).id}`);
          })}>Nueva entrega</Button>
          <Button variant="danger" onClick={async () => {
            if (confirm('¿Borrar este examen del profesor con sus rúbricas y entregas? (La copia practicable de la asignatura se queda.)')) {
              await teacherExamRepo.delete(exam.id);
              navigate('/teacher?tab=examenes');
            }
          }}>Borrar examen</Button>
        </Card>
      </main>
      {rubricFor && (
        <RubricEditor open onClose={() => setRubricFor(null)} exam={exam} question={rubricFor.q} points={rubricFor.points} caps={caps} />
      )}
    </div>
  );
}
