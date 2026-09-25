import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, getSettings, saveSettings } from './db';
import { keyConceptRepo } from './repos';
import { slugify } from '@/domain/normalize';
import type { KeyConcept, KeyConceptsPack, KeyConceptExport } from '@/domain/models';

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const KeyConceptExportSchema = z.object({
  id: z.string(),
  topicKey: z.string().optional(),
  category: z.enum(['formula', 'definition', 'remark']),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  order: z.number(),
  createdBy: z.string().optional(),
  contentHash: z.string().optional(),
});

const KeyConceptsPackSchema = z.object({
  version: z.literal(1),
  kind: z.literal('keyconcepts'),
  packId: z.string(),
  createdBy: z.string(),
  exportedAt: z.string(),
  subjectKey: z.string(),
  subjectName: z.string(),
  topics: z
    .array(z.object({ topicKey: z.string(), topicTitle: z.string() }))
    .optional(),
  concepts: z.array(KeyConceptExportSchema),
});

// ─── Import Result ────────────────────────────────────────────────────────────

export interface KeyConceptsImportResult {
  packId: string;
  createdBy: string;
  subjectId: string;
  newConcepts: number;
  duplicates: number;
  newTopicsCreated: number;
  alreadyImported: boolean;
  errors: string[];
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importKeyConceptsPack(
  raw: unknown,
): Promise<KeyConceptsImportResult> {
  const result: KeyConceptsImportResult = {
    packId: '',
    createdBy: '',
    subjectId: '',
    newConcepts: 0,
    duplicates: 0,
    newTopicsCreated: 0,
    alreadyImported: false,
    errors: [],
  };

  // 1. Validate
  const parsed = KeyConceptsPackSchema.safeParse(raw);
  if (!parsed.success) {
    result.errors.push('JSON inválido: ' + parsed.error.message);
    return result;
  }

  const pack = parsed.data as KeyConceptsPack;
  result.packId = pack.packId;
  result.createdBy = pack.createdBy;

  // 2. Check if already imported
  const settings = await getSettings();
  if (settings.importedPackIds?.includes(pack.packId)) {
    result.alreadyImported = true;
    return result;
  }

  const ts = new Date().toISOString();

  // 3. Resolve or create subject
  const allSubjects = await db.subjects.toArray();
  let subject = allSubjects.find((s) => slugify(s.name) === pack.subjectKey);

  if (!subject) {
    subject = {
      id: uuidv4(),
      name: pack.subjectName,
      createdAt: ts,
      updatedAt: ts,
    };
    await db.subjects.add(subject);
  }
  result.subjectId = subject.id;

  // 4. Build topic lookup
  const subjectTopics = await db.topics
    .where('subjectId')
    .equals(subject.id)
    .toArray();
  const topicByKey = new Map<string, string>();
  for (const t of subjectTopics) {
    topicByKey.set(slugify(t.title), t.id);
  }

  // Create missing topics from pack metadata
  if (pack.topics) {
    let nextOrder = subjectTopics.length;
    for (const info of pack.topics) {
      if (!topicByKey.has(info.topicKey)) {
        const newTopic = {
          id: uuidv4(),
          subjectId: subject.id,
          title: info.topicTitle,
          order: nextOrder++,
          createdAt: ts,
          updatedAt: ts,
        };
        await db.topics.add(newTopic);
        topicByKey.set(info.topicKey, newTopic.id);
        result.newTopicsCreated++;
      }
    }
  }

  // 5. Import concepts
  for (const exp of pack.concepts) {
    try {
      // Compute hash for dedup (or use provided)
      const hashToCheck =
        exp.contentHash ??
        (await computeConceptHashForImport(exp.category, exp.title, exp.content));

      const isDuplicate = await keyConceptRepo.existsByHash(
        hashToCheck,
        subject.id,
      );
      if (isDuplicate) {
        result.duplicates++;
        continue;
      }

      const topicId = exp.topicKey
        ? topicByKey.get(exp.topicKey)
        : undefined;

      const concept: KeyConcept = {
        id: uuidv4(),
        subjectId: subject.id,
        topicId,
        category: exp.category,
        title: exp.title,
        content: exp.content,
        tags: exp.tags,
        order: exp.order,
        createdBy: exp.createdBy ?? pack.createdBy,
        sourcePackId: pack.packId,
        contentHash: hashToCheck,
        createdAt: ts,
        updatedAt: ts,
      };

      await db.keyConcepts.add(concept);
      result.newConcepts++;
    } catch (err) {
      result.errors.push(
        `Error importando "${exp.title}": ${String(err)}`,
      );
    }
  }

  // 6. Mark pack as imported
  await saveSettings({
    ...settings,
    importedPackIds: [...(settings.importedPackIds ?? []), pack.packId],
  });

  return result;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportKeyConceptsPack(
  subjectId: string,
): Promise<KeyConceptsPack> {
  const subject = await db.subjects.get(subjectId);
  if (!subject) throw new Error('Subject not found');

  const concepts = await keyConceptRepo.getBySubject(subjectId);
  const subjectTopics = await db.topics
    .where('subjectId')
    .equals(subjectId)
    .toArray();

  // Map topicId → slug info
  const topicIdToInfo = new Map<string, { key: string; title: string }>();
  for (const t of subjectTopics) {
    topicIdToInfo.set(t.id, { key: slugify(t.title), title: t.title });
  }

  // Collect which topics are actually referenced
  const usedTopicIds = new Set<string>();
  for (const c of concepts) {
    if (c.topicId) usedTopicIds.add(c.topicId);
  }

  const exported: KeyConceptExport[] = concepts.map((c) => ({
    id: c.id,
    topicKey: c.topicId ? topicIdToInfo.get(c.topicId)?.key : undefined,
    category: c.category,
    title: c.title,
    content: c.content,
    tags: c.tags,
    order: c.order,
    createdBy: c.createdBy,
    contentHash: c.contentHash,
  }));

  const topicsArray = Array.from(usedTopicIds)
    .map((id) => topicIdToInfo.get(id))
    .filter(Boolean)
    .map((info) => ({ topicKey: info!.key, topicTitle: info!.title }));

  const settings = await getSettings();

  return {
    version: 1,
    kind: 'keyconcepts',
    packId: uuidv4(),
    createdBy: settings.alias || 'anonymous',
    exportedAt: new Date().toISOString(),
    subjectKey: slugify(subject.name),
    subjectName: subject.name,
    topics: topicsArray.length > 0 ? topicsArray : undefined,
    concepts: exported,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function computeConceptHashForImport(
  category: string,
  title: string,
  content: string,
): Promise<string> {
  const raw = [
    category,
    title.trim().toLowerCase().replace(/\s+/g, ' '),
    content.trim().toLowerCase().replace(/\s+/g, ' '),
  ].join('::');
  const data = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(buf));
  return 'sha256:' + arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}
