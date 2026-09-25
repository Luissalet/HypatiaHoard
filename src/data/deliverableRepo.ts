import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import type { Deliverable, SubjectGradingConfig } from '@/domain/models';
import { DEFAULT_GRADING_CONFIG } from '@/domain/grading';

const now = () => new Date().toISOString();

// ─── Deliverables ─────────────────────────────────────────────────────────────

export const deliverableRepo = {
  async getBySubject(subjectId: string): Promise<Deliverable[]> {
    return db.deliverables.where('subjectId').equals(subjectId).sortBy('dueDate');
  },

  async getAll(): Promise<Deliverable[]> {
    return db.deliverables.orderBy('dueDate').toArray();
  },

  async create(data: Omit<Deliverable, 'id' | 'createdAt' | 'updatedAt'>): Promise<Deliverable> {
    const d: Deliverable = { ...data, id: uuidv4(), createdAt: now(), updatedAt: now() };
    await db.deliverables.add(d);
    return d;
  },

  async update(id: string, data: Partial<Deliverable>): Promise<void> {
    await db.deliverables.update(id, { ...data, updatedAt: now() });
  },

  async delete(id: string): Promise<void> {
    await db.deliverables.delete(id);
  },

  async deleteBySubject(subjectId: string): Promise<void> {
    await db.deliverables.where('subjectId').equals(subjectId).delete();
  },
};

// ─── Grading Config ───────────────────────────────────────────────────────────

export const gradingConfigRepo = {
  /** Returns existing config or a default one (not persisted until save is called). */
  async get(subjectId: string): Promise<SubjectGradingConfig> {
    const row = await db.gradingConfigs.get(subjectId);
    return row ?? { id: subjectId, ...DEFAULT_GRADING_CONFIG };
  },

  async save(config: SubjectGradingConfig): Promise<void> {
    await db.gradingConfigs.put(config);
  },
};
