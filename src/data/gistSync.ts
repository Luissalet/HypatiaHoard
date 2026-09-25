/**
 * gistSync.ts
 *
 * Sincronización incremental entre dispositivos via GitHub Gist.
 *
 * Estrategia tipo "git":
 *  - Push: sube el estado completo de la DB al Gist.
 *  - Pull: descarga el Gist y hace MERGE inteligente:
 *    • Registros con mismo ID → gana el que tenga `updatedAt` más reciente.
 *    • Registros nuevos en remoto → se añaden.
 *    • Registros solo locales → se conservan (se subirán en el próximo push).
 *    • Imágenes: solo descarga las que no existen localmente.
 *  - Antes de descargar, comprueba si el Gist cambió desde el último sync (como git fetch).
 *
 * Datos que NO se sincronizan:
 *  - PDFs (demasiado pesados — se re-suben en cada dispositivo)
 *  - API keys, tokens (seguridad)
 *  - fsaHandles (device-specific)
 */

import { db, getSettings, saveSettings } from './db';
import { PDFDocument } from 'pdf-lib';
import { listStoredPdfs, getPdfBlobUrl } from './pdfStorage';
import { savePdfBlob } from './pdfStorage';
import { slugify } from '@/domain/normalize';
import { computeContentHash } from '@/domain/hashing';
import type {
  Subject,
  Topic,
  Question,
  PracticeSession,
  KeyConcept,
  Exam,
  Deliverable,
  SubjectGradingConfig,
  PdfAnchor,
  AppSettings,
  QuestionImageRecord,
  InstalledPackage,
} from '@/domain/models';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FullBackup {
  version: 2;
  kind: 'full-backup';
  exportedAt: string;
  deviceId: string;
  subjects: Subject[];
  topics: Topic[];
  questions: Question[];
  sessions: PracticeSession[];
  pdfAnchors: PdfAnchor[];
  keyConcepts: KeyConcept[];
  exams: Exam[];
  deliverables: Deliverable[];
  gradingConfigs: SubjectGradingConfig[];
  syncedSettings: SyncedSettings;
  /** { filename: { base64, mimeType } } — solo las imágenes inline de preguntas */
  questionImages: Record<string, { base64: string; mimeType: string }>;
  /**
   * Manifiesto de PDFs sincronizados.
   * Los PDFs van como archivos separados en el Gist.
   * Si un PDF es grande (> PDF_CHUNK_LIMIT), se divide en páginas
   * usando pdf-lib y se almacena como partes numeradas.
   */
  pdfManifest?: PdfManifestEntry[];
  /**
   * Manifiesto de WAVs pre-generados.
   * No se sincronizan los WAVs (demasiado pesados),
   * solo el manifiesto para que el otro dispositivo los regenere.
   */
  pregenManifest?: PregenManifestEntry[];
  /** Paquetes instalados desde el marketplace (para que el otro dispositivo sepa qué descargar). */
  installedPackages?: InstalledPackage[];
}

/** Entrada en el manifiesto de WAVs pre-generados */
export interface PregenManifestEntry {
  topicId: string;
  pdfFilename: string;
  cacheKey: string;
  voiceId: string;
  blockCount: number;
  generatedAt: string;
}

/** Entrada en el manifiesto de PDFs — describe cómo reconstruir el PDF */
interface PdfManifestEntry {
  subjectId: string;
  filename: string;
  /** Clave del archivo en el Gist (sin extensión .b64) */
  gistKey: string;
  /** Si es > 1, el PDF está dividido en partes: gistKey-001, gistKey-002, etc. */
  parts: number;
  /** Tamaño original en bytes (para verificación) */
  originalSize: number;
}

/** PDFs menores a 5 MB van enteros; mayores se dividen en páginas */
const PDF_CHUNK_LIMIT = 5 * 1024 * 1024; // 5 MB
/** Máximo de páginas por parte al dividir un PDF grande */
const PAGES_PER_CHUNK = 10;

interface SyncedSettings {
  alias: string;
  importedPackIds: string[];
  importHistory?: AppSettings['importHistory'];
  globalBankSyncedAt?: string;
  studyStreak?: number;
  lastStudyDate?: string;
  subjectGoals?: Record<string, number>;
  marketplacePasswords?: Record<string, string>;
}

export interface SyncResult {
  success: boolean;
  direction: 'push' | 'pull' | 'skip';
  error?: string;
  added?: number;
  updated?: number;
  skipped?: number;
  /** Mapa de remapeo de IDs de asignaturas (remoteId → localId) para uso interno */
  _subjectIdMap?: Map<string, string>;
}

// ─── Device ID ──────────────────────────────────────────────────────────────

function getDeviceId(): string {
  const key = 'examcoach-device-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

// ─── Export full backup ──────────────────────────────────────────────────────

export async function exportFullBackup(): Promise<FullBackup> {
  const [
    subjects, topics, questions, sessions, pdfAnchors,
    keyConcepts, exams, deliverables, gradingConfigs,
    questionImageRecords, settings, installedPackages,
  ] = await Promise.all([
    db.subjects.toArray(),
    db.topics.toArray(),
    db.questions.toArray(),
    db.sessions.toArray(),
    db.pdfAnchors.toArray(),
    db.keyConcepts.toArray(),
    db.exams.toArray(),
    db.deliverables.toArray(),
    db.gradingConfigs.toArray(),
    db.questionImages.toArray(),
    getSettings(),
    db.installedPackages.toArray(),
  ]);

  const questionImages: Record<string, { base64: string; mimeType: string }> = {};
  for (const record of questionImageRecords) {
    try {
      const base64 = await blobToBase64(record.blob);
      questionImages[record.filename] = { base64, mimeType: record.mimeType };
    } catch { /* skip corrupted */ }
  }

  return {
    version: 2,
    kind: 'full-backup',
    exportedAt: new Date().toISOString(),
    deviceId: getDeviceId(),
    subjects, topics, questions, sessions, pdfAnchors,
    keyConcepts, exams, deliverables, gradingConfigs,
    syncedSettings: {
      alias: settings.alias,
      importedPackIds: settings.importedPackIds,
      importHistory: settings.importHistory,
      globalBankSyncedAt: settings.globalBankSyncedAt,
      studyStreak: settings.studyStreak,
      lastStudyDate: settings.lastStudyDate,
      subjectGoals: settings.subjectGoals,
      marketplacePasswords: settings.marketplacePasswords,
    },
    questionImages,
    pregenManifest: await buildPregenManifest(topics),
    installedPackages,
  };
}

// ─── PregenManifest helpers ──────────────────────────────────────────────────

async function buildPregenManifest(topics: Topic[]): Promise<PregenManifestEntry[]> {
  try {
    const { listWavCacheEntries } = await import('@/utils/backgroundSynthesis');
    const entries = await listWavCacheEntries();
    if (entries.length === 0) return [];

    // Build lookup: for each entry, try to match with a topic
    // Cache keys are hashes, but we store voiceId and blockCount in the entry
    const manifest: PregenManifestEntry[] = [];
    for (const { key, entry } of entries) {
      // We can't directly map cache key → topic without the texts hash,
      // but we store all entries so the other device can check which ones it's missing
      manifest.push({
        topicId: '', // will be empty if we can't determine — other device uses cacheKey to match
        pdfFilename: '',
        cacheKey: key,
        voiceId: entry.voiceId,
        blockCount: entry.blockCount,
        generatedAt: new Date(entry.createdAt).toISOString(),
      });
    }
    return manifest;
  } catch {
    return [];
  }
}

// ─── Merge (pull inteligente) ────────────────────────────────────────────────

/**
 * Merge inteligente con deduplicación por contenido.
 *
 * Estrategia (misma que globalBank.ts):
 *  - Asignaturas → dedup por slugify(name)
 *  - Temas       → dedup por slugify(subjectName)::slugify(title)
 *  - Preguntas   → dedup por contentHash
 *  - Conceptos   → dedup por contentHash
 *  - Sesiones    → merge por ID (no hay duplicado semántico)
 *  - Resto       → merge por ID + timestamp
 *
 * Cuando se detecta un registro duplicado con distinto ID,
 * se construye un mapa de remapeo (remoteId → localId) para
 * que los registros hijos referencien el ID local correcto.
 */
export async function mergeBackup(backup: FullBackup): Promise<SyncResult> {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  try {
    // ── 1. Dedup asignaturas por slug ─────────────────────────────────
    const subjectIdMap = new Map<string, string>(); // remoteId → localId
    const subjectResult = await mergeSubjects(backup.subjects, subjectIdMap);
    added += subjectResult.added;
    updated += subjectResult.updated;
    skipped += subjectResult.skipped;

    // ── 2. Dedup temas por composite slug ─────────────────────────────
    const topicIdMap = new Map<string, string>(); // remoteId → localId
    const topicResult = await mergeTopics(backup.topics, subjectIdMap, topicIdMap);
    added += topicResult.added;
    updated += topicResult.updated;
    skipped += topicResult.skipped;

    // ── 3. Dedup preguntas por contentHash ─────────────────────────────
    const questionIdMap = new Map<string, string>(); // remoteId → localId
    const questionResult = await mergeQuestions(backup.questions, subjectIdMap, topicIdMap, questionIdMap);
    added += questionResult.added;
    updated += questionResult.updated;
    skipped += questionResult.skipped;

    // ── 4. Sesiones: merge por ID, remapear subjectId/topicId/questionIds ─
    const sessionResult = await mergeSessions(backup.sessions, subjectIdMap, topicIdMap, questionIdMap);
    added += sessionResult.added;
    updated += sessionResult.updated;
    skipped += sessionResult.skipped;

    // ── 5. PdfAnchors: merge por ID, remapear subjectId ───────────────
    const anchorResult = await mergeTableWithRemap(
      db.pdfAnchors, backup.pdfAnchors, null, subjectIdMap, 'subjectId',
    );
    added += anchorResult.added;
    updated += anchorResult.updated;
    skipped += anchorResult.skipped;

    // ── 6. Dedup conceptos clave por contentHash ──────────────────────
    const conceptResult = await mergeKeyConcepts(backup.keyConcepts, subjectIdMap, topicIdMap);
    added += conceptResult.added;
    updated += conceptResult.updated;
    skipped += conceptResult.skipped;

    // ── 7. Exams: merge por ID, remapear subjectId ────────────────────
    const examResult = await mergeTableWithRemap(
      db.exams, backup.exams, 'updatedAt', subjectIdMap, 'subjectId',
    );
    added += examResult.added;
    updated += examResult.updated;
    skipped += examResult.skipped;

    // ── 8. Deliverables: merge por ID ─────────────────────────────────
    const deliverableResult = await mergeTableWithRemap(
      db.deliverables, backup.deliverables, 'updatedAt', subjectIdMap, 'subjectId',
    );
    added += deliverableResult.added;
    updated += deliverableResult.updated;
    skipped += deliverableResult.skipped;

    // ── 9. GradingConfigs: merge por ID, remapear subjectId ───────────
    const gradingResult = await mergeGradingConfigs(backup.gradingConfigs, subjectIdMap);
    added += gradingResult.added;
    skipped += gradingResult.skipped;

    // ── 10. Question images ───────────────────────────────────────────
    const imgResult = await mergeQuestionImages(backup.questionImages);
    added += imgResult.added;
    skipped += imgResult.skipped;

    // ── 11. Installed packages: merge por ID ───────────────────────────
    if (backup.installedPackages) {
      for (const pkg of backup.installedPackages) {
        const localSubjectId = subjectIdMap.get(pkg.subjectId) ?? pkg.subjectId;
        const remapped = { ...pkg, subjectId: localSubjectId };
        const local = await db.installedPackages.get(pkg.id);
        if (!local) {
          await db.installedPackages.add(remapped);
          added++;
        } else {
          skipped++;
        }
      }
    }

    // ── 12. Synced settings ───────────────────────────────────────────
    await mergeSyncedSettings(backup.syncedSettings);

    // Update lastSyncAt
    await saveSettings({ lastSyncAt: new Date().toISOString() });

    return { success: true, direction: 'pull', added, updated, skipped, _subjectIdMap: subjectIdMap };
  } catch (err) {
    return { success: false, direction: 'pull', error: String(err) };
  }
}

interface MergeCount { added: number; updated: number; skipped: number }

// ─── Subject merge (dedup by slug) ────────────────────────────────────────────

async function mergeSubjects(
  remoteSubjects: Subject[],
  idMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  const localSubjects = await db.subjects.toArray();
  const bySlug = new Map<string, Subject>();
  const byId = new Map<string, Subject>();
  for (const s of localSubjects) {
    bySlug.set(slugify(s.name), s);
    byId.set(s.id, s);
  }

  for (const remote of remoteSubjects) {
    const slug = slugify(remote.name);
    const localById = byId.get(remote.id);
    const localBySlug = bySlug.get(slug);

    if (localById) {
      // Mismo ID — LWW por updatedAt
      idMap.set(remote.id, remote.id);
      if (remote.updatedAt > localById.updatedAt) {
        // Preservar campos locales: examDate, allowsNotes
        await db.subjects.put({
          ...remote,
          examDate: localById.examDate,
          allowsNotes: localById.allowsNotes,
        });
        updated++;
      } else {
        skipped++;
      }
    } else if (localBySlug) {
      // Distinto ID pero mismo nombre → es la misma asignatura
      idMap.set(remote.id, localBySlug.id);
      if (remote.updatedAt > localBySlug.updatedAt) {
        // Actualizar campos no-locales, mantener ID local
        await db.subjects.put({
          ...remote,
          id: localBySlug.id,
          examDate: localBySlug.examDate,
          allowsNotes: localBySlug.allowsNotes,
        });
        updated++;
      } else {
        skipped++;
      }
    } else {
      // Realmente nueva
      await db.subjects.add(remote);
      idMap.set(remote.id, remote.id);
      bySlug.set(slug, remote);
      byId.set(remote.id, remote);
      added++;
    }
  }

  // Asignaturas solo locales: identidad (para que el mapa cubra todo)
  for (const s of localSubjects) {
    if (!idMap.has(s.id)) idMap.set(s.id, s.id);
  }

  return { added, updated, skipped };
}

// ─── Topic merge (dedup by subject::title slug) ──────────────────────────────

async function mergeTopics(
  remoteTopics: Topic[],
  subjectIdMap: Map<string, string>,
  topicIdMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  const localTopics = await db.topics.toArray();
  const localSubjects = await db.subjects.toArray();

  // Construir lookup de nombre de asignatura por ID (local)
  const subjectNameById = new Map<string, string>();
  for (const s of localSubjects) subjectNameById.set(s.id, s.name);

  // Construir lookup de nombre de asignatura remota por ID remoto
  // (necesario para calcular el composite key de los remotos)
  // Usamos los subjects del backup que ya fueron procesados, pero
  // también podemos calcular indirectamente: remote.subjectId → localSubjectId → name
  // Sin embargo, necesitamos el nombre remoto para el slug. Mejor: usamos
  // el nombre local (al que se mapeó) ya que es el mismo slug.

  // Index: compositeKey → Topic local
  const byKey = new Map<string, Topic>();
  const byId = new Map<string, Topic>();
  for (const t of localTopics) {
    const subjectName = subjectNameById.get(t.subjectId);
    if (subjectName) {
      byKey.set(`${slugify(subjectName)}::${slugify(t.title)}`, t);
    }
    byId.set(t.id, t);
  }

  for (const remote of remoteTopics) {
    const localSubjectId = subjectIdMap.get(remote.subjectId) ?? remote.subjectId;
    const subjectName = subjectNameById.get(localSubjectId);
    if (!subjectName) {
      // Asignatura no encontrada — skipear
      skipped++;
      continue;
    }

    const compositeKey = `${slugify(subjectName)}::${slugify(remote.title)}`;
    const localById = byId.get(remote.id);
    const localByKey = byKey.get(compositeKey);

    if (localById) {
      // Mismo ID
      topicIdMap.set(remote.id, remote.id);
      if (remote.updatedAt > localById.updatedAt) {
        await db.topics.put({ ...remote, subjectId: localSubjectId });
        updated++;
      } else {
        skipped++;
      }
    } else if (localByKey) {
      // Distinto ID pero mismo contenido → duplicado
      topicIdMap.set(remote.id, localByKey.id);
      if (remote.updatedAt > localByKey.updatedAt) {
        await db.topics.put({
          ...remote,
          id: localByKey.id,
          subjectId: localSubjectId,
        });
        updated++;
      } else {
        skipped++;
      }
    } else {
      // Nuevo tema
      const remapped: Topic = { ...remote, subjectId: localSubjectId };
      await db.topics.add(remapped);
      topicIdMap.set(remote.id, remote.id);
      byKey.set(compositeKey, remapped);
      byId.set(remote.id, remapped);
      added++;
    }
  }

  // Temas solo locales: identidad
  for (const t of localTopics) {
    if (!topicIdMap.has(t.id)) topicIdMap.set(t.id, t.id);
  }

  return { added, updated, skipped };
}

// ─── Question merge (dedup by contentHash) ────────────────────────────────────

async function mergeQuestions(
  remoteQuestions: Question[],
  subjectIdMap: Map<string, string>,
  topicIdMap: Map<string, string>,
  questionIdMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  const allLocal = await db.questions.toArray();
  const byId = new Map<string, Question>();
  const byHash = new Map<string, Question>();
  for (const q of allLocal) {
    byId.set(q.id, q);
    if (q.contentHash) byHash.set(q.contentHash, q);
  }

  for (const remote of remoteQuestions) {
    const localSubjectId = subjectIdMap.get(remote.subjectId) ?? remote.subjectId;
    const localTopicId = topicIdMap.get(remote.topicId) ?? remote.topicId;
    const localTopicIds = remote.topicIds?.map((id) => topicIdMap.get(id) ?? id);

    // Recomputar hash para comparación robusta
    const hash = await computeContentHash(remote);
    const remapped: Question = {
      ...remote,
      subjectId: localSubjectId,
      topicId: localTopicId,
      topicIds: localTopicIds,
      contentHash: hash,
    };

    const localById = byId.get(remote.id);

    if (localById) {
      // Mismo ID — identidad directa
      questionIdMap.set(remote.id, localById.id);
      // LWW, pero merge stats inteligente
      if (remote.updatedAt > localById.updatedAt) {
        await db.questions.put({
          ...remapped,
          // Preservar campos locales
          notes: localById.notes,
          starred: localById.starred,
          // Merge stats: quedarse con las más avanzadas
          stats: mergeStats(localById.stats, remote.stats),
        });
        updated++;
      } else {
        // Aun así, merge stats si el remoto tiene más progreso
        const merged = mergeStats(localById.stats, remote.stats);
        if (merged !== localById.stats) {
          await db.questions.update(localById.id, { stats: merged });
          updated++;
        } else {
          skipped++;
        }
      }
    } else {
      // Distinto ID — comprobar por contentHash
      const localByHash = byHash.get(hash);

      if (localByHash) {
        // Duplicado por contenido → mapear remoteId → localId
        questionIdMap.set(remote.id, localByHash.id);
        const merged = mergeStats(localByHash.stats, remote.stats);
        if (merged !== localByHash.stats) {
          await db.questions.update(localByHash.id, { stats: merged });
          updated++;
        } else {
          skipped++;
        }
      } else {
        // Realmente nueva — identidad directa
        questionIdMap.set(remote.id, remote.id);
        await db.questions.add(remapped);
        byHash.set(hash, remapped);
        byId.set(remote.id, remapped);
        added++;
      }
    }
  }

  return { added, updated, skipped };
}

/**
 * Merge de estadísticas: toma los valores más altos (más progreso).
 * Devuelve el mismo objeto si no hay cambios.
 */
function mergeStats(
  local: Question['stats'],
  remote: Question['stats'],
): Question['stats'] {
  const seen = Math.max(local.seen, remote.seen);
  const correct = Math.max(local.correct, remote.correct);
  const wrong = Math.max(local.wrong, remote.wrong);

  // Última vez vista: la más reciente
  const lastSeenAt = [local.lastSeenAt, remote.lastSeenAt]
    .filter(Boolean)
    .sort()
    .pop() ?? undefined;

  // SRS fields: toma los del que tiene más repeticiones
  const localReps = (local as any).repetitions ?? 0;
  const remoteReps = (remote as any).repetitions ?? 0;
  const srsSource = remoteReps > localReps ? remote : local;

  if (
    seen === local.seen &&
    correct === local.correct &&
    wrong === local.wrong &&
    lastSeenAt === local.lastSeenAt
  ) {
    return local; // sin cambios
  }

  return {
    ...srsSource,
    seen,
    correct,
    wrong,
    lastSeenAt,
    lastResult: lastSeenAt === remote.lastSeenAt ? remote.lastResult : local.lastResult,
  };
}

// ─── KeyConcept merge (dedup by contentHash) ──────────────────────────────────

async function mergeKeyConcepts(
  remoteConcepts: KeyConcept[],
  subjectIdMap: Map<string, string>,
  topicIdMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  const allLocal = await db.keyConcepts.toArray();
  const byId = new Map<string, KeyConcept>();
  const byHash = new Map<string, KeyConcept>();
  for (const kc of allLocal) {
    byId.set(kc.id, kc);
    if (kc.contentHash) byHash.set(kc.contentHash, kc);
  }

  for (const remote of remoteConcepts) {
    const localSubjectId = subjectIdMap.get(remote.subjectId) ?? remote.subjectId;
    const localTopicId = remote.topicId ? (topicIdMap.get(remote.topicId) ?? remote.topicId) : undefined;
    const remapped: KeyConcept = {
      ...remote,
      subjectId: localSubjectId,
      topicId: localTopicId,
    };

    const localById = byId.get(remote.id);

    if (localById) {
      // Mismo ID — LWW
      if (remote.updatedAt > localById.updatedAt) {
        await db.keyConcepts.put(remapped);
        updated++;
      } else {
        skipped++;
      }
    } else if (remote.contentHash && byHash.has(remote.contentHash)) {
      // Duplicado por hash — skip
      skipped++;
    } else {
      // Nuevo
      await db.keyConcepts.add(remapped);
      if (remote.contentHash) byHash.set(remote.contentHash, remapped);
      byId.set(remote.id, remapped);
      added++;
    }
  }

  return { added, updated, skipped };
}

// ─── Sessions merge (by ID, remap foreign keys) ──────────────────────────────

async function mergeSessions(
  remoteSessions: PracticeSession[],
  subjectIdMap: Map<string, string>,
  topicIdMap: Map<string, string>,
  questionIdMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  for (const remote of remoteSessions) {
    // Remapear foreign keys
    const remapped = {
      ...remote,
      subjectId: subjectIdMap.get(remote.subjectId) ?? remote.subjectId,
      topicId: remote.topicId ? (topicIdMap.get(remote.topicId) ?? remote.topicId) : remote.topicId,
      // Remapear questionIds al espacio local
      questionIds: remote.questionIds.map((id) => questionIdMap.get(id) ?? id),
      // Remapear questionId dentro de cada respuesta
      answers: remote.answers.map((a) => ({
        ...a,
        questionId: questionIdMap.get(a.questionId) ?? a.questionId,
      })),
    } as PracticeSession;
    // También remapear subjectIds si existe (sesiones multi-asignatura)
    if ((remote as any).subjectIds) {
      (remapped as any).subjectIds = (remote as any).subjectIds.map(
        (id: string) => subjectIdMap.get(id) ?? id,
      );
    }
    // También remapear topicIds si existe
    if ((remote as any).topicIds) {
      (remapped as any).topicIds = (remote as any).topicIds.map(
        (id: string) => topicIdMap.get(id) ?? id,
      );
    }

    const local = await db.sessions.get(remote.id);

    if (!local) {
      await db.sessions.add(remapped);
      added++;
    } else if (remote.finishedAt && !local.finishedAt) {
      await db.sessions.put(remapped);
      updated++;
    } else if (remote.answers.length > local.answers.length) {
      await db.sessions.put(remapped);
      updated++;
    } else {
      // Aunque la sesión no sea "mejor", reparar questionIds rotos
      // (de syncs anteriores que no remapeaban IDs de preguntas)
      const needsQuestionRemap = local.questionIds.some(
        (id, i) => id !== remapped.questionIds[i],
      );
      if (needsQuestionRemap) {
        await db.sessions.update(local.id, {
          questionIds: remapped.questionIds,
          answers: remapped.answers,
        });
        updated++;
      } else {
        skipped++;
      }
    }
  }

  return { added, updated, skipped };
}

// ─── Generic table merge with foreign key remap ──────────────────────────────

async function mergeTableWithRemap<T extends { id: string }>(
  table: import('dexie').Table<T, string>,
  remoteRecords: T[],
  timestampField: 'updatedAt' | 'createdAt' | null,
  idMap: Map<string, string>,
  foreignKey: string,
): Promise<MergeCount> {
  let added = 0, updated = 0, skipped = 0;

  for (const remote of remoteRecords) {
    // Remapear foreign key
    const fkValue = (remote as any)[foreignKey];
    const remapped = {
      ...remote,
      [foreignKey]: idMap.get(fkValue) ?? fkValue,
    };

    const local = await table.get(remote.id);

    if (!local) {
      await table.add(remapped);
      added++;
    } else if (timestampField) {
      const localTs = (local as any)[timestampField] as string | undefined;
      const remoteTs = (remapped as any)[timestampField] as string | undefined;
      if (remoteTs && localTs && remoteTs > localTs) {
        await table.put(remapped);
        updated++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  }

  return { added, updated, skipped };
}

/**
 * GradingConfigs: id === subjectId, no tiene updatedAt.
 * Solo añadir si no existe localmente. Remapear subjectId.
 */
async function mergeGradingConfigs(
  remoteConfigs: SubjectGradingConfig[],
  subjectIdMap: Map<string, string>,
): Promise<MergeCount> {
  let added = 0, skipped = 0;

  for (const remote of remoteConfigs) {
    const localSubjectId = subjectIdMap.get(remote.id) ?? remote.id;
    const remapped = { ...remote, id: localSubjectId };

    const local = await db.gradingConfigs.get(localSubjectId);
    if (!local) {
      await db.gradingConfigs.add(remapped);
      added++;
    } else {
      if (remote.examGrade != null && local.examGrade == null) {
        await db.gradingConfigs.put(remapped);
        added++;
      } else {
        skipped++;
      }
    }
  }

  return { added, updated: 0, skipped };
}

/**
 * Question images: solo descarga las que no existen localmente.
 */
async function mergeQuestionImages(
  remoteImages: Record<string, { base64: string; mimeType: string }>,
): Promise<{ added: number; skipped: number }> {
  let added = 0, skipped = 0;

  for (const [filename, { base64, mimeType }] of Object.entries(remoteImages)) {
    const id = filename.replace(/\.[^.]+$/, '');
    const exists = await db.questionImages.get(id);

    if (exists) {
      skipped++;
      continue;
    }

    await db.questionImages.add({
      id,
      filename,
      blob: base64ToBlob(base64, mimeType),
      mimeType,
      createdAt: new Date().toISOString(),
    });
    added++;
  }

  return { added, skipped };
}

/**
 * Merge settings: keep the "best" of each field.
 */
async function mergeSyncedSettings(remote: SyncedSettings): Promise<void> {
  const local = await getSettings();

  await saveSettings({
    alias: local.alias || remote.alias,
    // Merge importedPackIds (union)
    importedPackIds: [...new Set([...local.importedPackIds, ...remote.importedPackIds])],
    // Keep the higher streak
    studyStreak: Math.max(local.studyStreak ?? 0, remote.studyStreak ?? 0),
    // Keep the more recent study date
    lastStudyDate: [local.lastStudyDate, remote.lastStudyDate]
      .filter(Boolean)
      .sort()
      .pop() ?? undefined,
    // Merge goals (remote fills gaps)
    subjectGoals: { ...(remote.subjectGoals ?? {}), ...(local.subjectGoals ?? {}) },
    // Keep the more recent globalBankSyncedAt
    globalBankSyncedAt: [local.globalBankSyncedAt, remote.globalBankSyncedAt]
      .filter(Boolean)
      .sort()
      .pop() ?? undefined,
    // Merge import history (union by packId)
    importHistory: mergeImportHistory(local.importHistory, remote.importHistory),
    // Merge marketplace passwords (remote fills gaps, local wins on conflict)
    marketplacePasswords: { ...(remote.marketplacePasswords ?? {}), ...(local.marketplacePasswords ?? {}) },
  });
}

function mergeImportHistory(
  local?: AppSettings['importHistory'],
  remote?: AppSettings['importHistory'],
): AppSettings['importHistory'] {
  const map = new Map<string, NonNullable<AppSettings['importHistory']>[number]>();
  for (const entry of [...(local ?? []), ...(remote ?? [])]) {
    if (!map.has(entry.packId)) map.set(entry.packId, entry);
  }
  return [...map.values()];
}

// ─── PDF sync helpers ────────────────────────────────────────────────────────

/** Sanitiza nombre para usar como clave de archivo en el Gist */
function pdfGistKey(subjectId: string, filename: string): string {
  return `pdf-${subjectId.slice(0, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Exporta PDFs como archivos Gist.
 * PDFs pequeños → un solo archivo base64.
 * PDFs grandes → divididos en N partes de PAGES_PER_CHUNK páginas usando pdf-lib.
 */
async function exportPdfsForGist(
  subjectIds: string[],
): Promise<{
  manifest: PdfManifestEntry[];
  files: Record<string, { content: string }>;
}> {
  const manifest: PdfManifestEntry[] = [];
  const files: Record<string, { content: string }> = {};

  for (const subjectId of subjectIds) {
    const pdfNames = await listStoredPdfs(subjectId);

    for (const filename of pdfNames) {
      try {
        const blobUrl = await getPdfBlobUrl(subjectId, filename);
        if (!blobUrl) continue;

        const response = await fetch(blobUrl);
        const blob = await response.blob();
        URL.revokeObjectURL(blobUrl);

        const key = pdfGistKey(subjectId, filename);
        const arrayBuffer = await blob.arrayBuffer();
        const size = arrayBuffer.byteLength;

        if (size <= PDF_CHUNK_LIMIT) {
          // PDF pequeño → un solo archivo
          const base64 = arrayBufferToBase64(arrayBuffer);
          files[`${key}.b64`] = { content: base64 };
          manifest.push({ subjectId, filename, gistKey: key, parts: 1, originalSize: size });
        } else {
          // PDF grande → dividir en partes por páginas
          const srcDoc = await PDFDocument.load(arrayBuffer);
          const totalPages = srcDoc.getPageCount();
          let partIndex = 0;

          for (let start = 0; start < totalPages; start += PAGES_PER_CHUNK) {
            const end = Math.min(start + PAGES_PER_CHUNK, totalPages);
            const partDoc = await PDFDocument.create();
            const indices = Array.from({ length: end - start }, (_, i) => start + i);
            const pages = await partDoc.copyPages(srcDoc, indices);
            for (const page of pages) partDoc.addPage(page);

            const partBytes = await partDoc.save();
            const partBase64 = arrayBufferToBase64(partBytes);
            files[`${key}-${String(partIndex).padStart(3, '0')}.b64`] = { content: partBase64 };
            partIndex++;
          }

          manifest.push({ subjectId, filename, gistKey: key, parts: partIndex, originalSize: size });
        }
      } catch (err) {
        console.warn(`[gistSync] No se pudo exportar PDF ${filename}:`, err);
      }
    }
  }

  return { manifest, files };
}

/**
 * Importa PDFs desde archivos Gist.
 * Solo descarga los que no existen localmente.
 * Los PDFs divididos se reensamblan usando pdf-lib.
 */
async function importPdfsFromGist(
  manifest: PdfManifestEntry[],
  gistFiles: Record<string, { content: string; truncated?: boolean; raw_url?: string }>,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0;

  for (const entry of manifest) {
    // Comprobar si ya existe localmente
    const existingPdfs = await listStoredPdfs(entry.subjectId);
    if (existingPdfs.includes(entry.filename)) {
      skipped++;
      continue;
    }

    try {
      let pdfBlob: Blob;

      if (entry.parts === 1) {
        // PDF entero en un solo archivo
        const fileKey = `${entry.gistKey}.b64`;
        const content = await getGistFileContent(gistFiles, fileKey);
        if (!content) { skipped++; continue; }
        pdfBlob = base64ToBlob(content, 'application/pdf');
      } else {
        // PDF dividido — descargar todas las partes y merge con pdf-lib
        const mergedDoc = await PDFDocument.create();

        for (let i = 0; i < entry.parts; i++) {
          const partKey = `${entry.gistKey}-${String(i).padStart(3, '0')}.b64`;
          const content = await getGistFileContent(gistFiles, partKey);
          if (!content) throw new Error(`Falta parte ${partKey}`);

          const partBytes = base64ToArrayBuffer(content);
          const partDoc = await PDFDocument.load(partBytes);
          const pages = await mergedDoc.copyPages(partDoc, partDoc.getPageIndices());
          for (const page of pages) mergedDoc.addPage(page);
        }

        const mergedBytes = await mergedDoc.save();
        pdfBlob = new Blob([mergedBytes as BlobPart], { type: 'application/pdf' });
      }

      await savePdfBlob(entry.subjectId, entry.filename, pdfBlob);
      imported++;
    } catch (err) {
      console.warn(`[gistSync] Error importando PDF ${entry.filename}:`, err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/** Lee el contenido de un archivo del Gist, manejando truncation */
async function getGistFileContent(
  files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>,
  key: string,
): Promise<string | null> {
  const file = files[key];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    return await (await fetch(file.raw_url)).text();
  }
  return file.content;
}

// ─── GitHub Gist operations ──────────────────────────────────────────────────

const GIST_FILENAME = 'examcoach-backup.json';
const CHUNK_SIZE = 9 * 1024 * 1024;

/**
 * Push local DB to GitHub Gist.
 */
export async function pushToGist(token: string): Promise<SyncResult> {
  try {
    const result = await _pushToGistInner(token, true);
    return result;
  } catch (err) {
    const msg = String(err);
    // Si falla por Validation Failed, reintentar sin PDFs (payload demasiado grande)
    if (msg.includes('Validation Failed')) {
      console.warn('[gistSync] Push con PDFs falló por Validation — reintentando sin PDFs…');
      try {
        const retryResult = await _pushToGistInner(token, false);
        return {
          ...retryResult,
          error: retryResult.error ?? undefined,
        };
      } catch (retryErr) {
        return { success: false, direction: 'push', error: 'Reintento sin PDFs falló: ' + String(retryErr) };
      }
    }
    const friendly = msg.includes('Failed to fetch')
      ? 'Sin conexión con GitHub. Comprueba la red del dispositivo.'
      : msg;
    return { success: false, direction: 'push', error: friendly };
  }
}

async function _pushToGistInner(token: string, includePdfs: boolean): Promise<SyncResult> {
  const backup = await exportFullBackup();

  const files: Record<string, { content: string } | null> = {};

  if (includePdfs) {
    // Exportar PDFs como archivos Gist separados
    const subjectIds = backup.subjects.map((s) => s.id);
    const pdfExport = await exportPdfsForGist(subjectIds);
    backup.pdfManifest = pdfExport.manifest;
    Object.assign(files, pdfExport.files);
  } else {
    backup.pdfManifest = [];
  }

  const json = JSON.stringify(backup);
  const settings = await getSettings();
  const gistId = settings.syncGistId;

  if (json.length <= CHUNK_SIZE) {
    files[GIST_FILENAME] = { content: json };
  } else {
    const totalChunks = Math.ceil(json.length / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const chunkName = `examcoach-backup-${String(i).padStart(3, '0')}.json`;
      files[chunkName] = { content: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) };
    }
    files['examcoach-manifest.json'] = {
      content: JSON.stringify({ chunks: totalChunks, exportedAt: backup.exportedAt }),
    };
    if (gistId) files[GIST_FILENAME] = null;
  }

  let resultGistId: string;

  if (gistId) {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ files }),
    });

    if (res.status === 404) {
      resultGistId = await createNewGist(token, files as Record<string, { content: string }>, backup.exportedAt);
    } else if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const details = (body as any).errors
        ? ': ' + JSON.stringify((body as any).errors)
        : '';
      throw new Error(((body as any).message ?? `HTTP ${res.status}`) + details);
    } else {
      resultGistId = gistId;
    }
  } else {
    resultGistId = await createNewGist(token, files as Record<string, { content: string }>, backup.exportedAt);
  }

  await saveSettings({
    syncGistId: resultGistId,
    lastSyncAt: new Date().toISOString(),
  });

  return { success: true, direction: 'push' };
}

async function createNewGist(
  token: string,
  files: Record<string, { content: string }>,
  exportedAt: string,
): Promise<string> {
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      description: `ExamCoach sync backup — ${exportedAt}`,
      public: false,
      files,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message ?? `HTTP ${res.status}`);
  }

  return ((await res.json()) as { id: string }).id;
}

/**
 * Pull from Gist con merge inteligente.
 * Primero comprueba si el Gist cambió desde el último sync (como `git fetch`).
 */
export async function pullFromGist(token: string, force = false): Promise<SyncResult> {
  try {
    const settings = await getSettings();
    const gistId = settings.syncGistId;

    if (!gistId) {
      return { success: false, direction: 'pull', error: 'No hay Gist de sync configurado.' };
    }

    // 1. Check if Gist changed since last sync (HEAD-like check)
    const metaRes = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!metaRes.ok) {
      const body = await metaRes.json().catch(() => ({}));
      throw new Error((body as any).message ?? `HTTP ${metaRes.status}`);
    }

    const gist = (await metaRes.json()) as {
      updated_at: string;
      files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>;
    };

    // Si no ha cambiado desde nuestro último sync, skip (salvo si es forzado)
    if (!force && settings.lastSyncAt && gist.updated_at <= settings.lastSyncAt) {
      return { success: true, direction: 'skip', skipped: 0, added: 0, updated: 0 };
    }

    // 2. Download and parse
    let json: string;

    if (gist.files[GIST_FILENAME]?.content) {
      const file = gist.files[GIST_FILENAME];
      if (file.truncated && file.raw_url) {
        json = await (await fetch(file.raw_url)).text();
      } else {
        json = file.content;
      }
    } else if (gist.files['examcoach-manifest.json']) {
      const manifest = JSON.parse(gist.files['examcoach-manifest.json'].content) as { chunks: number };
      const parts: string[] = [];
      for (let i = 0; i < manifest.chunks; i++) {
        const chunkName = `examcoach-backup-${String(i).padStart(3, '0')}.json`;
        const chunkFile = gist.files[chunkName];
        if (!chunkFile) throw new Error(`Falta chunk ${chunkName}`);
        if (chunkFile.truncated && chunkFile.raw_url) {
          parts.push(await (await fetch(chunkFile.raw_url)).text());
        } else {
          parts.push(chunkFile.content);
        }
      }
      json = parts.join('');
    } else {
      throw new Error('Gist no contiene un backup válido.');
    }

    const backup = JSON.parse(json) as FullBackup;
    if (backup.kind !== 'full-backup') {
      throw new Error('El Gist no contiene un full-backup válido.');
    }

    // 3. Merge datos estructurados — no borra nada, solo añade/actualiza
    const result = await mergeBackup(backup);

    // 4. Merge PDFs — solo descarga los que no existen localmente
    //    Remapear subjectId del manifiesto con el mapa de IDs de asignaturas
    if (backup.pdfManifest && backup.pdfManifest.length > 0) {
      const idMap = result._subjectIdMap;
      const remappedManifest = idMap
        ? backup.pdfManifest.map((entry) => ({
            ...entry,
            subjectId: idMap.get(entry.subjectId) ?? entry.subjectId,
          }))
        : backup.pdfManifest;
      const pdfResult = await importPdfsFromGist(remappedManifest, gist.files);
      result.added = (result.added ?? 0) + pdfResult.imported;
      result.skipped = (result.skipped ?? 0) + pdfResult.skipped;
    }

    return result;
  } catch (err) {
    const msg = String(err);
    const friendly = msg.includes('Failed to fetch')
      ? 'Sin conexión con GitHub. Comprueba la red del dispositivo.'
      : msg;
    return { success: false, direction: 'pull', error: friendly };
  }
}

// ─── Auto-sync engine ────────────────────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;
let lastPushHash = '';

/**
 * Arranca auto-sync periódico.
 * - Pull al inicio (solo si hay cambios remotos).
 * - Push cada `intervalMs` (default: 5 min) si hay cambios locales.
 */
export function startAutoSync(intervalMs = 5 * 60 * 1000): void {
  if (syncInterval) return;
  autoSyncTick();
  syncInterval = setInterval(autoSyncTick, intervalMs);

  // Push al salir de la app (cerrar pestaña, cambiar de app en móvil)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autoSyncPush();
  });
}

export function stopAutoSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

async function autoSyncTick(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.githubToken || !settings.syncGistId) return;

    // Pull primero (solo descarga si hay cambios)
    await pullFromGist(settings.githubToken);

    // Luego push si hay cambios locales
    await autoSyncPush();
  } catch {
    // Auto-sync nunca crashea la app
  }
}

async function autoSyncPush(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.githubToken || !settings.syncGistId) return;

    // Quick hash para detectar cambios locales sin exportar todo
    const [qCount, sCount, dCount, kCount] = await Promise.all([
      db.questions.count(),
      db.sessions.count(),
      db.deliverables.count(),
      db.keyConcepts.count(),
    ]);
    const hash = `${qCount}-${sCount}-${dCount}-${kCount}-${settings.lastStudyDate ?? ''}`;
    if (hash === lastPushHash) return;

    const result = await pushToGist(settings.githubToken);
    if (result.success) lastPushHash = hash;
  } catch { /* silent */ }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr.buffer as ArrayBuffer;
}
