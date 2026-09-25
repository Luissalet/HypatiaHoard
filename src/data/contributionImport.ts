import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db } from './db';
import { getSettings, saveSettings } from './db';
import { slugify } from '@/domain/normalize';
import { computeContentHash } from '@/domain/hashing';
import { buildImageMap, importImages, extractImageFilenames } from './questionImageStorage';
import type { ContributionPack, Subject, Topic, Question,ImportHistoryEntry } from '@/domain/models';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ContributionQuestionSchema = z.object({
  id: z.string(),
  // Optional: "loose" packs (creados para una asignatura sin temas) omiten
  // subjectKey/topicKey. Al importarse desde dentro de una asignatura, las
  // preguntas se asignan automáticamente a esa asignatura (sin tema).
  subjectKey: z.string().optional(),
  topicKey: z.string().optional(),
  type: z.enum(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']),
  prompt: z.string(),
  origin: z.enum(['test', 'examen_anterior', 'clase', 'alumno']).optional(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  correctOptionIds: z.array(z.string()).optional(),
  modelAnswer: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  numericAnswer: z.string().optional(),
  clozeText: z.string().optional(),
  blanks: z.array(z.object({ id: z.string(), accepted: z.array(z.string()) })).optional(),
  explanation: z.string().optional(),
  difficulty: z.number().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  topicKeys: z.array(z.string()).optional(),
  pdfAnchor: z.object({ page: z.number(), label: z.string().optional() }).optional(),
  createdBy: z.string().optional(),
  contentHash: z.string().optional(),
  imageDataUrls: z.array(z.string()).optional(),
});

const ContributionPackSchema = z.object({
  version: z.literal(1),
  kind: z.literal('contribution'),
  packId: z.string(),
  createdBy: z.string(),
  exportedAt: z.string(),
  targets: z.array(
    z.object({
      subjectKey: z.string(),
      subjectName: z.string(),
      topics: z.array(z.object({ topicKey: z.string(), topicTitle: z.string() })),
    })
  ),
  questions: z.array(ContributionQuestionSchema),
  // ITER4 — inline images
  questionImages: z.record(z.string(), z.string()).optional(),
});

// ─── Import result ─────────────────────────────────────────────────────────────

export interface UnmatchedTopic {
  subjectKey: string;
  topicKey: string;
  topicTitle: string;
  questionCount: number;
}

export interface ContributionImportResult {
  packId: string;
  createdBy: string;
  newQuestions: number;
  duplicates: number;
  newTopicsCreated: number;
  newSubjectsCreated: number;
  alreadyImported: boolean;
  errors: string[];
  /** Topics in the pack that couldn't be matched to existing topics */
  unmatchedTopics: UnmatchedTopic[];
  /** Questions skipped because their topic couldn't be matched */
  skippedUnmatched: number;
}

// ─── Main merge function ───────────────────────────────────────────────────────

/**
 * Optional topic mappings: maps "subjectKey::topicKey" to an existing topic ID.
 * Used when a first import attempt found unmatched topics and the user manually
 * selected which existing topic to map them to.
 */
export type TopicMappings = Record<string, string>;

let _importInProgress = false;

/**
 * @param targetSubjectId  Si se especifica (import desde DENTRO de una asignatura),
 *   TODAS las preguntas del pack se asignan a esa asignatura, ignorando el
 *   subjectKey del pack. El tema se resuelve por título dentro de esa asignatura
 *   si la pregunta trae topicKey; si no coincide (o no hay topicKey) la pregunta
 *   se importa sin tema (topicId ''). Esto habilita los "loose packs" que no
 *   especifican asignatura ni temas por pregunta.
 */
export async function importContributionPack(raw: unknown, topicMappings?: TopicMappings, targetSubjectId?: string): Promise<ContributionImportResult> {
  // Guard against concurrent calls (prevents duplicates from double-clicks / re-entry)
  if (_importInProgress) {
    return {
      packId: '', createdBy: '', newQuestions: 0, duplicates: 0,
      newTopicsCreated: 0, newSubjectsCreated: 0, alreadyImported: true, errors: [],
      unmatchedTopics: [], skippedUnmatched: 0,
    };
  }
  _importInProgress = true;

  const result: ContributionImportResult = {
    packId: '',
    createdBy: '',
    newQuestions: 0,
    duplicates: 0,
    newTopicsCreated: 0,
    newSubjectsCreated: 0,
    alreadyImported: false,
    errors: [],
    unmatchedTopics: [],
    skippedUnmatched: 0,
  };

  try {
  // Validate
  const parsed = ContributionPackSchema.safeParse(raw);
  if (!parsed.success) {
    result.errors.push('JSON inválido: ' + parsed.error.message);
    return result;
  }

  const pack = parsed.data as ContributionPack;
  result.packId = pack.packId;
  result.createdBy = pack.createdBy;

  // Check if already imported
  const settings = await getSettings();
  if (settings.importedPackIds.includes(pack.packId)) {
    result.alreadyImported = true;
    return result;
  }

  // ITER4 — Import images first (before questions so they're available immediately)
  if (pack.questionImages && Object.keys(pack.questionImages).length > 0) {
    try {
      await importImages(pack.questionImages);
    } catch (err) {
      result.errors.push(`Aviso: error importando imágenes: ${String(err)}`);
      // Don't abort — questions can still be imported
    }
  }

  const now = new Date().toISOString();

  // Build lookup maps: subjectKey -> Subject, topicKey -> Topic
  const allSubjects = await db.subjects.toArray();
  const allTopics = await db.topics.toArray();

  const subjectByKey = new Map<string, Subject>();
  for (const s of allSubjects) {
    subjectByKey.set(slugify(s.name), s);
  }

  const topicByKey = new Map<string, Topic>();
  for (const t of allTopics) {
    const subject = allSubjects.find((s) => s.id === t.subjectId);
    if (subject) {
      const key = `${slugify(subject.name)}::${slugify(t.title)}`;
      topicByKey.set(key, t);
    }
  }

  // Import "into current subject": all questions land in this subject, topic optional.
  const forcedSubject = targetSubjectId
    ? allSubjects.find((s) => s.id === targetSubjectId)
    : undefined;
  if (targetSubjectId && !forcedSubject) {
    result.errors.push('Asignatura destino no encontrada');
    return result;
  }

  // Process each question
  for (const cq of pack.questions) {
    try {
      // ── Resolve subject ──────────────────────────────────────────────
      let subject: Subject | undefined;
      let subjectKey: string;

      if (forcedSubject) {
        // Import desde dentro de una asignatura → forzar esa asignatura
        subject = forcedSubject;
        subjectKey = slugify(forcedSubject.name);
      } else {
        // Import global (Ajustes) → usar subjectKey del pack (loose packs no valen aquí)
        if (!cq.subjectKey) {
          result.errors.push(
            `La pregunta ${cq.id} no especifica asignatura. Importa este pack desde dentro de una asignatura.`
          );
          continue;
        }
        subjectKey = cq.subjectKey;
        subject = subjectByKey.get(subjectKey);
        if (!subject) {
          const targetInfo = pack.targets.find((t) => t.subjectKey === subjectKey);
          const subjectName = targetInfo?.subjectName ?? subjectKey;
          subject = {
            id: uuidv4(),
            name: subjectName,
            createdAt: now,
            updatedAt: now,
          };
          await db.subjects.add(subject);
          subjectByKey.set(subjectKey, subject);
          result.newSubjectsCreated++;
        }
      }

      // ── Resolve topic — never create topics, only match existing ones ──
      const topicKey = cq.topicKey;
      const topicMapKey = topicKey ? `${subjectKey}::${topicKey}` : '';
      let topic = topicKey ? topicByKey.get(topicMapKey) : undefined;

      // Check manual topic mappings if provided
      if (!topic && topicKey && topicMappings) {
        const mappedTopicId = topicMappings[topicMapKey];
        if (mappedTopicId) {
          const mappedTopic = allTopics.find((t) => t.id === mappedTopicId);
          if (mappedTopic) {
            topic = mappedTopic;
            topicByKey.set(topicMapKey, mappedTopic);
          }
        }
      }

      if (!topic && !forcedSubject) {
        // Modo global: sin tema que coincida, se salta (comportamiento original)
        const alreadyTracked = result.unmatchedTopics.some(
          (ut) => ut.subjectKey === subjectKey && ut.topicKey === (topicKey ?? '')
        );
        if (!alreadyTracked) {
          const targetInfo = pack.targets.find((t) => t.subjectKey === subjectKey);
          const topicInfo = targetInfo?.topics.find((t) => t.topicKey === topicKey);
          const topicTitle = topicInfo?.topicTitle ?? topicKey ?? '';
          const questionCount = pack.questions.filter((q) => q.topicKey === topicKey && q.subjectKey === subjectKey).length;
          result.unmatchedTopics.push({ subjectKey, topicKey: topicKey ?? '', topicTitle, questionCount });
        }
        result.skippedUnmatched++;
        continue;
      }
      // Modo asignatura (forcedSubject): si no hay tema que coincida, se importa sin tema (topicId '')

      // Compute content hash for deduplication
      const hashToCheck = cq.contentHash ?? await computeContentHash(cq, cq.topicKey);

      // Check for duplicate
      const isDuplicate = await db.questions
        .where('contentHash')
        .equals(hashToCheck)
        .and((q) => q.subjectId === subject!.id)
        .count() > 0;

      if (isDuplicate) {
        result.duplicates++;
        continue;
      }

      // Prepare topicKeys for multi-topic questions
      let finalTopicIds: string[] | undefined;
      if (cq.topicKeys && cq.topicKeys.length > 1) {
        finalTopicIds = [];
        for (const topicSlug of cq.topicKeys) {
          const key = `${subjectKey}::${topicSlug}`;
          const resolvedTopic = topicByKey.get(key);
          if (resolvedTopic) {
            finalTopicIds.push(resolvedTopic.id);
          }
        }
        if (finalTopicIds.length <= 1) {
          finalTopicIds = undefined;
        }
      }

      // Insert new question
      const newQuestion: Question = {
        id: uuidv4(),
        subjectId: subject!.id,
        topicId: topic?.id ?? '',
        topicIds: finalTopicIds,
        type: cq.type,
        prompt: cq.prompt,
        explanation: cq.explanation,
        difficulty: cq.difficulty as Question['difficulty'],
        tags: cq.tags,
        origin: cq.origin,
        options: cq.options,
        correctOptionIds: cq.correctOptionIds,
        modelAnswer: cq.modelAnswer,
        keywords: cq.keywords,
        numericAnswer: cq.numericAnswer,
        clozeText: cq.clozeText,
        blanks: cq.blanks,
        imageDataUrls: cq.imageDataUrls,
        contentHash: hashToCheck,
        createdBy: cq.createdBy ?? pack.createdBy,
        sourcePackId: pack.packId,
        stats: { seen: 0, correct: 0, wrong: 0 },
        createdAt: now,
        updatedAt: now,
      };

      // Handle PDF anchor if present
      if (cq.pdfAnchor) {
        const anchor = {
          id: uuidv4(),
          subjectId: subject!.id,
          pdfId: 'pending',
          page: cq.pdfAnchor.page,
          label: cq.pdfAnchor.label,
        };
        await db.pdfAnchors.add(anchor);
        newQuestion.pdfAnchorId = anchor.id;
      }

      await db.questions.add(newQuestion);
      result.newQuestions++;
    } catch (err) {
      result.errors.push(`Error procesando pregunta ${cq.id}: ${String(err)}`);
    }
  }

  // Mark pack as imported
  const updatedSettings = await getSettings();

  // Nombre de las asignaturas afectadas
  const affectedSubjectNames = forcedSubject
    ? [forcedSubject.name]
    : pack.targets.map(t => t.subjectName);

  const historyEntry: ImportHistoryEntry = {
    packId: pack.packId,
    createdBy: pack.createdBy,
    importedAt: now,
    questionCount: result.newQuestions,
    subjectNames: affectedSubjectNames,
  };

  await saveSettings({
    importedPackIds: [...updatedSettings.importedPackIds, pack.packId],
    importHistory: [...(updatedSettings.importHistory ?? []), historyEntry],
  });

  return result;
  } finally {
    _importInProgress = false;
  }
}

// ─── Export contribution pack ──────────────────────────────────────────────────

export async function exportContributionPack(
  alias: string,
  subjectId: string,
  topicId?: string
): Promise<ContributionPack> {
  const subject = await db.subjects.get(subjectId);
  if (!subject) throw new Error('Asignatura no encontrada');

  let questions = topicId
    ? await db.questions.where('topicId').equals(topicId).and((q) => q.createdBy === alias).toArray()
    : await db.questions.where('subjectId').equals(subjectId).and((q) => q.createdBy === alias).toArray();

  if (!alias) {
    // If no alias, export all questions from subject
    questions = topicId
      ? await db.questions.where('topicId').equals(topicId).toArray()
      : await db.questions.where('subjectId').equals(subjectId).toArray();
  }

  const topicIds = [...new Set(questions.map((q) => q.topicId))];
  const topics = await db.topics.where('id').anyOf(topicIds).toArray();

  const targets = [
    {
      subjectKey: slugify(subject.name),
      subjectName: subject.name,
      topics: topics.map((t) => ({
        topicKey: slugify(t.title),
        topicTitle: t.title,
      })),
    },
  ];

  const contributionQuestions = questions.map((q) => {
    const topic = topics.find((t) => t.id === q.topicId);

    let topicKeysSlugs: string[] | undefined;
    if (q.topicIds && q.topicIds.length > 1) {
      topicKeysSlugs = q.topicIds.map((tid) => {
        const t = topics.find((topic) => topic.id === tid);
        return t ? slugify(t.title) : tid;
      });
    }

    return {
      id: q.id,
      subjectKey: slugify(subject.name),
      topicKey: topic ? slugify(topic.title) : q.topicId,
      topicKeys: topicKeysSlugs,
      type: q.type,
      prompt: q.prompt,
      origin: q.origin,
      options: q.options,
      correctOptionIds: q.correctOptionIds,
      modelAnswer: q.modelAnswer,
      keywords: q.keywords,
      numericAnswer: q.numericAnswer,
      clozeText: q.clozeText,
      blanks: q.blanks,
      imageDataUrls: q.imageDataUrls,
      explanation: q.explanation,
      difficulty: q.difficulty,
      tags: q.tags,
      createdBy: q.createdBy ?? alias,
      contentHash: q.contentHash,
    };
  });

  // ITER4 — collect all inline images from questions
  const allTexts: string[] = [];
  for (const q of contributionQuestions) {
    if (q.prompt) allTexts.push(q.prompt);
    if (q.explanation) allTexts.push(q.explanation);
    if (q.modelAnswer) allTexts.push(q.modelAnswer);
    if (q.clozeText) allTexts.push(q.clozeText);
  }
  const questionImages = await buildImageMap(allTexts);

  return {
    version: 1,
    kind: 'contribution',
    packId: uuidv4(),
    createdBy: alias || 'unknown',
    exportedAt: new Date().toISOString(),
    targets,
    questions: contributionQuestions,
    questionImages: Object.keys(questionImages).length > 0 ? questionImages : undefined,
  };
}

/**
 * C2: Export a contribution pack from specific question IDs (selective export).
 */
export async function exportContributionPackByIds(
  alias: string,
  questionIds: string[],
): Promise<ContributionPack> {
  const questions = await db.questions.where('id').anyOf(questionIds).toArray();
  if (questions.length === 0) throw new Error('No se encontraron preguntas');

  const subjectIds = [...new Set(questions.map((q) => q.subjectId))];
  const subjects = await db.subjects.where('id').anyOf(subjectIds).toArray();
  const topicIds = [...new Set(questions.map((q) => q.topicId))];
  const topics = await db.topics.where('id').anyOf(topicIds).toArray();

  const targets = subjects.map((s) => ({
    subjectKey: slugify(s.name),
    subjectName: s.name,
    topics: topics
      .filter((t) => t.subjectId === s.id)
      .map((t) => ({ topicKey: slugify(t.title), topicTitle: t.title })),
  }));

  const contributionQuestions = questions.map((q) => {
    const subject = subjects.find((s) => s.id === q.subjectId);
    const topic = topics.find((t) => t.id === q.topicId);
    return {
      id: q.id,
      subjectKey: subject ? slugify(subject.name) : q.subjectId,
      topicKey: topic ? slugify(topic.title) : q.topicId,
      type: q.type,
      prompt: q.prompt,
      origin: q.origin,
      options: q.options,
      correctOptionIds: q.correctOptionIds,
      modelAnswer: q.modelAnswer,
      keywords: q.keywords,
      numericAnswer: q.numericAnswer,
      clozeText: q.clozeText,
      blanks: q.blanks,
      imageDataUrls: q.imageDataUrls,
      explanation: q.explanation,
      difficulty: q.difficulty,
      tags: q.tags,
      createdBy: q.createdBy ?? alias,
      contentHash: q.contentHash,
    };
  });

  const allTexts: string[] = [];
  for (const q of contributionQuestions) {
    if (q.prompt) allTexts.push(q.prompt);
    if (q.explanation) allTexts.push(q.explanation);
    if (q.modelAnswer) allTexts.push(q.modelAnswer);
    if (q.clozeText) allTexts.push(q.clozeText);
  }
  const questionImages = await buildImageMap(allTexts);

  return {
    version: 1,
    kind: 'contribution',
    packId: uuidv4(),
    createdBy: alias || 'unknown',
    exportedAt: new Date().toISOString(),
    targets,
    questions: contributionQuestions,
    questionImages: Object.keys(questionImages).length > 0 ? questionImages : undefined,
  };
}

export interface UndoImportResult {
  packId: string;
  deletedQuestions: number;
}

export async function undoContributionImport(packId: string): Promise<UndoImportResult> {
  // sourcePackId no está indexado en Dexie: un where() rechaza (y Dexie lo avisa en consola
  // como "Unhandled rejection" aunque se capture), así que se filtra directamente.
  const allQuestions = await db.questions.filter(q => q.sourcePackId === packId).toArray();

  const ids = allQuestions.map(q => q.id);
  await db.questions.bulkDelete(ids);

  // Actualizar settings: quitar del historial y de importedPackIds
  const settings = await getSettings();
  await saveSettings({
    importedPackIds: (settings.importedPackIds ?? []).filter(id => id !== packId),
    importHistory: (settings.importHistory ?? []).filter(e => e.packId !== packId),
  });

  return { packId, deletedQuestions: ids.length };
}

// ─── Preview ───────────────────────────────────────────────────────────────────

export interface ContributionPackPreviewRow {
  subjectName: string;
  topicName: string;
  questionsCount: number;
  newCount: number;
}

export interface ContributionPackPreview {
  packId: string;
  createdBy: string;
  exportedAt: string;
  subjects: string[];
  topicsCount: number;
  questionsCount: number;
  /** C1: Number of new (non-duplicate) questions */
  newQuestionsCount: number;
  /** C1: Per-subject/topic breakdown */
  rows: ContributionPackPreviewRow[];
  questionsSample: string[];
  /** Full Question-shaped objects for all new questions (for interactive preview) */
  questionsSampleFull: Question[];
  alreadyImported: boolean;
  rawPack: unknown;
}

export async function previewContributionPack(raw: unknown, targetSubjectId?: string): Promise<ContributionPackPreview | { error: string }> {
  const parsed = ContributionPackSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };
  const pack = parsed.data;

  // Loose pack: no trae targets (asignatura/temas). Solo importable desde dentro
  // de una asignatura; el nombre lo aporta targetSubjectId.
  const isLoose = pack.targets.length === 0;
  let targetSubjectName: string | undefined;
  if (targetSubjectId) {
    targetSubjectName = (await db.subjects.get(targetSubjectId))?.name;
  }

  const settings = await getSettings();
  const alreadyImported = settings.importedPackIds.includes(pack.packId);

  // C1: Gather existing contentHashes for dedup check
  const existingHashes = new Set<string>();
  const allQuestions = await db.questions.toArray();
  allQuestions.forEach((q) => { if (q.contentHash) existingHashes.add(q.contentHash); });

  // C1: Build per-subject/topic rows with new count
  const rows: ContributionPackPreviewRow[] = [];
  let totalNew = 0;
  for (const target of pack.targets) {
    for (const topic of target.topics) {
      const topicQuestions = pack.questions.filter((q) => {
        const tKeys = q.topicKeys?.length ? q.topicKeys : [q.topicKey];
        return tKeys.includes(topic.topicKey);
      });
      const newCount = topicQuestions.filter((q) => !q.contentHash || !existingHashes.has(q.contentHash)).length;
      totalNew += newCount;
      rows.push({
        subjectName: target.subjectName,
        topicName: topic.topicTitle,
        questionsCount: topicQuestions.length,
        newCount,
      });
    }
  }

  const newQuestions = pack.questions.filter((q) => !q.contentHash || !existingHashes.has(q.contentHash));

  // Loose pack: sin targets, construimos una fila resumen para la asignatura destino.
  if (isLoose) {
    totalNew = newQuestions.length;
    rows.push({
      subjectName: targetSubjectName ?? 'Esta asignatura',
      topicName: '(sin tema)',
      questionsCount: pack.questions.length,
      newCount: newQuestions.length,
    });
  }

  // Map contribution questions to Question-shaped objects for interactive preview
  const now = new Date().toISOString();
  const questionsSampleFull: Question[] = newQuestions.map((cq) => ({
    id: cq.id,
    subjectId: '',
    topicId: '',
    type: cq.type,
    prompt: cq.prompt,
    explanation: cq.explanation,
    difficulty: cq.difficulty as Question['difficulty'],
    tags: cq.tags,
    origin: cq.origin,
    options: cq.options,
    correctOptionIds: cq.correctOptionIds,
    modelAnswer: cq.modelAnswer,
    keywords: cq.keywords,
    numericAnswer: cq.numericAnswer,
    clozeText: cq.clozeText,
    blanks: cq.blanks,
    createdBy: cq.createdBy,
    contentHash: cq.contentHash,
    imageDataUrls: cq.imageDataUrls,
    stats: { seen: 0, correct: 0, wrong: 0 },
    createdAt: now,
    updatedAt: now,
  }));

  return {
    packId: pack.packId,
    createdBy: pack.createdBy,
    exportedAt: pack.exportedAt,
    subjects: isLoose ? [targetSubjectName ?? 'Esta asignatura'] : pack.targets.map((t) => t.subjectName),
    topicsCount: pack.targets.reduce((acc, t) => acc + t.topics.length, 0),
    questionsCount: pack.questions.length,
    newQuestionsCount: totalNew,
    rows,
    questionsSample: newQuestions
      .slice(0, 5)
      .map((q) => q.prompt.replace(/[#*`\n]/g, ' ').trim().slice(0, 80)),
    questionsSampleFull,
    alreadyImported,
    rawPack: raw,
  };
}