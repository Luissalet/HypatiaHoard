/**
 * Una entrega (examen + clase): respuestas (rejilla, CSV, texto/PDF/foto), corrección
 * con IA contra la rúbrica, revisión lado a lado (respuesta | rúbrica | propuesta),
 * confirmación por alumno, notas en CSV y feedback en PDF. Nada es definitivo hasta
 * que el profesor confirma.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, Button, Card, Modal, Select, Tabs, Textarea, TypeBadge } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { submissionRepo, batchRepo } from '@/data/teacherRepo';
import {
  acceptAllProposals, confirmSubmission, decisionFromProposal, loadBatchContext, proposalFor, rubricFor, setDecision,
  unconfirmSubmission, type BatchContext,
} from '@/data/teacherBatch';
import { startGrading, transcribeImage } from '@/data/teacherClient';
import {
  OPEN_TYPES, findVersion, gradesCsv, gridAnswers, itemPoints, matchStudent, parseAnswerGrid, rubricBreakdown,
  scoreObjective, splitBlanks, submissionResult,
} from '@/domain/teacherCore';
import type { Decision, Rubric, StoredAnswer, Submission } from '@/domain/teacher';
import type { Question } from '@/domain/models';
import { generateFeedbackPDF } from '@/utils/teacherPdf';
import { downloadBlob } from '@/utils/pdfExport';
import { slugify } from '@/domain/normalize';
import { CommitInput, CommitTextarea, JobBanner, TeacherHeader, downloadText, fmt, useLoad, useModelCaps, useTeacherTick } from './shared';

const TABS = [
  { id: 'respuestas', label: 'Respuestas' },
  { id: 'revision', label: 'Revisión' },
  { id: 'notas', label: 'Notas' },
];

function answerText(a?: StoredAnswer): string {
  if (!a) return '';
  if (a.text) return a.text;
  if (a.letters) return a.letters;
  if (a.blankAnswers) return Object.values(a.blankAnswers).join('; ');
  return '';
}

export function GradingBatchPage() {
  const { batchId = '' } = useParams();
  const tick = useTeacherTick();
  const caps = useModelCaps();
  const [ctx, loading] = useLoad(() => loadBatchContext(batchId), [batchId, tick], null as BatchContext | null);
  const [tab, setTab] = useState('respuestas');
  const [jobId, setJobId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  if (loading && !ctx) return <div className="min-h-screen bg-ink-950" />;
  if (!ctx) {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-100">
        <TeacherHeader title="Entrega" />
        <p className="max-w-4xl mx-auto p-6 text-sm text-ink-400">Esta entrega no existe (o su examen se borró).</p>
      </div>
    );
  }
  const confirmed = ctx.submissions.filter((s) => s.confirmed).length;
  const openItems = ctx.exam.items.filter((i) => OPEN_TYPES.includes(ctx.questions[i.questionId]?.type ?? ''));
  const missingRubric = openItems.filter((i) => !rubricFor(ctx, i.questionId)).length;
  const grade = async () => {
    setMsg('');
    try {
      setJobId((await startGrading(ctx.batch.id)).id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <TeacherHeader title={ctx.batch.title} />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="amber">{ctx.exam.title}</Badge>
          <Badge>{ctx.submissions.length} alumnos</Badge>
          <Badge color={confirmed === ctx.submissions.length && confirmed ? 'sage' : 'ink'}>{confirmed} notas confirmadas</Badge>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={async () => {
              const n = await batchRepo.addMissingStudents(ctx.batch, ctx.exam);
              setMsg(n ? `${n} alumnos nuevos añadidos.` : 'Todos los alumnos de la clase ya están.');
            }}>Actualizar alumnos</Button>
            <Button size="sm" onClick={grade} disabled={!caps.hoard || !caps.llm || !openItems.length}
              title={!caps.hoard ? 'Necesita Hypatia (servidor local)' : !caps.llm ? 'No hay modelo local cargado' : 'Propuestas por criterio, con citas literales comprobadas'}>
              Corregir con IA
            </Button>
          </div>
        </div>
        {!caps.hoard && openItems.length > 0 && <p className="text-xs text-ink-500">Sin Hypatia (servidor local) las preguntas abiertas se puntúan a mano en Revisión.</p>}
        {caps.hoard && !caps.llm && openItems.length > 0 && <p className="text-xs text-ink-500">No hay modelo local cargado: puntúa a mano en Revisión o carga un modelo.</p>}
        {missingRubric > 0 && <p className="text-xs text-amber-300">{missingRubric} preguntas abiertas sin rúbrica: la IA no las corrige hasta que tengan una (en el examen).</p>}
        {jobId && <JobBanner jobId={jobId} />}
        {msg && <p className="text-xs text-ink-300">{msg}</p>}
        <Tabs tabs={TABS} active={tab} onChange={setTab} />
        {tab === 'respuestas' && <AnswersTab ctx={ctx} caps={caps} />}
        {tab === 'revision' && <ReviewTab ctx={ctx} />}
        {tab === 'notas' && <GradesTab ctx={ctx} />}
      </main>
    </div>
  );
}

// ─── Respuestas ──────────────────────────────────────────────────────────────

function AnswersTab({ ctx, caps }: { ctx: BatchContext; caps: ReturnType<typeof useModelCaps> }) {
  const n = ctx.exam.items.length;
  const labels = ctx.exam.versions.map((v) => v.label);
  const [csv, setCsv] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const penalty = Number(ctx.exam.spec.testPenalty || 0);

  const saveCell = async (sub: Submission, qid: string, raw: string) => {
    const q = ctx.questions[qid];
    let entry: StoredAnswer | undefined;
    if (!raw.trim()) entry = undefined;
    else if (q?.type === 'TEST') entry = { letters: raw.trim().toLowerCase(), source: 'grid' };
    else if (q?.type === 'COMPLETAR') entry = { blankAnswers: splitBlanks(raw, q.blanks ?? []), source: 'grid' };
    else entry = { text: raw, source: 'text' };
    if (answerText(sub.answers?.[qid]) === answerText(entry)) return;
    await submissionRepo.update(sub.id, (fresh) => {
      const answers = { ...(fresh.answers ?? {}) };
      if (entry) answers[qid] = entry; else delete answers[qid];
      return { ...fresh, answers, confirmed: false, result: undefined, feedback: undefined };
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 items-center">
        <p className="text-xs text-ink-400 flex-1">Rejilla por número de pregunta impreso en la versión de cada alumno: test con letras («b», «a,c»), completar con «x; y». Las abiertas, con ✎.</p>
        <Button size="sm" variant="secondary" onClick={() => setCsv(true)}>Pegar CSV</Button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-ink-700">
        <table className="text-sm">
          <thead>
            <tr className="bg-ink-850 text-xs text-ink-400">
              <th className="sticky left-0 bg-ink-850 text-left px-2 py-2 min-w-[140px]">Alumno</th>
              <th className="px-1">Ver.</th>
              {Array.from({ length: n }, (_, i) => <th key={i} className="px-1 min-w-[52px]">{i + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {ctx.submissions.map((sub) => {
              const version = findVersion(ctx.exam, sub.version);
              return (
                <tr key={sub.id} className="border-t border-ink-800">
                  <td className="sticky left-0 bg-ink-900 px-2 py-1 text-ink-200 text-xs whitespace-nowrap">
                    {ctx.students[sub.studentId]?.displayName ?? '?'} {sub.confirmed && <span className="text-sage-400">✓</span>}
                  </td>
                  <td className="px-1">
                    <select aria-label="Versión" value={sub.version} onChange={(e) => { const version = e.target.value; void submissionRepo.update(sub.id, (fresh) => ({ ...fresh, version })); }}
                      className="bg-ink-800 border border-ink-600 rounded text-xs text-ink-100 px-1 py-0.5">
                      {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </td>
                  {version.questionOrder.map((qid, p) => {
                    const q = ctx.questions[qid];
                    const item = ctx.exam.items.find((i) => i.questionId === qid);
                    if (!q) return <td key={p} />;
                    if (OPEN_TYPES.includes(q.type)) {
                      const has = !!answerText(sub.answers?.[qid]).trim();
                      return (
                        <td key={p} className="px-1 text-center">
                          <button title="Respuesta abierta" onClick={() => setOpenFor(sub.id)}
                            className={`w-full rounded px-1 py-0.5 text-xs border ${has ? 'border-sage-500/50 text-sage-400' : 'border-ink-600 text-ink-500'}`}>{has ? '✓' : '✎'}</button>
                        </td>
                      );
                    }
                    const score = scoreObjective(q, sub.answers?.[qid], Number(item?.points || 0), version, penalty);
                    const tone = score?.result === 'CORRECT' ? 'border-sage-500/60 text-sage-300' : score?.result === 'WRONG' || score?.result === 'INVALID' ? 'border-rose-500/60 text-rose-300' : 'border-ink-600 text-ink-100';
                    return (
                      <td key={p} className="px-1">
                        <CommitInput aria-label={`Pregunta ${p + 1}`} stored={answerText(sub.answers?.[qid])}
                          onCommit={(v) => void saveCell(sub, qid, v)}
                          className={`w-full min-w-[44px] bg-ink-800 border rounded px-1 py-0.5 text-xs text-center ${tone}`} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {csv && <CsvModal ctx={ctx} onClose={() => setCsv(false)} />}
      {openFor && <OpenAnswersModal ctx={ctx} subId={openFor} caps={caps} onClose={() => setOpenFor(null)} />}
    </div>
  );
}

function CsvModal({ ctx, onClose }: { ctx: BatchContext; onClose: () => void }) {
  const [text, setText] = useState('');
  const [report, setReport] = useState('');
  const parsed = useMemo(() => parseAnswerGrid(text), [text]);
  const apply = async () => {
    let updated = 0;
    const unmatched: string[] = [];
    for (const row of parsed.rows) {
      const student = matchStudent(row.student, ctx.roster);
      const sub = student && ctx.submissions.find((s) => s.studentId === student.id);
      if (!sub) { unmatched.push(row.student); continue; }
      await submissionRepo.update(sub.id, (fresh) => {
        const version = ctx.exam.versions.some((v) => v.label === row.version) ? row.version : fresh.version;
        const incoming = gridAnswers(ctx.exam, ctx.questions, version, row.cells);
        for (const a of Object.values(incoming)) a.source = 'csv';
        return { ...fresh, version, answers: { ...(fresh.answers ?? {}), ...incoming }, confirmed: false, result: undefined, feedback: undefined };
      });
      updated++;
    }
    setReport(`${updated} alumnos actualizados${unmatched.length ? ` · sin encontrar: ${unmatched.join(', ')}` : ''}${parsed.errors.length ? ` · ${parsed.errors.join(' ')}` : ''}`);
  };
  return (
    <Modal open onClose={onClose} title="Pegar respuestas (CSV)" size="lg">
      <div className="flex flex-col gap-3">
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'alumno;version;1;2;3\nAna Ejemplo;A;b;a,c;rojo; azul'} />
        <p className="text-xs text-ink-400">{parsed.rows.length} filas. Columnas: alumno (como en la lista de clase), versión opcional y una por número de pregunta.</p>
        {report && <p className="text-xs text-sage-400">{report}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cerrar</Button>
          <Button size="sm" onClick={apply} disabled={!parsed.rows.length}>Aplicar</Button>
        </div>
      </div>
    </Modal>
  );
}

function OpenAnswersModal({ ctx, subId, caps, onClose }: { ctx: BatchContext; subId: string; caps: ReturnType<typeof useModelCaps>; onClose: () => void }) {
  const [sub, setSub] = useState<Submission | undefined>(() => ctx.submissions.find((s) => s.id === subId));
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  if (!sub) return null;
  const version = findVersion(ctx.exam, sub.version);
  const open = version.questionOrder.map((qid, i) => ({ qid, pos: i + 1, q: ctx.questions[qid] })).filter((x) => x.q && OPEN_TYPES.includes(x.q.type));
  const save = async (qid: string, text: string, source: StoredAnswer['source'], fileName?: string) => {
    if (answerText(sub.answers?.[qid]) === text && (sub.answers?.[qid]?.source ?? source) === source) return;
    setSub(await submissionRepo.update(sub.id, (fresh) => {
      const answers = { ...(fresh.answers ?? {}) };
      if (text.trim()) answers[qid] = { text, source, ...(fileName ? { fileName } : {}) };
      else delete answers[qid];
      return { ...fresh, answers, confirmed: false, result: undefined, feedback: undefined };
    }));
  };
  const fromPdf = async (qid: string, file: File) => {
    setBusy(qid);
    setNote('');
    try {
      const { extractPdfText } = await import('@/utils/pdfTextExtractor');
      const url = URL.createObjectURL(file);
      const res = await extractPdfText(url);
      URL.revokeObjectURL(url);
      const text = res.blocks.map((b) => b.text).join('\n').trim();
      if (!text) setNote('El PDF no tiene texto seleccionable (¿es un escaneo?): usa «Foto» o escribe la respuesta.');
      else await save(qid, text, 'pdf', file.name);
    } catch (e) {
      setNote(`No se pudo leer el PDF: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(''); }
  };
  const fromPhoto = async (qid: string, file: File) => {
    setBusy(qid);
    setNote('');
    try {
      const res = await transcribeImage(file);
      if (res.status === 'ok' && res.text) {
        await save(qid, res.text, 'photo', file.name);
        setNote(res.note ?? '');
      } else setNote(res.note ?? 'No hay modelo de visión: escribe o pega el texto.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  };
  return (
    <Modal open onClose={onClose} title={`Respuestas abiertas · ${ctx.students[sub.studentId]?.displayName ?? ''}`} size="xl">
      <div className="flex flex-col gap-4">
        {note && <p className="text-xs text-amber-300">{note}</p>}
        {open.map(({ qid, pos, q }) => (
          <div key={qid} className="flex flex-col gap-2">
            <div className="flex items-center gap-2"><span className="text-sm text-ink-300">{pos}.</span><TypeBadge type={q!.type} /></div>
            <MdContent content={q!.prompt} className="prose prose-invert prose-sm max-w-none text-ink-300" />
            <CommitTextarea stored={answerText(sub.answers?.[qid])} rows={5}
              onCommit={(v) => void save(qid, v, sub.answers?.[qid]?.source ?? 'text', sub.answers?.[qid]?.fileName)}
              className="bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm text-ink-100" placeholder="Pega o escribe la respuesta del alumno" />
            <div className="flex flex-wrap gap-2 items-center text-xs">
              <label className="cursor-pointer text-ink-300 border border-ink-600 rounded px-2 py-1 hover:border-ink-400">
                Subir PDF<input type="file" accept="application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromPdf(qid, f); e.target.value = ''; }} />
              </label>
              <label className={`border rounded px-2 py-1 ${caps.hoard && caps.vision ? 'cursor-pointer text-ink-300 border-ink-600 hover:border-ink-400' : 'text-ink-600 border-ink-700 cursor-not-allowed'}`}
                title={caps.hoard && caps.vision ? 'Transcribe la foto con el modelo de visión' : 'No hay modelo de visión: escribe la respuesta'}>
                Foto<input type="file" accept="image/*" className="hidden" disabled={!(caps.hoard && caps.vision)} onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromPhoto(qid, f); e.target.value = ''; }} />
              </label>
              {busy === qid && <span className="text-ink-400">Leyendo…</span>}
              {sub.answers?.[qid]?.source && <span className="text-ink-500">origen: {sub.answers[qid].source}{sub.answers[qid].fileName ? ` · ${sub.answers[qid].fileName}` : ''}</span>}
            </div>
          </div>
        ))}
        {!open.length && <p className="text-xs text-ink-500">Este examen no tiene preguntas abiertas.</p>}
      </div>
    </Modal>
  );
}

// ─── Revisión ────────────────────────────────────────────────────────────────

function highlight(text: string, quotes: string[]): ReactNode {
  const parts = quotes.filter((q) => q.trim().length >= 3)
    .map((q) => q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  if (!parts.length) return text;
  const re = new RegExp(`(${parts.join('|')})`, 'gi');
  return text.split(re).map((piece, i) => (i % 2 ? <mark key={i} className="bg-amber-500/30 text-ink-100 rounded px-0.5">{piece}</mark> : piece));
}

function ReviewTab({ ctx }: { ctx: BatchContext }) {
  const [subId, setSubId] = useState(ctx.submissions.find((s) => !s.confirmed)?.id ?? ctx.submissions[0]?.id ?? '');
  const sub = ctx.submissions.find((s) => s.id === subId);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {ctx.submissions.map((s) => {
          const res = submissionResult(ctx.exam, ctx.questions, s, ctx.scale);
          return (
            <button key={s.id} onClick={() => setSubId(s.id)}
              className={`px-2.5 py-1 rounded-lg text-xs border ${s.id === subId ? 'border-amber-500 bg-amber-500/15 text-amber-200' : s.confirmed ? 'border-sage-600/50 text-sage-300' : 'border-ink-600 text-ink-300'}`}>
              {ctx.students[s.studentId]?.displayName ?? '?'} {s.confirmed ? `· ${fmt(s.result?.grade)}` : res.pending.length ? `· ${res.pending.length} pend.` : '· listo'}
            </button>
          );
        })}
      </div>
      {sub && <StudentReview key={sub.id} ctx={ctx} sub={sub} />}
    </div>
  );
}

function StudentReview({ ctx, sub }: { ctx: BatchContext; sub: Submission }) {
  const version = findVersion(ctx.exam, sub.version);
  const rows = itemPoints(ctx.exam, ctx.questions, sub);
  const byQ = new Map(rows.map((r) => [r.questionId, r]));
  const result = submissionResult(ctx.exam, ctx.questions, sub, ctx.scale);
  const [comment, setComment] = useState(sub.comment ?? '');
  const [error, setError] = useState('');
  const confirmNow = async () => {
    setError('');
    try { await confirmSubmission(ctx, sub, comment); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const exportOne = async () => {
    if (!sub.result || !sub.feedback) return;
    const blob = await generateFeedbackPDF(ctx.exam, '', [{ student: ctx.students[sub.studentId]?.displayName ?? '', version: sub.version, result: sub.result, feedback: sub.feedback, comment: sub.comment }]);
    downloadBlob(blob, `feedback-${slugify(ctx.students[sub.studentId]?.displayName ?? 'alumno')}.pdf`);
  };
  return (
    <div className="flex flex-col gap-3">
      {version.questionOrder.map((qid, i) => {
        const q = ctx.questions[qid];
        const r = byQ.get(qid);
        if (!q || !r) return null;
        return OPEN_TYPES.includes(q.type)
          ? <OpenReview key={qid} ctx={ctx} sub={sub} q={q} pos={i + 1} maxPoints={r.maxPoints} decision={r.decision} />
          : <ObjectiveReview key={qid} sub={sub} q={q} pos={i + 1} row={r} />;
      })}
      <Card className="flex flex-col gap-3 !p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-200">{fmt(result.points)} / {fmt(result.maxPoints)} puntos</span>
          <span className="font-display text-lg text-amber-300">{fmt(result.grade)}</span>
          <span className="text-ink-300">{result.band}</span>
          {result.pending.length > 0 && <Badge color="amber">{result.pending.length} por puntuar</Badge>}
          {sub.confirmed && <Badge color="sage">Confirmada</Badge>}
        </div>
        <Textarea rows={2} label="Comentario para el alumno" value={comment} onChange={(e) => setComment(e.target.value)} />
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <div className="flex flex-wrap gap-2 justify-end">
          {!sub.confirmed && <Button size="sm" variant="secondary" onClick={() => void acceptAllProposals(ctx, sub)}>Aceptar todas las propuestas</Button>}
          {sub.confirmed
            ? <><Button size="sm" variant="secondary" onClick={exportOne}>PDF de feedback</Button><Button size="sm" variant="ghost" onClick={() => void unconfirmSubmission(sub)}>Reabrir</Button></>
            : <Button size="sm" onClick={confirmNow} disabled={!result.complete}>Confirmar nota</Button>}
        </div>
        {sub.confirmed && sub.feedback && (
          <div className="grid gap-2 sm:grid-cols-3 text-xs text-ink-300">
            <div><p className="text-ink-400 uppercase tracking-widest mb-1">Bien</p>{sub.feedback.strengths.map((s) => <p key={s.questionId}>P{s.position} · {s.prompt}</p>)}</div>
            <div><p className="text-ink-400 uppercase tracking-widest mb-1">Errores</p>{sub.feedback.mistakes.map((m) => <p key={m.questionId}>P{m.position} · {m.detail}</p>)}</div>
            <div><p className="text-ink-400 uppercase tracking-widest mb-1">Repasar</p>{sub.feedback.review.map((t) => <p key={t.topicId ?? 'x'}>{t.topic ?? 'Sin tema'} ({Math.round(t.ratio * 100)} %){t.keyConcepts.length ? `: ${t.keyConcepts.map((k) => k.title).join(', ')}` : ''}</p>)}</div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ObjectiveReview({ sub, q, pos, row }: { sub: Submission; q: Question; pos: number; row: ReturnType<typeof itemPoints>[number] }) {
  const auto = row.auto;
  const label = auto?.result === 'CORRECT' ? 'Correcta' : auto?.result === 'WRONG' ? 'Incorrecta' : auto?.result === 'INVALID' ? 'Letra inválida' : 'En blanco';
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-400 text-xs">{pos}.</span><TypeBadge type={q.type} />
      <span className="text-ink-300 text-xs truncate max-w-[40ch]">{q.prompt}</span>
      <span className="text-xs text-ink-400">Respuesta: <span className="text-ink-200">{answerText(sub.answers?.[q.id]) || '—'}</span></span>
      <Badge color={auto?.result === 'CORRECT' ? 'sage' : auto?.result === 'BLANK' ? 'ink' : 'rose'}>{label}</Badge>
      <div className="ml-auto flex items-center gap-1 text-xs">
        <CommitInput aria-label="Puntos" type="number" step={0.25} stored={row.points === null ? '' : String(row.points)}
          onCommit={(raw) => {
            const v = raw === '' ? null : Number(raw);
            const same = v === (auto?.points ?? null) && !row.decision;
            if (same) return;
            void setDecision(sub, q.id, v === null ? null : { points: Math.min(row.maxPoints, v), source: 'override' });
          }}
          className="w-16 bg-ink-900 border border-ink-600 rounded px-2 py-0.5 text-ink-100" />
        <span className="text-ink-500">/ {fmt(row.maxPoints)}</span>
        {row.decision && <span className="text-amber-300" title="Puntos cambiados a mano">✎</span>}
      </div>
    </div>
  );
}

function OpenReview({ ctx, sub, q, pos, maxPoints, decision }: { ctx: BatchContext; sub: Submission; q: Question; pos: number; maxPoints: number; decision: Decision | null }) {
  const rubric: Rubric | undefined = rubricFor(ctx, q.id);
  const proposal = proposalFor(ctx, sub, q.id);
  const text = answerText(sub.answers?.[q.id]);
  const quotes = (proposal?.criteria ?? []).flatMap((c) => c.quotes ?? []);
  const initial: Record<string, string> = {};
  for (const c of (decision?.criteria ?? proposal?.criteria ?? [])) if (c.levelId) initial[c.criterionId] = c.levelId;
  const [selected, setSelected] = useState<Record<string, string>>(initial);
  const [manual, setManual] = useState<string>(decision?.points !== undefined ? String(decision.points) : '');
  /** Elegir un nivel en cada criterio puntúa la pregunta con la rúbrica (cuenta como decisión del profesor). */
  const pick = (criterionId: string, levelId: string) => {
    if (!rubric) return;
    const next = { ...selected, [criterionId]: levelId };
    setSelected(next);
    const b = rubricBreakdown(rubric, next, maxPoints);
    if (b.complete) {
      void setDecision(sub, q.id, { points: b.points, rubricId: rubric.id, criteria: b.criteria, comment: decision?.comment ?? proposal?.comment ?? null, source: 'override' });
    }
  };
  return (
    <Card className="!p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-300">{pos}.</span><TypeBadge type={q.type} />
        <span className="text-xs text-ink-500">{fmt(maxPoints)} puntos</span>
        {decision ? <Badge color={decision.source === 'proposal' ? 'blue' : 'amber'}>{fmt(decision.points)} p · {decision.source === 'proposal' ? 'propuesta aceptada' : 'puntuado a mano'}</Badge> : <Badge>Sin decidir</Badge>}
      </div>
      <MdContent content={q.prompt} className="prose prose-invert prose-sm max-w-none text-ink-300" />
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3">
          <p className="text-xs text-ink-400 uppercase tracking-widest mb-1">Respuesta</p>
          <p className="text-sm text-ink-200 whitespace-pre-wrap">{text ? highlight(text, quotes) : <span className="text-ink-500">En blanco</span>}</p>
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3">
          <p className="text-xs text-ink-400 uppercase tracking-widest mb-1">Rúbrica</p>
          {!rubric && <p className="text-xs text-amber-300">Sin rúbrica: puntúa a mano o crea una en el examen.</p>}
          {rubric?.criteria.map((c) => (
            <div key={c.id} className="mb-2">
              <p className="text-xs text-ink-200 font-medium">{c.name} <span className="text-ink-500">({c.weight})</span></p>
              <div className="flex flex-col gap-1 mt-1">
                {c.levels.map((l) => (
                  <button key={l.id} onClick={() => pick(c.id, l.id)} disabled={sub.confirmed}
                    className={`text-left text-xs rounded px-2 py-1 border ${selected[c.id] === l.id ? 'border-amber-500 bg-amber-500/15 text-amber-200' : 'border-ink-700 text-ink-300 hover:border-ink-500'}`}>
                    <span className="text-ink-400">{fmt(l.points)}</span> · {l.descriptor}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3 flex flex-col gap-2">
          <p className="text-xs text-ink-400 uppercase tracking-widest">Propuesta del modelo</p>
          {!proposal && <p className="text-xs text-ink-500">Sin propuesta (usa «Corregir con IA» o puntúa a mano).</p>}
          {proposal && (
            <>
              <p className="text-sm text-ink-100">{proposal.points !== null ? `${fmt(proposal.points)} / ${fmt(proposal.maxPoints)} p` : 'Incompleta'}
                {proposal.confidence !== null && <span className="text-xs text-ink-400"> · confianza {Math.round((proposal.confidence ?? 0) * 100)} %</span>}</p>
              {proposal.criteria.map((c) => {
                const crit = rubric?.criteria.find((x) => x.id === c.criterionId);
                const level = crit?.levels.find((l) => l.id === c.levelId);
                return (
                  <div key={c.criterionId} className="text-xs text-ink-300 border-l-2 border-ink-600 pl-2">
                    <p className="text-ink-200">{crit?.name ?? c.criterionId}: {level?.descriptor ?? '—'} ({fmt(c.points)} p)</p>
                    {c.justification && <p>{c.justification}</p>}
                    {(c.quotes ?? []).map((qt, k) => <p key={k} className="text-amber-200">«{qt}»</p>)}
                  </div>
                );
              })}
              {proposal.comment && <p className="text-xs text-ink-400">Comentario: {proposal.comment}</p>}
              {proposal.note && <p className="text-xs text-amber-300">{proposal.note}</p>}
              {!sub.confirmed && proposal.points !== null && (
                <Button size="sm" onClick={() => { const d = decisionFromProposal(proposal); if (d) void setDecision(sub, q.id, d); }}>Aceptar propuesta</Button>
              )}
            </>
          )}
          {!sub.confirmed && (
            <div className="flex items-center gap-1 text-xs mt-auto">
              <input aria-label="Puntos a mano" type="number" step={0.25} min={0} max={maxPoints} value={manual} onChange={(e) => setManual(e.target.value)}
                className="w-20 bg-ink-800 border border-ink-600 rounded px-2 py-0.5 text-ink-100" />
              <Button size="sm" variant="secondary" disabled={manual === ''} onClick={() => void setDecision(sub, q.id, { points: Math.min(maxPoints, Math.max(0, Number(manual))), source: 'override' })}>Poner puntos</Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Notas ───────────────────────────────────────────────────────────────────

function GradesTab({ ctx }: { ctx: BatchContext }) {
  const rows = ctx.submissions.map((s) => {
    const res = s.confirmed && s.result ? s.result : submissionResult(ctx.exam, ctx.questions, s, ctx.scale);
    return {
      student: ctx.students[s.studentId]?.displayName ?? '?', version: s.version, points: res.points, maxPoints: res.maxPoints,
      grade: s.confirmed ? res.grade : null, band: s.confirmed ? res.band : null, confirmed: s.confirmed, sub: s,
    };
  });
  const confirmed = rows.filter((r) => r.confirmed);
  const exportCsv = () => downloadText(gradesCsv(rows), `notas-${slugify(ctx.batch.title) || 'entrega'}.csv`);
  const exportPdfs = async () => {
    const pages = confirmed.filter((r) => r.sub.result && r.sub.feedback).map((r) => ({
      student: r.student, version: r.version, result: r.sub.result!, feedback: r.sub.feedback!, comment: r.sub.comment,
    }));
    if (!pages.length) return;
    downloadBlob(await generateFeedbackPDF(ctx.exam, '', pages), `feedback-${slugify(ctx.batch.title) || 'entrega'}.pdf`);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 justify-end">
        <Button size="sm" variant="secondary" onClick={exportCsv}>Exportar CSV</Button>
        <Button size="sm" variant="secondary" onClick={exportPdfs} disabled={!confirmed.length}>PDF de feedback ({confirmed.length})</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-xs text-ink-500 border-b border-ink-700">
            <th className="py-1.5 pr-2">Alumno</th><th className="pr-2">Versión</th><th className="pr-2">Puntos</th><th className="pr-2">Nota</th><th className="pr-2">Calificación</th><th>Estado</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sub.id} className="border-b border-ink-800">
                <td className="py-1.5 pr-2 text-ink-200">{r.student}</td>
                <td className="pr-2 text-ink-400">{r.version}</td>
                <td className="pr-2 text-ink-300">{fmt(r.points)} / {fmt(r.maxPoints)}</td>
                <td className="pr-2 text-amber-300 font-medium">{fmt(r.grade)}</td>
                <td className="pr-2 text-ink-300">{r.band ?? '—'}</td>
                <td>{r.confirmed ? <Badge color="sage">Confirmada</Badge> : <Badge>Pendiente</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-500">La nota solo aparece cuando la confirmas. El CSV usa «;» y coma decimal. Estos archivos llevan datos de tus alumnos: guárdalos tú.</p>
    </div>
  );
}

