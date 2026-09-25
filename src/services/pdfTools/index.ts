/**
 * PDF Tools — Herramientas de manipulación de PDF client-side.
 * Todas las funciones son 100% client-side (compatible con GitHub Pages).
 */

export { mergePdfs } from './merge';
export { splitPdf, parsePageRanges, type SplitMode, type SplitOptions, type SplitResult } from './split';
export { extractPages, getPdfPageCount } from './extract';
export { rotatePdf, type RotationDegrees } from './rotate';
export { imagesToPdf, type PageSize, type Orientation, type ImagesToPdfOptions } from './imagesToPdf';
export { addWatermark, type WatermarkOptions } from './watermark';
export { readMetadata, editMetadata, type PdfMetadata } from './metadata';

/** Helper to download a blob */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Format file size in human-readable form */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
