/**
 * teacherPdf.ts — PDFs del rol Profesor con las utilidades de pdfExport.ts
 * (jsPDF + KaTeX renderizado como imagen cuando hay fórmulas):
 *  - examen imprimible: cada versión, solucionario por versión y rúbricas;
 *  - feedback por alumno (uno o todos los confirmados de una entrega).
 * El PDF de feedback lleva datos del alumno: es un archivo para el profesor.
 */

import jsPDF from 'jspdf';
import type { Question } from '@/domain/models';
import type { Feedback, Rubric, SubmissionResult, TeacherExam } from '@/domain/teacher';
import { LETTERS, answerKey, findVersion, optionOrderFor } from '@/domain/teacherCore';
import {
  addMdImageToPdf, addPageNumbers, addSectionTitle, addText, hasLatex, stripMd,
  CONTENT_W, MARGIN_B, MARGIN_L, MARGIN_T, PAGE_H, PAGE_W, MARGIN_R,
} from './pdfExport';

const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
const pts = (v: number) => `${num(v)} punto${v === 1 ? '' : 's'}`;

async function addRich(pdf: jsPDF, md: string, y: number, opts: { size?: number; bold?: boolean; indent?: number } = {}): Promise<number> {
  if (hasLatex(md)) return addMdImageToPdf(pdf, md, y, CONTENT_W - (opts.indent ?? 0));
  return addText(pdf, stripMd(md), y, opts);
}

function header(pdf: jsPDF, exam: TeacherExam, subjectName: string, label: string | null, key = false): number {
  let y = MARGIN_T;
  const h = exam.header ?? { centre: '', course: '', date: '', instructions: '' };
  const top = [h.centre, h.course, subjectName].filter(Boolean).join(' · ');
  if (top) y = addText(pdf, top, y, { size: 9, color: [110, 110, 130] });
  y = addText(pdf, `${key ? 'Solucionario · ' : ''}${exam.title}${label ? ` · Versión ${label}` : ''}`, y + 2, { size: 15, bold: true });
  const total = exam.items.reduce((s, i) => s + Number(i.points || 0), 0);
  const meta = [h.date ? `Fecha: ${h.date}` : '', h.durationMin ? `Duración: ${h.durationMin} min` : '', `Puntuación total: ${num(total)}`]
    .filter(Boolean).join(' · ');
  y = addText(pdf, meta, y + 1, { size: 9, color: [110, 110, 130] });
  if (!key) {
    y = addText(pdf, 'Nombre y apellidos: ________________________________________________', y + 3, { size: 10 });
    if (h.instructions) y = addText(pdf, stripMd(h.instructions), y + 1, { size: 9 });
  }
  pdf.setDrawColor(200, 200, 210);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN_L, y + 1, PAGE_W - MARGIN_R, y + 1);
  return y + 6;
}

function answerLines(pdf: jsPDF, y: number, n: number): number {
  pdf.setDrawColor(210, 210, 220);
  pdf.setLineWidth(0.2);
  for (let i = 0; i < n; i++) {
    if (y + 8 > PAGE_H - MARGIN_B) { pdf.addPage(); y = MARGIN_T; }
    y += 8;
    pdf.line(MARGIN_L + 5, y, PAGE_W - MARGIN_R, y);
  }
  return y + 4;
}

export interface ExamPdfOptions {
  versions?: string[];
  withKey?: boolean;
  withRubrics?: boolean;
}

export async function generateTeacherExamPDF(
  exam: TeacherExam, questions: Record<string, Question>, subjectName: string, rubrics: Rubric[], opts: ExamPdfOptions = {},
): Promise<Blob> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const labels = opts.versions ?? (exam.versions.length ? exam.versions.map((v) => v.label) : ['A']);
  const many = exam.versions.length > 1;
  const points: Record<string, number> = {};
  for (const i of exam.items) points[i.questionId] = i.points;
  let first = true;
  for (const label of labels) {
    if (!first) pdf.addPage();
    first = false;
    const version = findVersion(exam, label);
    let y = header(pdf, exam, subjectName, many ? label : null);
    for (let p = 0; p < version.questionOrder.length; p++) {
      const q = questions[version.questionOrder[p]];
      if (!q) continue;
      if (y + 20 > PAGE_H - MARGIN_B) { pdf.addPage(); y = MARGIN_T; }
      y = addText(pdf, `${p + 1}. (${pts(points[q.id] ?? 0)})`, y, { bold: true, size: 10 });
      y = await addRich(pdf, q.prompt, y, { size: 10, indent: 4 });
      if (q.type === 'TEST') {
        const texts: Record<string, string> = {};
        for (const o of q.options ?? []) texts[o.id] = o.text;
        const order = optionOrderFor(version, q);
        for (let i = 0; i < order.length; i++) y = await addRich(pdf, `${LETTERS[i]}) ${texts[order[i]] ?? ''}`, y, { size: 9.5, indent: 8 });
        y += 2;
      } else if (q.type === 'COMPLETAR') {
        y = await addRich(pdf, (q.clozeText ?? '').replace(/\{\{[^}]+\}\}/g, '__________'), y, { size: 10, indent: 8 });
        y += 2;
      } else {
        y = answerLines(pdf, y, q.type === 'DESARROLLO' ? 8 : 10);
      }
    }
  }
  if (opts.withKey !== false) {
    for (const label of labels) {
      pdf.addPage();
      let y = header(pdf, exam, subjectName, many ? label : null, true);
      for (const row of answerKey(exam, questions, label)) {
        const q = questions[row.questionId];
        if (!q) continue;
        if (y + 14 > PAGE_H - MARGIN_B) { pdf.addPage(); y = MARGIN_T; }
        y = addText(pdf, `${row.position}. (${pts(row.points ?? 0)}) ${stripMd(q.prompt).slice(0, 110)}`, y, { bold: true, size: 9 });
        let answer = '';
        if (row.type === 'TEST') answer = (row.letters ?? []).join(', ');
        else if (row.type === 'COMPLETAR') answer = Object.values(row.blanks ?? {}).map((v) => v.join(' / ')).join(' | ');
        else answer = row.modelAnswer || '(sin respuesta modelo)';
        y = await addRich(pdf, answer, y, { size: 9.5, indent: 5 });
        y += 1.5;
      }
    }
  }
  if (opts.withRubrics !== false && rubrics.length) {
    pdf.addPage();
    let y = addSectionTitle(pdf, `Rúbricas · ${exam.title}`, MARGIN_T);
    const base = findVersion(exam, 'A');
    for (const r of rubrics) {
      const pos = r.questionId ? base.questionOrder.indexOf(r.questionId) + 1 : 0;
      y = addText(pdf, `${r.title} · ${pos ? `Pregunta ${pos} (versión A)` : 'Todo el examen'}`, y + 2, { bold: true, size: 10.5 });
      for (const c of r.criteria) {
        y = addText(pdf, `${c.name} (peso ${num(c.weight)})`, y, { bold: true, size: 9.5, indent: 3 });
        for (const l of c.levels) y = addText(pdf, `${num(l.points)} — ${l.descriptor}`, y, { size: 9, indent: 8 });
      }
    }
  }
  addPageNumbers(pdf);
  return pdf.output('blob');
}

export interface FeedbackPage {
  student: string;
  version: string;
  result: SubmissionResult;
  feedback: Feedback;
  comment?: string;
}

export async function generateFeedbackPDF(exam: TeacherExam, subjectName: string, pages: FeedbackPage[]): Promise<Blob> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  pages.forEach((page, idx) => {
    if (idx) pdf.addPage();
    let y = MARGIN_T;
    y = addText(pdf, [exam.header?.centre, subjectName].filter(Boolean).join(' · '), y, { size: 9, color: [110, 110, 130] });
    y = addText(pdf, `${exam.title} · ${page.student}`, y + 2, { size: 14, bold: true });
    const r = page.result;
    y = addText(pdf, `Versión ${page.version} · ${num(r.points)} de ${num(r.maxPoints)} puntos · Nota ${num(r.grade)} · ${r.band ?? ''}`, y + 1, { size: 10.5, bold: true, color: [150, 110, 30] });
    if (page.comment) y = addText(pdf, `Comentario del profesor: ${page.comment}`, y + 2, { size: 9.5 });
    const fb = page.feedback;
    y = addSectionTitle(pdf, 'Lo que has hecho bien', y + 3);
    if (fb.strongTopics.length) y = addText(pdf, `Temas fuertes: ${fb.strongTopics.join(', ')}`, y, { size: 9.5 });
    for (const s of fb.strengths) y = addText(pdf, `· P${s.position ?? '?'} ${s.prompt}`, y, { size: 9, indent: 2 });
    if (!fb.strengths.length) y = addText(pdf, '—', y, { size: 9 });
    y = addSectionTitle(pdf, 'Errores', y + 2);
    for (const m of fb.mistakes) {
      y = addText(pdf, `· P${m.position ?? '?'} ${m.prompt}`, y, { size: 9, indent: 2, bold: true });
      if (m.detail) y = addText(pdf, m.detail, y, { size: 9, indent: 6 });
    }
    if (!fb.mistakes.length) y = addText(pdf, '—', y, { size: 9 });
    y = addSectionTitle(pdf, 'Qué repasar', y + 2);
    for (const t of fb.review) {
      y = addText(pdf, `· ${t.topic ?? 'Sin tema'} (${Math.round(t.ratio * 100)} %)`, y, { size: 9.5, indent: 2, bold: true });
      for (const k of t.keyConcepts) y = addText(pdf, `– ${k.title}`, y, { size: 9, indent: 7 });
    }
    if (!fb.review.length) addText(pdf, 'Nada pendiente: todos los temas superan el 60 %.', y, { size: 9 });
  });
  addPageNumbers(pdf);
  return pdf.output('blob');
}
