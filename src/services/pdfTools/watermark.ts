/**
 * watermark.ts — Añadir marca de agua de texto a un PDF.
 */

import { PDFDocument, rgb, degrees as pdfDegrees, StandardFonts } from 'pdf-lib';

export interface WatermarkOptions {
  opacity?: number;     // 0-1, default 0.15
  angle?: number;       // degrees, default -45
  fontSize?: number;    // default 48
}

export async function addWatermark(
  file: File,
  text: string,
  options: WatermarkOptions = {},
): Promise<Blob> {
  if (!text.trim()) throw new Error('El texto de marca de agua no puede estar vacío.');

  const { opacity = 0.15, angle = -45, fontSize = 48 } = options;

  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  const totalPages = doc.getPageCount();

  for (let i = 0; i < totalPages; i++) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const x = (width - textWidth) / 2;
    const y = height / 2;

    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity,
      rotate: pdfDegrees(angle),
    });
  }

  const pdfBytes = await doc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}
