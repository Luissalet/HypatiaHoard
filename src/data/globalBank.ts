/**
 * globalBank.ts
 *
 * Lógica de sincronización con el banco global (public/data/global-bank.json).
 *
 * Reglas de identidad:
 *  - Asignatura  → slugify(name)                     (UUID ignorado)
 *  - Tema        → slugify(subject.name)::slugify(title)
 *  - Pregunta    → contentHash
 *
 * Reglas de NO-sobrescritura:
 *  - examDate    → siempre local, nunca se toca al hacer merge
 *  - stats       → se inicializan a 0 al crear, nunca se sobreescriben
 */

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, getSettings, saveSettings } from './db';
import { slugify } from '@/domain/normalize';
import { computeContentHash } from '@/domain/hashing';
import type { Subject, Topic, Question, PdfAnchor, KeyConcept, BankExport } from '@/domain/models';
import bankJson from './global-bank.json';
// ─── Zod validation (reutiliza estructura BankExport) ────────────────────────

const SubjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
  examDate: z.string().optional(), // será ignorado al hacer merge
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TopicSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  title: z.string(),
  order: z.number(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const QuestionOptionSchema = z.object({ id: z.string(), text: z.string() });
const ClozeBlankSchema = z.object({ id: z.string(), accepted: z.array(z.string()) });
const QuestionStatsSchema = z.object({
  seen: z.number(),
  correct: z.number(),
  wrong: z.number(),
  lastSeenAt: z.string().optional(),
  lastResult: z.enum(['CORRECT', 'WRONG']).optional(),
});

const QuestionSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  topicId: z.string(),
  topicIds: z.array(z.string()).optional(), // ITER3
  type: z.enum(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']),
  prompt: z.string(),
  explanation: z.string().optional(),
  difficulty: z.number().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  options: z.array(QuestionOptionSchema).optional(),
  correctOptionIds: z.array(z.string()).optional(),
  modelAnswer: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  numericAnswer: z.string().optional(), // ITER3
  clozeText: z.string().optional(),
  blanks: z.array(ClozeBlankSchema).optional(),
  pdfAnchorId: z.string().optional(),
  createdBy: z.string().optional(),
  sourcePackId: z.string().optional(),
  contentHash: z.string().optional(),
  stats: QuestionStatsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PdfAnchorSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  pdfId: z.string(),
  page: z.number(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  label: z.string().optional(),
});

const KeyConceptSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  topicId: z.string().optional(),
  category: z.enum(['formula', 'definition', 'remark']),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  order: z.number(),
  createdBy: z.string().optional(),
  sourcePackId: z.string().optional(),
  contentHash: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const BankExportSchema = z.object({
  version: z.literal(1),
  kind: z.literal('bank'),
  exportedAt: z.string(),
  subjects: z.array(SubjectSchema),
  topics: z.array(TopicSchema),
  questions: z.array(QuestionSchema),
  pdfAnchors: z.array(PdfAnchorSchema),
  keyConcepts: z.array(KeyConceptSchema).optional(),
});

// ─── Result ────────────────────────────────────────────────────────────────────

export interface GlobalBankSyncResult {
  subjectsAdded: number;
  topicsAdded: number;
  questionsAdded: number;
  conceptsAdded: number;
  conceptsSkipped: number;
  errors: string[];
  skipped: number; // preguntas ya existentes (deduplicadas)
}

// ─── Fetch + merge ─────────────────────────────────────────────────────────────

/**
 * Descarga /data/global-bank.json y hace merge inteligente en la BD local.
 * Es idempotente: se puede llamar en cada arranque sin duplicar datos.
 */
export async function syncWithGlobalBank(): Promise<GlobalBankSyncResult> {
  return mergeGlobalBank(bankJson);
}

/**
 * Merge inteligente de un BankExport en la BD local.
 * Identidad por slug de nombre, no por UUID.
 * examDate NUNCA se toca.
 * Stats siempre se inicializan a 0 al crear.
 */
export async function mergeGlobalBank(raw: unknown): Promise<GlobalBankSyncResult> {
  const result: GlobalBankSyncResult = {
    subjectsAdded: 0,
    topicsAdded: 0,
    questionsAdded: 0,
    conceptsAdded: 0,
    conceptsSkipped: 0,
    skipped: 0,
    errors: [],
  };

  const parsed = BankExportSchema.safeParse(raw);
  if (!parsed.success) {
    result.errors.push('JSON inválido: ' + parsed.error.message);
    return result;
  }

  const bank = parsed.data as BankExport;
  const now = new Date().toISOString();

  // ── 1. Cargar índices actuales ──────────────────────────────────────────────
  const existingSubjects = await db.subjects.toArray();
  const existingTopics = await db.topics.toArray();

  // Índice: slug → Subject local
  const subjectBySlug = new Map<string, Subject>();
  for (const s of existingSubjects) {
    subjectBySlug.set(slugify(s.name), s);
  }

  // Índice: "subjectSlug::topicSlug" → Topic local
  const topicByKey = new Map<string, Topic>();
  for (const t of existingTopics) {
    const subject = existingSubjects.find((s) => s.id === t.subjectId);
    if (subject) {
      topicByKey.set(`${slugify(subject.name)}::${slugify(t.title)}`, t);
    }
  }

  // Índice de contentHashes ya presentes (para deduplicar preguntas)
  const existingHashes = new Set<string>();
  const allQs = await db.questions.toArray();
  for (const q of allQs) {
    if (q.contentHash) existingHashes.add(q.contentHash);
  }

  // ── 2. Mapping IDs banco → IDs locales ─────────────────────────────────────
  const subjectIdMap = new Map<string, string>(); // bankId → localId
  const topicIdMap = new Map<string, string>();   // bankId → localId
  const anchorIdMap = new Map<string, string>();  // bankId → localId

  // ── 3. Procesar asignaturas ─────────────────────────────────────────────────
  for (const s of bank.subjects) {
    const slug = slugify(s.name);
    const existing = subjectBySlug.get(slug);

    if (existing) {
      // Ya existe: mapear ID, NO tocar examDate ni nada más
      subjectIdMap.set(s.id, existing.id);
    } else {
      // Nueva asignatura: crear SIN examDate (es dato personal del usuario)
      const newSubject: Subject = {
        id: uuidv4(),
        name: s.name,
        color: s.color,
        icon: s.icon,
        // examDate: omitido intencionadamente
        createdAt: now,
        updatedAt: now,
      };
      await db.subjects.add(newSubject);
      subjectBySlug.set(slug, newSubject);
      subjectIdMap.set(s.id, newSubject.id);
      result.subjectsAdded++;
    }
  }

  // ── 4. Procesar temas ───────────────────────────────────────────────────────
  for (const t of bank.topics) {
    const localSubjectId = subjectIdMap.get(t.subjectId);
    if (!localSubjectId) continue; // asignatura no mapeada (error en banco)

    const localSubject = [...subjectBySlug.values()].find((s) => s.id === localSubjectId);
    if (!localSubject) continue;

    const compositeKey = `${slugify(localSubject.name)}::${slugify(t.title)}`;
    const existing = topicByKey.get(compositeKey);

    if (existing) {
      topicIdMap.set(t.id, existing.id);
    } else {
      // Calcular orden: uno más que los temas existentes de esta asignatura
      const currentTopics = [...topicByKey.values()].filter((x) => x.subjectId === localSubjectId);
      const newTopic: Topic = {
        id: uuidv4(),
        subjectId: localSubjectId,
        title: t.title,
        order: currentTopics.length,
        tags: t.tags,
        createdAt: now,
        updatedAt: now,
      };
      await db.topics.add(newTopic);
      topicByKey.set(compositeKey, newTopic);
      topicIdMap.set(t.id, newTopic.id);
      result.topicsAdded++;
    }
  }

  // ── 5. Procesar pdfAnchors ──────────────────────────────────────────────────
  // Construir índice de anchors existentes (por pdfId + page + label) para evitar duplicados
  const existingAnchors = await db.pdfAnchors.toArray();
  const anchorKey = (subjectId: string, pdfId: string, page: number, label?: string) =>
    `${subjectId}::${pdfId}::${page}::${label ?? ''}`;
  const existingAnchorKeys = new Set(
    existingAnchors.map((a) => anchorKey(a.subjectId, a.pdfId, a.page, a.label))
  );

  for (const a of bank.pdfAnchors) {
    const localSubjectId = subjectIdMap.get(a.subjectId);
    if (!localSubjectId) continue;
    const key = anchorKey(localSubjectId, a.pdfId, a.page, a.label);
    if (existingAnchorKeys.has(key)) {
      // Ya existe: mapear al anchor existente
      const existing = existingAnchors.find(
        (ea) => anchorKey(ea.subjectId, ea.pdfId, ea.page, ea.label) === key
      );
      if (existing) anchorIdMap.set(a.id, existing.id);
      continue;
    }
    const newId = uuidv4();
    anchorIdMap.set(a.id, newId);
    await db.pdfAnchors.add({ ...a, id: newId, subjectId: localSubjectId });
    existingAnchorKeys.add(key);
  }

  // ── 6. Procesar preguntas ───────────────────────────────────────────────────
  for (const q of bank.questions) {
    const localSubjectId = subjectIdMap.get(q.subjectId);
    const localTopicId = topicIdMap.get(q.topicId);
    if (!localSubjectId || !localTopicId) continue;

    // SIEMPRE recomputar el hash con el algoritmo actual para deduplicar correctamente.
    // No confiar en el hash almacenado en el JSON: puede haber sido generado
    // con una versión anterior del algoritmo (ej. incluía topicKey, IDs crudos, etc.)
    const hash = await computeContentHash(q);

    // Deduplicar por contentHash
    if (existingHashes.has(hash)) {
      result.skipped++;
      continue;
    }

    const newAnchorId = q.pdfAnchorId ? (anchorIdMap.get(q.pdfAnchorId) ?? undefined) : undefined;

    const newQuestion: Question = {
      ...q,
      id: uuidv4(),
      subjectId: localSubjectId,
      topicId: localTopicId,
      pdfAnchorId: newAnchorId,
      contentHash: hash,
      // Stats siempre a 0 — cada usuario empieza desde cero
      stats: { seen: 0, correct: 0, wrong: 0 },
      createdAt: now,
      updatedAt: now,
    };

    await db.questions.add(newQuestion);
    existingHashes.add(hash);
    result.questionsAdded++;
  }

  // ── 7. Procesar conceptos clave ──────────────────────────────────────────────
  if (bank.keyConcepts && bank.keyConcepts.length > 0) {
    // Índice de contentHashes existentes para deduplicar
    const existingConceptHashes = new Set<string>();
    const allConcepts = await db.keyConcepts.toArray();
    for (const kc of allConcepts) {
      if (kc.contentHash) existingConceptHashes.add(kc.contentHash);
    }

    for (const kc of bank.keyConcepts) {
      const localSubjectId = subjectIdMap.get(kc.subjectId);
      if (!localSubjectId) continue;

      // Deduplicar por contentHash
      if (kc.contentHash && existingConceptHashes.has(kc.contentHash)) {
        result.conceptsSkipped++;
        continue;
      }

      // Mapear topicId si existe
      let localTopicId: string | undefined;
      if (kc.topicId) {
        localTopicId = topicIdMap.get(kc.topicId);
      }

      const newConcept: KeyConcept = {
        ...kc,
        id: uuidv4(),
        subjectId: localSubjectId,
        topicId: localTopicId,
        sourcePackId: undefined,
        createdAt: now,
        updatedAt: now,
      };

      await db.keyConcepts.add(newConcept);
      if (kc.contentHash) existingConceptHashes.add(kc.contentHash);
      result.conceptsAdded++;
    }
  }

  // ── 8. Guardar timestamp de última sincronización ───────────────────────────
  await saveSettings({ globalBankSyncedAt: now } as never);

  return result;
}
