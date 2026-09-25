/**
 * split.ts — Dividir un PDF por páginas, cada N páginas, o rangos personalizados.
 */

import { PDFDocument } from 'pdf-lib';

export type SplitMode = 'by_pages' | 'every_n' | 'ranges';

export interface SplitOptions {
  /** Para 'every_n': número de páginas por fragmento */
  n?: number;
  /** Para 'ranges': string tipo "1-3, 5, 8-12" */
  ranges?: string;
}

export interface SplitResult {
  name: string;
  blob: Blob;
}

/** Parsea rangos tipo "1-3, 5, 8-12" a arrays de índices 0-based */
export function parsePageRanges(input: string, totalPages: number): number[] {
  const pages: Set<number> = new Set();
  const parts = input.split(',').map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1]));
      const end = Math.min(totalPages, parseInt(rangeMatch[2]));
      for (let i = start; i <= end; i++) pages.add(i - 1);
    } else {
      const num = parseInt(part);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        pages.add(num - 1);
      }
    }
  }

  return [...pages].sort((a, b) => a - b);
}

export async function splitPdf(
  file: File,
  mode: SplitMode,
  options: SplitOptions = {},
): Promise<SplitResult[]> {
  const bytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(bytes);
  const totalPages = srcDoc.getPageCount();
  const baseName = file.name.replace(/\.pdf$/i, '');
  const results: SplitResult[] = [];

  if (mode === 'by_pages') {
    // Each page becomes its own PDF
    for (let i = 0; i < totalPages; i++) {
      const newDoc = await PDFDocument.create();
      const [page] = await newDoc.copyPages(srcDoc, [i]);
      newDoc.addPage(page);
      const pdfBytes = await newDoc.save();
      results.push({
        name: `${baseName}_pag${i + 1}.pdf`,
        blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
      });
    }
  } else if (mode === 'every_n') {
    const n = options.n ?? 1;
    if (n < 1) throw new Error('N debe ser mayor que 0');
    let chunk = 1;
    for (let start = 0; start < totalPages; start += n) {
      const end = Math.min(start + n, totalPages);
      const newDoc = await PDFDocument.create();
      const indices = Array.from({ length: end - start }, (_, i) => start + i);
      const pages = await newDoc.copyPages(srcDoc, indices);
      for (const page of pages) newDoc.addPage(page);
      const pdfBytes = await newDoc.save();
      results.push({
        name: `${baseName}_parte${chunk}.pdf`,
        blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
      });
      chunk++;
    }
  } else if (mode === 'ranges') {
    const rangeStr = options.ranges ?? '';
    const indices = parsePageRanges(rangeStr, totalPages);
    if (indices.length === 0) throw new Error('No se encontraron páginas válidas en el rango.');

    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, indices);
    for (const page of pages) newDoc.addPage(page);
    const pdfBytes = await newDoc.save();
    results.push({
      name: `${baseName}_extracto.pdf`,
      blob: new Blob([pdfBytes as BlobPart], { type: 'application/pdf' }),
    });
  }

  return results;
}
