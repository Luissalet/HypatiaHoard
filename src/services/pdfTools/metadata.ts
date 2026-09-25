/**
 * metadata.ts — Leer y editar metadatos de un PDF.
 */

import { PDFDocument } from 'pdf-lib';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

/** Lee los metadatos actuales de un PDF */
export async function readMetadata(file: File): Promise<PdfMetadata> {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes);
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: (doc.getKeywords() ?? ''),
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
  };
}

/** Modifica los metadatos de un PDF */
export async function editMetadata(
  file: File,
  metadata: PdfMetadata,
): Promise<Blob> {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes);

  if (metadata.title !== undefined) doc.setTitle(metadata.title);
  if (metadata.author !== undefined) doc.setAuthor(metadata.author);
  if (metadata.subject !== undefined) doc.setSubject(metadata.subject);
  if (metadata.keywords !== undefined) doc.setKeywords([metadata.keywords]);
  if (metadata.creator !== undefined) doc.setCreator(metadata.creator);

  const pdfBytes = await doc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}
