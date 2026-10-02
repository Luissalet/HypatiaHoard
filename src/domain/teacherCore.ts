/**
 * teacherCore.ts — lógica pura del rol Profesor (sin Dexie, sin red, sin DOM).
 *
 * Gemelo de hypatia/teacher/core.py: escala de notas, versiones A/B con barajado
 * sembrado, puntuación objetiva a partir de las letras impresas, puntos de rúbrica,
 * feedback por alumno, análisis de la clase y los parsers de lista de clase y de
 * rejilla de respuestas. tests/test_teacher_parity_ts.py ejecuta ambos con las
 * mismas entradas: una nota calculada por Faustus y otra en la app coinciden.
 */

import type { Question } from './models';
import type {
  Decision, ExamItem, ExamVersion, Feedback, FeedbackEntry, GradeScale, Rubric, StoredAnswer, SubmissionResult,
} from './teacher';
import { normalizeText } from './normalize';

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const VERSION_LABELS = 'ABCD';
export const OBJECTIVE_TYPES = ['TEST', 'COMPLETAR'];
export const OPEN_TYPES = ['DESARROLLO', 'PRACTICO'];

export const DEFAULT_SCALE: GradeScale = {
  max: 10,
  decimals: 1,
  bands: [
    { min: 0, label: 'Suspenso' },
    { min: 5, label: 'Aprobado' },
    { min: 7, label: 'Notable' },
    { min: 9, label: 'Sobresaliente' },
  ],
};

type QMap = Record<string, Question | Partial<Question> | undefined>;

/** Lo mínimo de un examen que necesita esta lógica. */
export interface ExamLike {
  id?: string;
  items: ExamItem[];
  versions?: ExamVersion[];
  spec?: { testPenalty?: number } | null;
}

export interface SubmissionLike {
  id?: string;
  version?: string;
  answers?: Record<string, StoredAnswer>;
  decisions?: Record<string, Decision>;
  confirmed?: boolean;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Redondeo ────────────────────────────────────────────────────────────────

/** Redondeo «half up» idéntico al de Python. */
export function roundTo(value: number, decimals: number): number {
  if (value < 0) return -roundTo(-value, decimals);
  const f = 10 ** decimals;
  return Math.floor(value * f + 0.5 + 1e-9) / f;
}

export const round2 = (v: number) => roundTo(v, 2);

// ─── Escala ──────────────────────────────────────────────────────────────────

export function normalizeScale(scale?: Partial<GradeScale> | null): GradeScale {
  if (!scale || typeof scale !== 'object') {
    return { ...DEFAULT_SCALE, bands: DEFAULT_SCALE.bands.map((b) => ({ ...b })) };
  }
  let top = Number(scale.max || DEFAULT_SCALE.max);
  if (!Number.isFinite(top)) top = 10;
  let decimals = scale.decimals !== undefined && scale.decimals !== null ? Math.trunc(Number(scale.decimals)) : 1;
  if (!Number.isFinite(decimals)) decimals = 1;
  const bands: { min: number; label: string }[] = [];
  for (const b of scale.bands ?? []) {
    if (!b || typeof b !== 'object' || !String(b.label ?? '').trim()) continue;
    const min = Number(b.min || 0);
    if (!Number.isFinite(min)) continue;
    bands.push({ min, label: String(b.label).trim() });
  }
  const finalBands = bands.length ? bands : DEFAULT_SCALE.bands.map((b) => ({ ...b }));
  finalBands.sort((a, b) => a.min - b.min);
  return { max: top > 0 ? top : 10, decimals: Math.max(0, Math.min(3, decimals)), bands: finalBands };
}

export function gradeFromPoints(points: number, maxPoints: number, scale?: Partial<GradeScale> | null): number | null {
  const s = normalizeScale(scale);
  if (!maxPoints || maxPoints <= 0) return null;
  const raw = (s.max * Math.max(0, points)) / maxPoints;
  return roundTo(Math.min(s.max, raw), s.decimals);
}

export function bandOf(grade: number | null | undefined, scale?: Partial<GradeScale> | null): string | null {
  if (grade === null || grade === undefined) return null;
  let label: string | null = null;
  for (const band of normalizeScale(scale).bands) if (grade + 1e-9 >= band.min) label = band.label;
  return label;
}

// ─── Barajado sembrado ───────────────────────────────────────────────────────

/** FNV-1a sobre los bytes UTF-8. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = [...items];
  const rand = mulberry32(hash32(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Versiones ───────────────────────────────────────────────────────────────

/** A conserva el orden del profesor; B, C, D barajan preguntas y opciones de TEST. */
export function buildVersions(examId: string, questionIds: string[], questions: QMap, count: number): ExamVersion[] {
  const n = Math.max(1, Math.min(VERSION_LABELS.length, Math.trunc(count || 1)));
  const versions: ExamVersion[] = [];
  for (let k = 0; k < n; k++) {
    const label = VERSION_LABELS[k];
    const order = k === 0 ? [...questionIds] : seededShuffle(questionIds, `${examId}:${label}:order`);
    const optionOrder: Record<string, string[]> = {};
    for (const qid of questionIds) {
      const q = questions[qid];
      if (!q || q.type !== 'TEST') continue;
      const ids = (q.options ?? []).map((o) => String(o.id));
      optionOrder[qid] = k === 0 ? ids : seededShuffle(ids, `${examId}:${label}:${qid}`);
    }
    versions.push({ label, questionOrder: order, optionOrder });
  }
  return versions;
}

export function findVersion(exam: ExamLike, label?: string | null): ExamVersion {
  const versions = exam.versions ?? [];
  for (const v of versions) if (v.label === (label || 'A')) return v;
  if (versions.length) return versions[0];
  return { label: 'A', questionOrder: exam.items.map((i) => i.questionId), optionOrder: {} };
}

export function optionOrderFor(version: ExamVersion, question: Partial<Question>): string[] {
  const order = version.optionOrder?.[question.id ?? ''];
  if (order && order.length) return [...order];
  return (question.options ?? []).map((o) => String(o.id));
}

export interface AnswerKeyRow {
  position: number;
  questionId: string;
  type?: string;
  points?: number;
  letters?: string[];
  blanks?: Record<string, string[]>;
  modelAnswer?: string;
}

export function answerKey(exam: ExamLike, questions: QMap, label: string): AnswerKeyRow[] {
  const version = findVersion(exam, label);
  const points: Record<string, number> = {};
  for (const i of exam.items) points[i.questionId] = i.points;
  return version.questionOrder.map((qid, idx) => {
    const q = questions[qid] ?? {};
    const row: AnswerKeyRow = { position: idx + 1, questionId: qid, type: q.type, points: points[qid] };
    if (q.type === 'TEST') {
      const order = optionOrderFor(version, q);
      const correct = new Set(q.correctOptionIds ?? []);
      row.letters = order.map((oid, i) => (correct.has(oid) ? LETTERS[i] : '')).filter(Boolean);
    } else if (q.type === 'COMPLETAR') {
      row.blanks = {};
      for (const b of q.blanks ?? []) row.blanks[b.id] = [...(b.accepted ?? [])];
    } else {
      row.modelAnswer = q.modelAnswer;
    }
    return row;
  });
}

// ─── Puntuación objetiva ─────────────────────────────────────────────────────

/** 'b', 'A, c', 'ac', ['a','c'] → ids originales. null si alguna letra no existe. */
export function lettersToOptionIds(raw: unknown, order: string[]): string[] | null {
  let tokens: string[];
  if (Array.isArray(raw)) tokens = raw.map(String);
  else {
    const text = String(raw ?? '').trim().toLowerCase();
    if (!text) return [];
    tokens = /^[a-z]+$/.test(text) ? text.split('') : text.split(/[\s,;/+|]+/).filter(Boolean);
  }
  const ids: string[] = [];
  for (let token of tokens) {
    token = token.trim().toLowerCase().replace(/^[.)]+|[.)]+$/g, '');
    if (!token) continue;
    let index: number;
    if (/^\d+$/.test(token)) index = parseInt(token, 10) - 1;
    else if (token.length === 1 && LETTERS.includes(token)) index = LETTERS.indexOf(token);
    else return null;
    if (index < 0 || index >= order.length) return null;
    if (!ids.includes(order[index])) ids.push(order[index]);
  }
  return ids;
}

export function splitBlanks(raw: unknown, blanks: { id: string }[]): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[String(k)] = String(v);
    return out;
  }
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(/\s*[;|]\s*/);
  const out: Record<string, string> = {};
  blanks.forEach((b, i) => { out[String(b.id)] = i < values.length ? String(values[i]).trim() : ''; });
  return out;
}

export interface ObjectiveScore {
  result: 'CORRECT' | 'WRONG' | 'BLANK' | 'INVALID';
  points: number;
  selected?: string[];
  blankAnswers?: Record<string, string>;
}

/**
 * TEST: igualdad de conjuntos (como scoring.ts#scoreTest); una respuesta errónea no
 * vacía resta `penalty` × puntos. COMPLETAR: todos los huecos (scoreCompletar).
 * null para preguntas abiertas.
 */
export function scoreObjective(
  question: Partial<Question>, answer: StoredAnswer | undefined | null, points: number, version: ExamVersion,
  penalty = 0,
): ObjectiveScore | null {
  if (question.type !== 'TEST' && question.type !== 'COMPLETAR') return null;
  const a = answer ?? {};
  if (question.type === 'TEST') {
    let selected: string[] | null | undefined = a.selectedOptionIds;
    if (selected === undefined || selected === null) selected = lettersToOptionIds(a.letters, optionOrderFor(version, question));
    if (selected === null) return { result: 'INVALID', points: 0, selected: [] };
    if (!selected.length) return { result: 'BLANK', points: 0, selected: [] };
    const correct = new Set(question.correctOptionIds ?? []);
    const set = new Set(selected);
    const ok = set.size === correct.size && [...correct].every((c) => set.has(c));
    return { result: ok ? 'CORRECT' : 'WRONG', points: round2(ok ? points : -Math.abs(penalty) * points), selected: [...selected] };
  }
  const blanks = question.blanks ?? [];
  let given = a.blankAnswers;
  if (given === undefined || given === null) given = a.text !== undefined && a.text !== null && a.text !== '' ? splitBlanks(a.text, blanks) : {};
  if (!Object.values(given).some((v) => String(v).trim())) return { result: 'BLANK', points: 0, blankAnswers: given };
  for (const blank of blanks) {
    const user = normalizeText(given[String(blank.id)] ?? '');
    if (!(blank.accepted ?? []).map((x) => normalizeText(x)).includes(user)) {
      return { result: 'WRONG', points: 0, blankAnswers: given };
    }
  }
  return { result: 'CORRECT', points: round2(points), blankAnswers: given };
}

// ─── Rúbricas ────────────────────────────────────────────────────────────────

type RubricLike = Pick<Rubric, 'criteria'> & { id?: string };

export function criterionMax(c: RubricLike['criteria'][number]): number {
  const pts = (c.levels ?? []).map((l) => Number(l.points || 0));
  return pts.length ? Math.max(...pts) : 0;
}

export interface RubricBreakdown {
  criteria: { criterionId: string; levelId: string | null; points: number | null; maxPoints: number }[];
  points: number;
  complete: boolean;
}

/** Cada criterio vale peso/Σpesos de la pregunta, escalado por puntos del nivel / mejor nivel. */
export function rubricBreakdown(rubric: RubricLike, selections: Record<string, string>, questionPoints: number): RubricBreakdown {
  const criteria = rubric.criteria ?? [];
  let weights = criteria.map((c) => Math.max(0, Number(c.weight || 0)));
  const sumW = weights.reduce((s, w) => s + w, 0);
  const totalW = sumW || (criteria.length || 1);
  if (!sumW) weights = criteria.map(() => 1);
  const rows: RubricBreakdown['criteria'] = [];
  let total = 0;
  let complete = true;
  criteria.forEach((c, idx) => {
    const share = (questionPoints * weights[idx]) / totalW;
    const level = (c.levels ?? []).find((l) => l.id === selections[c.id]);
    const best = criterionMax(c);
    if (!level) {
      complete = false;
      rows.push({ criterionId: c.id, levelId: null, points: null, maxPoints: round2(share) });
      return;
    }
    const got = best > 0 ? share * (Number(level.points || 0) / best) : 0;
    total += got;
    rows.push({ criterionId: c.id, levelId: level.id, points: round2(got), maxPoints: round2(share) });
  });
  return { criteria: rows, points: round2(total), complete };
}

export function validateRubric(rubric: RubricLike): string[] {
  const problems: string[] = [];
  const criteria = rubric.criteria ?? [];
  if (!criteria.length) problems.push('La rúbrica no tiene criterios.');
  const ids = new Set<string>();
  for (const c of criteria) {
    if (!String(c.name ?? '').trim()) problems.push('Hay un criterio sin nombre.');
    if (ids.has(c.id)) problems.push(`Criterio repetido: ${c.id}.`);
    ids.add(c.id);
    const levels = c.levels ?? [];
    if (levels.length < 2) problems.push(`El criterio «${c.name}» necesita al menos dos niveles.`);
    if (levels.length && criterionMax(c) <= 0) problems.push(`El criterio «${c.name}» no tiene ningún nivel con puntos.`);
    if (Number(c.weight || 0) < 0) problems.push(`El criterio «${c.name}» tiene peso negativo.`);
  }
  return problems;
}

// ─── Una entrega ─────────────────────────────────────────────────────────────

export interface ItemPoints {
  questionId: string;
  type?: string | null;
  topicId?: string | null;
  maxPoints: number;
  auto: ObjectiveScore | null;
  decision: Decision | null;
  points: number | null;
}

export function itemPoints(exam: ExamLike, questions: QMap, submission: SubmissionLike): ItemPoints[] {
  const version = findVersion(exam, submission.version);
  const penalty = Number(exam.spec?.testPenalty || 0);
  const answers = submission.answers ?? {};
  const decisions = submission.decisions ?? {};
  return exam.items.map((item) => {
    const qid = item.questionId;
    const q = questions[qid] ?? { id: qid };
    const maxPts = Number(item.points || 0);
    const auto = scoreObjective(q, answers[qid], maxPts, version, penalty);
    const decision = decisions[qid] ?? null;
    let final: number | null = null;
    if (decision && decision.points !== undefined && decision.points !== null) final = round2(Number(decision.points));
    else if (auto) final = auto.points;
    return { questionId: qid, type: q.type ?? null, topicId: q.topicId ?? null, maxPoints: maxPts, auto, decision, points: final };
  });
}

export function submissionResult(
  exam: ExamLike, questions: QMap, submission: SubmissionLike, scale?: Partial<GradeScale> | null,
): SubmissionResult {
  const rows = itemPoints(exam, questions, submission);
  const maxPoints = round2(rows.reduce((s, r) => s + r.maxPoints, 0));
  const pending = rows.filter((r) => r.points === null).map((r) => r.questionId);
  const points = round2(Math.max(0, rows.reduce((s, r) => s + (r.points ?? 0), 0)));
  const grade = gradeFromPoints(points, maxPoints, scale);
  return { points, maxPoints, grade, band: bandOf(grade, scale), pending, complete: pending.length === 0 };
}

// ─── Feedback ────────────────────────────────────────────────────────────────

export function shortText(text: string | null | undefined, n = 90): string {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
}

export function feedback(
  exam: ExamLike, questions: QMap, topics: Record<string, string | undefined>,
  concepts: { id: string; topicId?: string; title: string; category?: string; order?: number }[],
  submission: SubmissionLike, rubrics: Record<string, RubricLike> = {},
): Feedback {
  const version = findVersion(exam, submission.version);
  const positions: Record<string, number> = {};
  version.questionOrder.forEach((qid, i) => { positions[qid] = i + 1; });
  const rows = itemPoints(exam, questions, submission);
  const byTopic = new Map<string, number[]>();
  const strengths: FeedbackEntry[] = [];
  const mistakes: FeedbackEntry[] = [];
  for (const r of rows) {
    if (r.points === null || !r.maxPoints) continue;
    const ratio = Math.max(0, r.points) / r.maxPoints;
    const q = questions[r.questionId] ?? {};
    const topicId = q.topicId || '';
    if (!byTopic.has(topicId)) byTopic.set(topicId, []);
    byTopic.get(topicId)!.push(ratio);
    const entry: FeedbackEntry = {
      questionId: r.questionId, position: positions[r.questionId], topicId: topicId || null,
      topic: topics[topicId] ?? null, prompt: shortText(q.prompt), ratio: round2(ratio),
    };
    if (ratio >= 0.7) strengths.push(entry);
    else if (ratio < 0.5) {
      entry.detail = mistakeDetail(q, r, version, rubrics);
      mistakes.push(entry);
    }
  }
  const review: Feedback['review'] = [];
  for (const [topicId, ratios] of byTopic) {
    const avg = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    if (avg < 0.6) {
      const linked = concepts.filter((c) => topicId && c.topicId === topicId);
      linked.sort((a, b) => cmp(a.category ?? '', b.category ?? '') || (a.order ?? 0) - (b.order ?? 0) || cmp(a.title ?? '', b.title ?? ''));
      review.push({
        topicId: topicId || null, topic: topics[topicId] ?? null, ratio: round2(avg),
        keyConcepts: linked.slice(0, 5).map((c) => ({ id: c.id, title: c.title })),
      });
    }
  }
  review.sort((a, b) => a.ratio - b.ratio || cmp(a.topic ?? '', b.topic ?? ''));
  const strong = new Set<string>();
  for (const [t, rs] of byTopic) {
    if (t && rs.reduce((s, x) => s + x, 0) / rs.length >= 0.7 && topics[t]) strong.add(topics[t]!);
  }
  return { strengths, strongTopics: [...strong].sort(cmp), mistakes, review };
}

function mistakeDetail(question: Partial<Question>, row: ItemPoints, version: ExamVersion, rubrics: Record<string, RubricLike>): string {
  const auto = row.auto;
  if (question.type === 'TEST') {
    const order = optionOrderFor(version, question);
    const chosen = (auto?.selected ?? []).filter((i) => order.includes(i)).map((i) => LETTERS[order.indexOf(i)]);
    const correctSet = new Set(question.correctOptionIds ?? []);
    const correct = order.map((oid, i) => (correctSet.has(oid) ? LETTERS[i] : '')).filter(Boolean);
    if (!chosen.length) return `En blanco; la correcta era ${correct.join(', ')}.`;
    return `Marcó ${chosen.join(', ')}; la correcta era ${correct.join(', ')}.`;
  }
  if (question.type === 'COMPLETAR') {
    const expected = (question.blanks ?? []).map((b) => (b.accepted ?? [''])[0] ?? '').join('; ');
    return `Se esperaba: ${expected}.`;
  }
  const decision = row.decision;
  if (decision?.comment) return shortText(decision.comment, 200);
  const rubric = rubrics[decision?.rubricId ?? ''];
  const names: Record<string, string> = {};
  for (const c of rubric?.criteria ?? []) names[c.id] = c.name;
  const weak: string[] = [];
  for (const c of decision?.criteria ?? []) {
    if (c.points !== null && c.points !== undefined && c.maxPoints && c.points < c.maxPoints / 2) {
      weak.push(names[c.criterionId] || String(c.criterionId));
    }
  }
  if (weak.length) return `Flojo en: ${weak.join(', ')}.`;
  return 'Respuesta insuficiente frente a la respuesta modelo.';
}

// ─── Análisis de la clase ────────────────────────────────────────────────────

export interface ItemAnalysis {
  questionId: string;
  position: number;
  type?: string;
  topicId?: string | null;
  topic?: string | null;
  prompt: string;
  maxPoints: number;
  answered: number;
  success: number | null;
  wrongOptions: { optionId: string; text?: string; count: number }[];
  commonWrong: { answer: string; count: number }[];
  weakCriteria: { criterionId: string; name?: string | null; count: number }[];
}

export interface TopicAnalysis {
  topicId: string | null;
  topic: string | null;
  items: number;
  weight: number;
  success: number | null;
}

export interface Distribution {
  count: number;
  mean: number | null;
  median: number | null;
  passRate: number | null;
  bands: { label: string; min: number; count: number }[];
  histogram: number[];
}

export interface ExamAnalysis {
  examId?: string;
  submissions: number;
  graded: number;
  items: ItemAnalysis[];
  topics: TopicAnalysis[];
  worstTopic: TopicAnalysis | null;
  distribution: Distribution;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
}

export function analyze(
  exam: ExamLike, questions: QMap, topics: Record<string, string | undefined>, submissions: SubmissionLike[],
  rubrics: Record<string, RubricLike> = {}, scale?: Partial<GradeScale> | null, includeUnconfirmed = false,
): ExamAnalysis {
  const s = normalizeScale(scale);
  const used = submissions.filter((sub) => sub.confirmed || includeUnconfirmed);
  const acc = new Map<string, { answered: number; sum: number; wrong: Map<string, number>; blank: Map<string, number>; criteria: Map<string, number> }>();
  for (const item of exam.items) acc.set(item.questionId, { answered: 0, sum: 0, wrong: new Map(), blank: new Map(), criteria: new Map() });
  const grades: number[] = [];
  for (const sub of used) {
    const rows = itemPoints(exam, questions, sub);
    if (rows.some((r) => r.points === null)) continue;
    const result = submissionResult(exam, questions, sub, s);
    if (result.grade !== null) grades.push(result.grade);
    for (const r of rows) {
      const a = acc.get(r.questionId)!;
      a.answered += 1;
      a.sum += r.maxPoints ? Math.max(0, r.points!) / r.maxPoints : 0;
      const q = questions[r.questionId] ?? {};
      const auto = r.auto;
      if (q.type === 'TEST' && auto?.result === 'WRONG') {
        const correct = new Set(q.correctOptionIds ?? []);
        for (const oid of auto.selected ?? []) if (!correct.has(oid)) bump(a.wrong, oid);
      } else if (q.type === 'COMPLETAR' && auto?.result === 'WRONG') {
        for (const blank of q.blanks ?? []) {
          const given = normalizeText((auto.blankAnswers ?? {})[String(blank.id)] ?? '');
          if (given && !(blank.accepted ?? []).map((x) => normalizeText(x)).includes(given)) bump(a.blank, given);
        }
      } else {
        for (const c of r.decision?.criteria ?? []) {
          if (c.points !== null && c.points !== undefined && c.maxPoints && c.points < c.maxPoints / 2) {
            bump(a.criteria, `${r.decision?.rubricId || ''}::${c.criterionId}`);
          }
        }
      }
    }
  }
  // Los ids de criterio se repiten entre rúbricas (c1, c2…): el nombre sale de la rúbrica de la decisión.
  const rubricNames: Record<string, string> = {};
  for (const [rid, rub] of Object.entries(rubrics)) for (const c of rub.criteria ?? []) rubricNames[`${rid}::${c.id}`] = c.name;
  const items: ItemAnalysis[] = exam.items.map((item, idx) => {
    const q = questions[item.questionId] ?? {};
    const a = acc.get(item.questionId)!;
    const texts: Record<string, string> = {};
    for (const o of q.options ?? []) texts[String(o.id)] = o.text;
    return {
      questionId: item.questionId, position: idx + 1, type: q.type, topicId: q.topicId ?? null,
      topic: topics[q.topicId || ''] ?? null, prompt: shortText(q.prompt), maxPoints: Number(item.points || 0),
      answered: a.answered, success: a.answered ? round2(a.sum / a.answered) : null,
      wrongOptions: sortedCounts(a.wrong).map(([optionId, count]) => ({ optionId, text: texts[optionId], count })),
      commonWrong: sortedCounts(a.blank).slice(0, 3).map(([answer, count]) => ({ answer, count })),
      weakCriteria: sortedCounts(a.criteria).map(([key, count]) => ({ criterionId: key.split('::').slice(1).join('::'), name: rubricNames[key] ?? null, count })),
    };
  });
  const topicAcc = new Map<string, [number, number, number]>();
  for (const it of items) {
    if (it.success === null) continue;
    const key = it.topicId || '';
    const t = topicAcc.get(key) ?? [0, 0, 0];
    t[0] += it.success * it.maxPoints;
    t[1] += it.maxPoints;
    t[2] += 1;
    topicAcc.set(key, t);
  }
  const topicsOut: TopicAnalysis[] = [...topicAcc.entries()].map(([k, v]) => ({
    topicId: k || null, topic: topics[k] ?? null, items: v[2], weight: round2(v[1]), success: v[1] ? round2(v[0] / v[1]) : null,
  }));
  topicsOut.sort((a, b) => (a.success ?? 2) - (b.success ?? 2) || cmp(a.topic ?? '', b.topic ?? ''));
  return {
    examId: exam.id, submissions: used.length, graded: grades.length, items, topics: topicsOut,
    worstTopic: topicsOut[0] ?? null, distribution: distribution(grades, s),
  };
}

export function distribution(grades: number[], scale?: Partial<GradeScale> | null): Distribution {
  const s = normalizeScale(scale);
  const bands = s.bands.map((b) => ({ label: b.label, min: b.min, count: 0 }));
  for (const g of grades) {
    const label = bandOf(g, s);
    for (const b of bands) if (b.label === label) b.count += 1;
  }
  const bins = new Array(10).fill(0);
  for (const g of grades) bins[s.max ? Math.min(9, Math.max(0, Math.floor((g * 10) / s.max))) : 0] += 1;
  const ordered = [...grades].sort((a, b) => a - b);
  const n = ordered.length;
  let median: number | null = null;
  if (n) median = n % 2 ? ordered[Math.floor(n / 2)] : round2((ordered[n / 2 - 1] + ordered[n / 2]) / 2);
  const passMin = s.bands.length > 1 ? s.bands[1].min : s.max / 2;
  return {
    count: n,
    mean: n ? round2(grades.reduce((a, b) => a + b, 0) / n) : null,
    median,
    passRate: n ? round2(grades.filter((g) => g + 1e-9 >= passMin).length / n) : null,
    bands,
    histogram: bins,
  };
}

/** Éxito por tema a lo largo de varios exámenes de una clase. */
export function combineTopics(analyses: ExamAnalysis[]): { topicId: string | null; topic: string | null; exams: number; success: number | null }[] {
  const acc = new Map<string, [number, number, string | null, number]>();
  for (const a of analyses) {
    const answered: Record<string, number> = {};
    for (const it of a.items) answered[it.topicId ?? 'null'] = it.answered;
    for (const t of a.topics) {
      if (t.success === null) continue;
      const weight = (t.weight || 0) * Math.max(1, answered[t.topicId ?? 'null'] ?? 1);
      const row = acc.get(t.topicId || '') ?? [0, 0, t.topic, 0];
      row[0] += t.success * weight;
      row[1] += weight;
      row[3] += 1;
      acc.set(t.topicId || '', row);
    }
  }
  const out = [...acc.entries()].map(([k, v]) => ({ topicId: k || null, topic: v[2], exams: v[3], success: v[1] ? round2(v[0] / v[1]) : null }));
  out.sort((a, b) => (a.success ?? 2) - (b.success ?? 2) || cmp(a.topic ?? '', b.topic ?? ''));
  return out;
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

const HEADER_WORDS = ['nombre', 'name', 'alumno', 'alumna', 'estudiante', 'student', 'apellidos', 'apellido', 'email', 'correo', 'mail', 'alias'];

function separator(line: string): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const sep of ['\t', ';', ',']) {
    const n = line.split(sep).length - 1;
    if (n > bestN) { best = sep; bestN = n; }
  }
  return best;
}

function cells(line: string, sep: string | null): string[] {
  if (sep === null) return [line.trim()];
  return line.split(sep).map((c) => c.trim().replace(/^"+|"+$/g, '').trim());
}

function nonEmptyLines(text: string): string[] {
  return (text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
}

export interface RosterEntry { displayName: string; email?: string }

/** Lista pegada o CSV → alumnos. Una línea por alumno, o columnas con cabecera. */
export function parseRoster(text: string): { students: RosterEntry[]; skipped: string[] } {
  let lines = nonEmptyLines(text);
  if (!lines.length) return { students: [], skipped: [] };
  const sep = separator(lines[0]);
  const first = cells(lines[0], sep).map((c) => normalizeText(c));
  let header: string[] | null = null;
  if (first.some((c) => HEADER_WORDS.includes(c))) {
    header = first;
    lines = lines.slice(1);
  }
  const students: RosterEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const cs = cells(line, sep);
    const email = cs.find((c) => c.includes('@'));
    let name = '';
    if (header) {
      const h = header;
      const col = (...names: string[]) => {
        for (const n of names) {
          const i = h.indexOf(n);
          if (i >= 0 && i < cs.length) return cs[i];
        }
        return '';
      };
      name = col('alias') || [col('nombre', 'name', 'alumno', 'alumna', 'estudiante', 'student'), col('apellidos', 'apellido')].filter(Boolean).join(' ');
    } else {
      const plain = cs.filter((c) => c && !c.includes('@'));
      if (sep === ',' && plain.length === 2 && cs.length === 2) name = `${plain[1]} ${plain[0]}`;
      else name = plain[0] ?? '';
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (!name) { skipped.push(line.trim()); continue; }
    const key = normalizeText(name);
    if (seen.has(key)) { skipped.push(line.trim()); continue; }
    seen.add(key);
    const entry: RosterEntry = { displayName: name };
    if (email) entry.email = email;
    students.push(entry);
  }
  return { students, skipped };
}

const NAME_HEADERS = ['alumno', 'alumna', 'nombre', 'name', 'student', 'estudiante'];
const VERSION_HEADERS = ['version', 'modelo', 'model', 'v'];

export interface GridRow { student: string; version: string; cells: Record<number, string> }

/** CSV/TSV `alumno;version;1;2;3…` (posiciones impresas en la versión del alumno). */
export function parseAnswerGrid(text: string): { rows: GridRow[]; errors: string[] } {
  let lines = nonEmptyLines(text);
  if (!lines.length) return { rows: [], errors: [] };
  const sep = separator(lines[0]);
  const head = cells(lines[0], sep).map((c) => normalizeText(c));
  let versionCol: number | null = null;
  const positions = new Map<number, number>();
  if (head.length && NAME_HEADERS.includes(head[0])) {
    head.forEach((h, i) => {
      if (i === 0) return;
      if (VERSION_HEADERS.includes(h)) { versionCol = i; return; }
      const m = /^(?:p|q|pregunta)?\s*(\d+)$/.exec(h);
      if (m) positions.set(i, parseInt(m[1], 10));
    });
    lines = lines.slice(1);
  }
  const rows: GridRow[] = [];
  const errors: string[] = [];
  lines.forEach((line, idx) => {
    const cs = cells(line, sep);
    if (!cs.length || !cs[0]) { errors.push(`Línea ${idx + 1}: sin nombre de alumno.`); return; }
    let version = 'A';
    if (versionCol !== null && versionCol < cs.length && cs[versionCol]) version = cs[versionCol].trim().toUpperCase().slice(0, 1);
    const cellMap: Record<number, string> = {};
    if (positions.size) {
      for (const [i, pos] of positions) if (i < cs.length && cs[i].trim()) cellMap[pos] = cs[i].trim();
    } else {
      cs.slice(1).forEach((value, i) => { if (value.trim()) cellMap[i + 1] = value.trim(); });
    }
    rows.push({ student: cs[0], version, cells: cellMap });
  });
  return { rows, errors };
}

export function matchStudent<T extends { displayName: string }>(name: string, students: T[]): T | null {
  const key = normalizeText(name);
  const exact = students.filter((s) => normalizeText(s.displayName || '') === key);
  if (exact.length === 1) return exact[0];
  const loose = students.filter((s) => {
    const n = normalizeText(s.displayName || '');
    return key && (n.includes(key) || key.includes(n));
  });
  return loose.length === 1 ? loose[0] : null;
}

/** Posición impresa → respuesta guardada por id de pregunta. */
export function gridAnswers(exam: ExamLike, questions: QMap, versionLabel: string, cellMap: Record<number, string>): Record<string, StoredAnswer> {
  const order = findVersion(exam, versionLabel).questionOrder;
  const out: Record<string, StoredAnswer> = {};
  for (const [posRaw, raw] of Object.entries(cellMap)) {
    const pos = parseInt(posRaw, 10);
    if (!(pos >= 1 && pos <= order.length)) continue;
    const qid = order[pos - 1];
    const q = questions[qid] ?? {};
    if (q.type === 'TEST') out[qid] = { letters: String(raw).trim().toLowerCase(), source: 'grid' };
    else if (q.type === 'COMPLETAR') out[qid] = { blankAnswers: splitBlanks(raw, q.blanks ?? []), source: 'grid' };
    else out[qid] = { text: String(raw), source: 'grid' };
  }
  return out;
}

// ─── Validación de un borrador TEST ──────────────────────────────────────────

const GENERIC_OPTION = /^(?:opci[oó]n|option|respuesta|answer)?\s*\(?[a-z0-9]\)?\.?$/;

/** Por qué un TEST no se puede enseñar (null si está bien). Gemelo de hypatia/options.py#test_problem. */
export function testProblem(q: { options?: { id: string; text: string }[]; correctOptionIds?: string[] }, minOptions = 3): string | null {
  const options = q.options ?? [];
  if (options.length < minOptions) return `menos de ${minOptions} opciones`;
  const seen = new Set<string>();
  for (const o of options) {
    const text = String(o.text ?? '').trim();
    const norm = normalizeText(text);
    if (!text) return 'opción vacía';
    if (norm === normalizeText(String(o.id ?? '').trim()) || GENERIC_OPTION.test(norm)) return 'opción sin texto (solo la letra)';
    if (seen.has(norm)) return 'opciones repetidas';
    seen.add(norm);
  }
  const ids = options.map((o) => o.id);
  const correct = q.correctOptionIds ?? [];
  if (!correct.length) return 'sin respuesta correcta marcada';
  if (new Set(correct).size !== correct.length || !correct.every((c) => ids.includes(c))) return 'respuesta correcta que no es una de las opciones';
  if (correct.length === ids.length) return 'todas las opciones marcadas como correctas';
  return null;
}

// ─── CSV de notas ────────────────────────────────────────────────────────────

export interface GradeRow {
  student: string;
  version: string;
  points: number | null;
  maxPoints: number | null;
  grade: number | null;
  band: string | null;
  confirmed: boolean;
}

/** CSV con «;» y coma decimal (lo abre bien una hoja de cálculo en español). */
export function gradesCsv(rows: GradeRow[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const t = String(v);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = ['Alumno;Versión;Puntos;Máximo;Nota;Calificación;Confirmada'];
  for (const r of rows) {
    lines.push([r.student, r.version, r.points, r.maxPoints, r.grade, r.band, r.confirmed ? 'sí' : 'no'].map(cell).join(';'));
  }
  return lines.join('\n') + '\n';
}
