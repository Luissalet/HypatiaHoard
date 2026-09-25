/**
 * merge.ts — Unir múltiples PDFs en uno solo.
 */

import { PDFDocument } from 'pdf-lib';

export async function mergePdfs(files: File[]): Promise<Blob> {
  if (files.length === 0) throw new Error('No hay archivos para unir.');

  const merged = await PDFDocument.create();

  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) {
      merged.addPage(page);
    }
  }

  const pdfBytes = await merged.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}
