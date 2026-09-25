/**
 * exportCompact.ts
 * 
 * Exportación ultra-compacta de preguntas por asignatura
 * para que ChatGPT pueda tener el banco de preguntas sin procesar
 * miles de líneas de JSON.
 * 
 * Solo incluye: tipo, prompt, hash y tema.
 */

import { db } from './db';
import { questionRepo, topicRepo } from './repos';
import { slugify } from '@/domain/normalize';

export interface CompactQuestion {
  /** Tipo: T=TEST, D=DESARROLLO, C=COMPLETAR, P=PRACTICO */
  t: 'T' | 'D' | 'C' | 'P';
  /** Prompt de la pregunta */
  p: string;
  /** Hash de contenido (para deduplicación) */
  h?: string;
  /** Tema (slug) */
  tp?: string;
}

export interface CompactSubjectExport {
  /** Nombre de la asignatura */
  asignatura: string;
  /** Slug de la asignatura */
  slug: string;
  /** Total de preguntas */
  total: number;
  /** Preguntas en formato compacto */
  preguntas: CompactQuestion[];
}

/**
 * Exporta las preguntas de una asignatura en formato ultra-compacto
 * para que ChatGPT pueda verificar el banco sin procesar miles de líneas.
 */
export async function exportCompactSubject(subjectId: string): Promise<CompactSubjectExport> {
  const subject = await db.subjects.get(subjectId);
  if (!subject) {
    throw new Error('Asignatura no encontrada');
  }

  const questions = await questionRepo.getBySubject(subjectId);
  const topics = await topicRepo.getBySubject(subjectId);
  
  const topicMap = new Map(topics.map(t => [t.id, slugify(t.title)]));

  const compactQuestions: CompactQuestion[] = questions.map(q => {
    // Tipo abreviado
    const typeMap: Record<string, 'T' | 'D' | 'C' | 'P'> = {
      'TEST': 'T',
      'DESARROLLO': 'D',
      'COMPLETAR': 'C',
      'PRACTICO': 'P'
    };

    return {
      t: typeMap[q.type] || 'T',
      p: q.prompt,
      h: q.contentHash,
      tp: topicMap.get(q.topicId),
    };
  });

  return {
    asignatura: subject.name,
    slug: slugify(subject.name),
    total: questions.length,
    preguntas: compactQuestions,
  };
}

/**
 * Exporta TODAS las asignaturas en formato compacto
 */
export async function exportAllCompactSubjects(): Promise<CompactSubjectExport[]> {
  const subjects = await db.subjects.toArray();
  const exports: CompactSubjectExport[] = [];

  for (const subject of subjects) {
    const compact = await exportCompactSubject(subject.id);
    exports.push(compact);
  }

  return exports;
}
