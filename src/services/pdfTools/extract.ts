/**
 * extract.ts — Extraer páginas específicas de un PDF.
 */

import { PDFDocument } from 'pdf-lib';

/**
 * Extrae las páginas indicadas (1-based) y devuelve un nuevo PDF.
 */
export async function extractPages(
  file: File,
  pageNumbers: number[], // 1-based
): Promise<Blob> {
  if (pageNumbers.length === 0) throw new Error('No hay páginas seleccionadas.');

  const bytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(bytes);
  const totalPages = srcDoc.getPageCount();

  const indices = pageNumbers
    .map((n) => n - 1)
    .filter((i) => i >= 0 && i < totalPages)
    .sort((a, b) => a - b);

  if (indices.length === 0) throw new Error('Ninguna página válida.');

  const newDoc = await PDFDocument.create();
  const pages = await newDoc.copyPages(srcDoc, indices);
  for (const page of pages) newDoc.addPage(page);

  const pdfBytes = await newDoc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}

/** Helper: get page count from a file without fully loading */
export async function getPdfPageCount(file: File): Promise<number> {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}
