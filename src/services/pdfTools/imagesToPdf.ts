/**
 * imagesToPdf.ts — Convertir imágenes a PDF.
 */

import { PDFDocument, PageSizes } from 'pdf-lib';

export type PageSize = 'A4' | 'Letter' | 'fit';
export type Orientation = 'portrait' | 'landscape' | 'auto';

export interface ImagesToPdfOptions {
  pageSize?: PageSize;
  orientation?: Orientation;
  marginMm?: number;
}

function mmToPoints(mm: number): number {
  return mm * 2.8346456693;
}

async function loadImage(file: File): Promise<{ bytes: Uint8Array; type: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const type = file.type.toLowerCase();
  return { bytes, type };
}

export async function imagesToPdf(
  files: File[],
  options: ImagesToPdfOptions = {},
): Promise<Blob> {
  if (files.length === 0) throw new Error('No hay imágenes.');

  const { pageSize = 'A4', orientation = 'auto', marginMm = 10 } = options;
  const margin = mmToPoints(marginMm);
  const doc = await PDFDocument.create();

  for (const file of files) {
    const { bytes, type } = await loadImage(file);

    let image;
    if (type === 'image/png') {
      image = await doc.embedPng(bytes);
    } else if (type === 'image/jpeg' || type === 'image/jpg') {
      image = await doc.embedJpg(bytes);
    } else {
      // Try to convert via canvas for other formats
      const img = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type }));
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const pngDataUrl = canvas.toDataURL('image/png');
      const pngBase64 = pngDataUrl.split(',')[1];
      const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      image = await doc.embedPng(pngBytes);
    }

    const imgW = image.width;
    const imgH = image.height;

    let pageW: number;
    let pageH: number;

    if (pageSize === 'fit') {
      // Page fits the image
      pageW = imgW + margin * 2;
      pageH = imgH + margin * 2;
    } else {
      const base = pageSize === 'A4' ? PageSizes.A4 : PageSizes.Letter;

      // Determine orientation
      let isLandscape: boolean;
      if (orientation === 'landscape') {
        isLandscape = true;
      } else if (orientation === 'portrait') {
        isLandscape = false;
      } else {
        // auto: match image aspect ratio
        isLandscape = imgW > imgH;
      }

      pageW = isLandscape ? Math.max(base[0], base[1]) : Math.min(base[0], base[1]);
      pageH = isLandscape ? Math.min(base[0], base[1]) : Math.max(base[0], base[1]);
    }

    const page = doc.addPage([pageW, pageH]);

    // Scale image to fit within margins
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const scale = Math.min(availW / imgW, availH / imgH, 1);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    // Center on page
    const x = margin + (availW - drawW) / 2;
    const y = margin + (availH - drawH) / 2;

    page.drawImage(image, { x, y, width: drawW, height: drawH });
  }

  const pdfBytes = await doc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}
