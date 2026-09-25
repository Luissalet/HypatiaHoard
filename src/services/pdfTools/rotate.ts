/**
 * rotate.ts — Rotar páginas de un PDF.
 */

import { PDFDocument, degrees } from 'pdf-lib';

export type RotationDegrees = 90 | 180 | 270;

/**
 * Rota páginas del PDF.
 * @param pageNumbers — 1-based. Si vacío o undefined, rota todas.
 */
export async function rotatePdf(
  file: File,
  rotation: RotationDegrees,
  pageNumbers?: number[], // 1-based, empty = all
): Promise<Blob> {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes);
  const totalPages = doc.getPageCount();

  const indicesToRotate = pageNumbers && pageNumbers.length > 0
    ? new Set(pageNumbers.map((n) => n - 1).filter((i) => i >= 0 && i < totalPages))
    : new Set(Array.from({ length: totalPages }, (_, i) => i));

  for (const idx of indicesToRotate) {
    const page = doc.getPage(idx);
    const currentRotation = page.getRotation().angle;
    page.setRotation(degrees(currentRotation + rotation));
  }

  const pdfBytes = await doc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}
