/**
 * pdfExport.ts
 *
 * Motor de generación de PDF para Exam Coach.
 * Genera PDFs bien formateados desde preguntas, conceptos clave y exámenes
 * usando jsPDF con renderizado HTML→Canvas para soportar LaTeX/KaTeX.
 */

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { renderMd } from '@/utils/renderMd';
import type { Question, KeyConcept, Exam, Topic, QuestionType, KeyConceptCategory } from '@/domain/models';

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_W = 210;     // A4 mm
const PAGE_H = 297;
const MARGIN_L = 15;
const MARGIN_R = 15;
const MARGIN_T = 20;
const MARGIN_B = 20;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

const TYPE_ORDER: QuestionType[] = ['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO'];
const TYPE_LABELS: Record<QuestionType, string> = {
  TEST: 'Test',
  DESARROLLO: 'Desarrollo',
  COMPLETAR: 'Completar',
  PRACTICO: 'Práctico',
};

const CATEGORY_ORDER: KeyConceptCategory[] = ['formula', 'definition', 'remark'];
const CATEGORY_LABELS: Record<KeyConceptCategory, string> = {
  formula: 'Fórmulas',
  definition: 'Definiciones',
  remark: 'Observaciones',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Cached CSS string containing only KaTeX-related rules.
 * We filter to avoid injecting thousands of Tailwind utility rules
 * which makes html2canvas extremely slow.
 */
let _katexCssCache: string | null = null;

function getKatexCSS(): string {
  if (_katexCssCache !== null) return _katexCssCache;

  const chunks: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        const text = rule.cssText;
        if (
          text.includes('.katex') ||
          text.includes('.katex-') ||
          (rule instanceof CSSFontFaceRule && text.includes('KaTeX'))
        ) {
          chunks.push(text);
        }
      }
    } catch { /* cross-origin sheet, skip */ }
  }
  _katexCssCache = chunks.join('\n');
  return _katexCssCache;
}

/**
 * Render a Markdown+LaTeX string to an offscreen HTML element,
 * capture it with html2canvas, and return the image as a data URL.
 *
 * Only KaTeX CSS is injected (not the full Tailwind stylesheet) for speed.
 * html2canvas has a known limitation with KaTeX fraction bar positioning
 * but the content is readable.
 */
async function renderMdToImage(
  mdText: string,
  maxWidthPx: number = 680,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; left: -9999px; top: 0;
    width: ${maxWidthPx}px;
    padding: 8px 12px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.55;
    color: #1a1a2e;
    background: white;
  `;
  container.innerHTML = renderMd(mdText);

  // Inject only KaTeX CSS rules (not the entire Tailwind stylesheet)
  const styleEl = document.createElement('style');
  styleEl.textContent = getKatexCSS();
  container.prepend(styleEl);

  document.body.appendChild(container);

  // Wait for KaTeX fonts to load
  try {
    await document.fonts.ready;
  } catch { /* fallback */ }
  await new Promise((r) => setTimeout(r, 150));

  const canvas = await html2canvas(container, {
    scale: 1.5,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
  });

  document.body.removeChild(container);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.85),
    width: canvas.width,
    height: canvas.height,
  };
}

/** Pixel size to mm at a given DPI scale */
const PX_TO_MM = 25.4 / 96;

/**
 * Add a rendered markdown image to the PDF at the current Y position.
 * Returns the new Y position after the image.
 * Handles page breaks automatically.
 */
async function addMdImageToPdf(
  pdf: jsPDF,
  mdText: string,
  y: number,
  maxWidthMm: number = CONTENT_W,
): Promise<number> {
  if (!mdText.trim()) return y;

  const { dataUrl, width, height } = await renderMdToImage(mdText);

  // Canvas was rendered at scale=1.5, so real pixel dims are /1.5
  const realW = width / 1.5;
  const realH = height / 1.5;

  // Convert to mm
  const naturalWMm = realW * PX_TO_MM;
  const naturalHMm = realH * PX_TO_MM;

  // Scale down to fit maxWidth if needed, preserving aspect ratio
  const scale = Math.min(1, maxWidthMm / naturalWMm);
  const imgWMm = naturalWMm * scale;
  const imgHMm = naturalHMm * scale;

  // Check if we need a new page
  if (y + imgHMm > PAGE_H - MARGIN_B) {
    pdf.addPage();
    y = MARGIN_T;
  }

  pdf.addImage(dataUrl, 'JPEG', MARGIN_L, y, imgWMm, imgHMm);
  return y + imgHMm + 3;
}

/** Add header to current page */
function addHeader(pdf: jsPDF, title: string, subtitle: string) {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor(30, 30, 50);
  pdf.text(title, MARGIN_L, MARGIN_T);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(120, 120, 140);
  pdf.text(subtitle + ' — ' + today(), MARGIN_L, MARGIN_T + 7);

  // Line separator
  pdf.setDrawColor(200, 200, 210);
  pdf.setLineWidth(0.3);
  pdf.line(MARGIN_L, MARGIN_T + 10, PAGE_W - MARGIN_R, MARGIN_T + 10);
}

/** Add page numbers to all pages */
function addPageNumbers(pdf: jsPDF) {
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(160, 160, 170);
    pdf.text(`${i} / ${total}`, PAGE_W / 2, PAGE_H - 10, { align: 'center' });
  }
}

/** Add a section title (e.g. "TEST", "Fórmulas") */
function addSectionTitle(pdf: jsPDF, title: string, y: number): number {
  if (y + 15 > PAGE_H - MARGIN_B) {
    pdf.addPage();
    y = MARGIN_T;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(180, 140, 50); // amber-ish
  pdf.text(title, MARGIN_L, y + 5);

  pdf.setDrawColor(180, 140, 50);
  pdf.setLineWidth(0.4);
  pdf.line(MARGIN_L, y + 8, MARGIN_L + pdf.getTextWidth(title) + 4, y + 8);

  return y + 14;
}

/** Add a topic sub-header */
function addTopicHeader(pdf: jsPDF, topicTitle: string, y: number): number {
  if (y + 12 > PAGE_H - MARGIN_B) {
    pdf.addPage();
    y = MARGIN_T;
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(80, 80, 100);
  pdf.text(topicTitle, MARGIN_L + 2, y + 4);
  return y + 9;
}

/** Add plain text (with automatic wrapping + page breaks) */
function addText(
  pdf: jsPDF,
  text: string,
  y: number,
  opts: { size?: number; bold?: boolean; indent?: number; color?: [number, number, number]; maxWidth?: number } = {},
): number {
  const { size = 10, bold = false, indent = 0, color = [40, 40, 60], maxWidth = CONTENT_W } = opts;
  pdf.setFont('helvetica', bold ? 'bold' : 'normal');
  pdf.setFontSize(size);
  pdf.setTextColor(...color);

  const lines = pdf.splitTextToSize(text, maxWidth - indent);
  const lineH = size * 0.42;

  for (const line of lines) {
    if (y + lineH > PAGE_H - MARGIN_B) {
      pdf.addPage();
      y = MARGIN_T;
    }
    pdf.text(line, MARGIN_L + indent, y);
    y += lineH;
  }
  return y + 1;
}

// ─── Check if text contains LaTeX or Markdown formatting ───────────────────

/**
 * Detects if text contains LaTeX expressions that REQUIRE the
 * HTML→image pipeline.  Simple markdown (bold, italic, code) is
 * handled by stripping the markers and using native jsPDF text,
 * which is orders of magnitude lighter than rasterising to PNG.
 */
function hasLatex(text: string): boolean {
  return /\$[^$]+\$|\\\(|\\\[|\\frac|\\sqrt|\\sum|\\int|\\begin\{/.test(text);
}

/**
 * Strip simple markdown markers so the text reads well as plain text.
 * Does NOT handle LaTeX – that still goes through the image pipeline.
 */
function stripMd(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold
    .replace(/\*([^*]+)\*/g, '$1')        // italic
    .replace(/__([^_]+)__/g, '$1')        // bold alt
    .replace(/~~([^~]+)~~/g, '$1')        // strikethrough
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .trim();
}

// ─── Render question content (plain or with LaTeX) ─────────────────────────

async function renderQuestionContent(
  pdf: jsPDF,
  q: Question,
  idx: number,
  y: number,
): Promise<number> {
  // Question number + prompt
  const promptText = `${idx}. ${q.prompt}`;

  if (hasLatex(q.prompt)) {
    // Render with html2canvas only for LaTeX content
    y = await addMdImageToPdf(pdf, `**${idx}.** ${q.prompt}`, y);
  } else {
    y = addText(pdf, `${idx}. ${stripMd(q.prompt)}`, y, { bold: true, size: 10 });
  }

  // Options for TEST type
  if (q.type === 'TEST' && q.options) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      const isCorrect = q.correctOptionIds?.includes(opt.id);
      const prefix = `${letters[i]}) `;
      const optText = prefix + opt.text;

      if (hasLatex(opt.text)) {
        const md = `${prefix}${opt.text}${isCorrect ? ' **(correcta)**' : ''}`;
        y = await addMdImageToPdf(pdf, md, y, CONTENT_W - 8);
      } else {
        y = addText(pdf, prefix + stripMd(opt.text) + (isCorrect ? ' (correcta)' : ''), y, {
          indent: 6,
          size: 9,
          color: isCorrect ? [34, 120, 60] : [60, 60, 80],
          bold: isCorrect,
        });
      }
    }
  }

  // Model answer for DESARROLLO / PRACTICO
  if ((q.type === 'DESARROLLO' || q.type === 'PRACTICO') && q.modelAnswer) {
    y = addText(pdf, 'Respuesta modelo:', y + 1, { bold: true, size: 9, color: [80, 80, 100] });
    if (hasLatex(q.modelAnswer)) {
      y = await addMdImageToPdf(pdf, q.modelAnswer, y, CONTENT_W - 6);
    } else {
      y = addText(pdf, stripMd(q.modelAnswer), y, { indent: 4, size: 9, color: [60, 60, 80] });
    }
  }

  // Numeric answer for PRACTICO
  if (q.type === 'PRACTICO' && q.numericAnswer) {
    y = addText(pdf, `Resultado: ${q.numericAnswer}`, y, { indent: 4, size: 9, color: [34, 120, 60], bold: true });
  }

  // Cloze text for COMPLETAR
  if (q.type === 'COMPLETAR' && q.clozeText) {
    y = addText(pdf, 'Texto completo:', y + 1, { bold: true, size: 9, color: [80, 80, 100] });
    if (hasLatex(q.clozeText)) {
      y = await addMdImageToPdf(pdf, q.clozeText, y, CONTENT_W - 6);
    } else {
      y = addText(pdf, stripMd(q.clozeText), y, { indent: 4, size: 9, color: [60, 60, 80] });
    }
    if (q.blanks && q.blanks.length > 0) {
      const blanksStr = q.blanks.map((b, i) => `Hueco ${i + 1}: ${b.accepted.join(' / ')}`).join('  |  ');
      y = addText(pdf, blanksStr, y, { indent: 4, size: 8, color: [34, 120, 60] });
    }
  }

  // Explanation
  if (q.explanation) {
    y = addText(pdf, 'Explicación:', y + 1, { bold: true, size: 9, color: [100, 90, 130] });
    if (hasLatex(q.explanation)) {
      y = await addMdImageToPdf(pdf, q.explanation, y, CONTENT_W - 6);
    } else {
      y = addText(pdf, stripMd(q.explanation), y, { indent: 4, size: 9, color: [100, 90, 130] });
    }
  }

  return y + 4;
}

// ─── Public: Generate Questions PDF ─────────────────────────────────────────

export async function generateQuestionsPDF(
  questions: Question[],
  topics: Topic[],
  subjectName: string,
  selectedIds?: Set<string>,
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const selected = selectedIds
    ? questions.filter((q) => selectedIds.has(q.id))
    : questions;

  // Build topic lookup
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  // Group by type, then by topic (alphabetical)
  addHeader(pdf, subjectName, 'Preguntas');
  let y = MARGIN_T + 16;
  let globalIdx = 1;

  for (const type of TYPE_ORDER) {
    const ofType = selected.filter((q) => q.type === type);
    if (ofType.length === 0) continue;

    // Sort by topic title alphabetically
    ofType.sort((a, b) => {
      const ta = topicMap.get(a.topicId)?.title ?? '';
      const tb = topicMap.get(b.topicId)?.title ?? '';
      return ta.localeCompare(tb, 'es');
    });

    y = addSectionTitle(pdf, TYPE_LABELS[type], y);

    let currentTopicId = '';
    for (const q of ofType) {
      if (q.topicId !== currentTopicId) {
        currentTopicId = q.topicId;
        const topicTitle = topicMap.get(q.topicId)?.title ?? 'Sin tema';
        y = addTopicHeader(pdf, topicTitle, y);
      }

      onProgress?.(globalIdx, selected.length);
      y = await renderQuestionContent(pdf, q, globalIdx, y);
      globalIdx++;
    }

    y += 4;
  }

  addPageNumbers(pdf);
  return pdf.output('blob');
}

// ─── Public: Generate Key Concepts PDF ──────────────────────────────────────

export async function generateKeyConceptsPDF(
  concepts: KeyConcept[],
  topics: Topic[],
  subjectName: string,
  selectedIds?: Set<string>,
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const selected = selectedIds
    ? concepts.filter((c) => selectedIds.has(c.id))
    : concepts;

  const topicMap = new Map(topics.map((t) => [t.id, t]));

  addHeader(pdf, subjectName, 'Conceptos Clave');
  let y = MARGIN_T + 16;
  let count = 0;

  for (const cat of CATEGORY_ORDER) {
    const ofCat = selected.filter((c) => c.category === cat);
    if (ofCat.length === 0) continue;

    // Sort by topic title alphabetically
    ofCat.sort((a, b) => {
      const ta = a.topicId ? topicMap.get(a.topicId)?.title ?? '' : '';
      const tb = b.topicId ? topicMap.get(b.topicId)?.title ?? '' : '';
      return ta.localeCompare(tb, 'es');
    });

    y = addSectionTitle(pdf, CATEGORY_LABELS[cat], y);

    let currentTopicId = '__none__';
    for (const c of ofCat) {
      const tid = c.topicId ?? '__none__';
      if (tid !== currentTopicId) {
        currentTopicId = tid;
        const topicTitle = c.topicId ? topicMap.get(c.topicId)?.title ?? 'General' : 'General';
        y = addTopicHeader(pdf, topicTitle, y);
      }

      count++;
      onProgress?.(count, selected.length);

      // Title
      y = addText(pdf, `• ${c.title}`, y, { bold: true, size: 10 });

      // Content (may have LaTeX)
      if (hasLatex(c.content)) {
        y = await addMdImageToPdf(pdf, c.content, y, CONTENT_W - 8);
      } else {
        y = addText(pdf, stripMd(c.content), y, { indent: 6, size: 9, color: [60, 60, 80] });
      }

      y += 3;
    }

    y += 4;
  }

  addPageNumbers(pdf);
  return pdf.output('blob');
}

// ─── Public: Generate Exams PDF ─────────────────────────────────────────────

export async function generateExamsPDF(
  exams: Exam[],
  questions: Question[],
  topics: Topic[],
  subjectName: string,
  selectedIds?: Set<string>,
  onProgress?: (current: number, total: number) => void,
): Promise<Blob> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const selectedExams = selectedIds
    ? exams.filter((e) => selectedIds.has(e.id))
    : exams;

  const questionMap = new Map(questions.map((q) => [q.id, q]));
  const topicMap = new Map(topics.map((t) => [t.id, t]));

  addHeader(pdf, subjectName, 'Exámenes');
  let y = MARGIN_T + 16;
  let totalQ = 0;
  const grandTotal = selectedExams.reduce((sum, e) => sum + e.questionIds.length, 0);

  for (const exam of selectedExams) {
    // Exam title
    if (y + 20 > PAGE_H - MARGIN_B) {
      pdf.addPage();
      y = MARGIN_T;
    }

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(30, 30, 50);
    pdf.text(exam.name, MARGIN_L, y + 5);
    y += 8;

    if (exam.description) {
      y = addText(pdf, exam.description, y, { size: 9, color: [100, 100, 120] });
    }

    // Resolve questions
    const examQuestions = exam.questionIds
      .map((id) => questionMap.get(id))
      .filter(Boolean) as Question[];

    // Group by type, then sort by topic
    for (const type of TYPE_ORDER) {
      const ofType = examQuestions.filter((q) => q.type === type);
      if (ofType.length === 0) continue;

      ofType.sort((a, b) => {
        const ta = topicMap.get(a.topicId)?.title ?? '';
        const tb = topicMap.get(b.topicId)?.title ?? '';
        return ta.localeCompare(tb, 'es');
      });

      y = addSectionTitle(pdf, TYPE_LABELS[type], y);

      let currentTopicId = '';
      let localIdx = 1;
      for (const q of ofType) {
        if (q.topicId !== currentTopicId) {
          currentTopicId = q.topicId;
          const topicTitle = topicMap.get(q.topicId)?.title ?? 'Sin tema';
          y = addTopicHeader(pdf, topicTitle, y);
        }

        totalQ++;
        onProgress?.(totalQ, grandTotal);
        y = await renderQuestionContent(pdf, q, localIdx, y);
        localIdx++;
      }
    }

    y += 8;

    // Separator between exams
    if (y < PAGE_H - MARGIN_B) {
      pdf.setDrawColor(180, 180, 190);
      pdf.setLineWidth(0.2);
      pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y);
      y += 6;
    }
  }

  addPageNumbers(pdf);
  return pdf.output('blob');
}

// ─── Download helper ────────────────────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
