import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import type {
  Subject,
  Topic,
  Question,
  PracticeSession,
  UserAnswer,
  QuestionStats,
  KeyConcept,
  KeyConceptCategory,
  Exam,
} from '@/domain/models';
import { computeContentHash } from '@/domain/hashing';
import { slugify, normalizeText } from '@/domain/normalize';

const now = () => new Date().toISOString();

// ─── Subjects ─────────────────────────────────────────────────────────────────

export const subjectRepo = {
  async getAll(): Promise<Subject[]> {
    return db.subjects.orderBy('createdAt').toArray();
  },
  async getById(id: string): Promise<Subject | undefined> {
    return db.subjects.get(id);
  },
  async create(data: Omit<Subject, 'id' | 'createdAt' | 'updatedAt'>): Promise<Subject> {
    const subject: Subject = {
      ...data,
      id: uuidv4(),
      createdAt: now(),
      updatedAt: now(),
    };
    await db.subjects.add(subject);
    return subject;
  },
  async update(id: string, data: Partial<Subject>): Promise<void> {
    await db.subjects.update(id, { ...data, updatedAt: now() });
  },
  async delete(id: string): Promise<void> {
    // Cascade delete topics, questions, sessions
    const topicIds = await db.topics.where('subjectId').equals(id).primaryKeys();
    await db.topics.where('subjectId').equals(id).delete();
    if (topicIds.length > 0) {
      await db.questions.where('subjectId').equals(id).delete();
    }
    await db.sessions.where('subjectId').equals(id).delete();
    await db.pdfAnchors.where('subjectId').equals(id).delete();
    await db.pdfResources.where('subjectId').equals(id).delete();
    await db.keyConcepts.where('subjectId').equals(id).delete();
    await db.subjects.delete(id);
  },
};

// ─── Topics ───────────────────────────────────────────────────────────────────

export const topicRepo = {
  async getBySubject(subjectId: string): Promise<Topic[]> {
    return db.topics.where('subjectId').equals(subjectId).sortBy('order');
  },
  async getById(id: string): Promise<Topic | undefined> {
    return db.topics.get(id);
  },
  async create(data: Omit<Topic, 'id' | 'createdAt' | 'updatedAt'>): Promise<Topic> {
    const topic: Topic = {
      ...data,
      id: uuidv4(),
      createdAt: now(),
      updatedAt: now(),
    };
    await db.topics.add(topic);
    return topic;
  },
  async update(id: string, data: Partial<Topic>): Promise<void> {
    await db.topics.update(id, { ...data, updatedAt: now() });
  },
  async delete(id: string): Promise<void> {
    await db.questions.where('topicId').equals(id).delete();
    await db.topics.delete(id);
  },
  async getNextOrder(subjectId: string): Promise<number> {
    const topics = await db.topics.where('subjectId').equals(subjectId).toArray();
    return topics.length === 0 ? 0 : Math.max(...topics.map((t) => t.order)) + 1;
  },
};

// ─── Questions ────────────────────────────────────────────────────────────────

export const questionRepo = {
  async getBySubject(subjectId: string): Promise<Question[]> {
    return db.questions.where('subjectId').equals(subjectId).toArray();
  },
  async getByTopic(topicId: string): Promise<Question[]> {
    return db.questions.where('topicId').equals(topicId).toArray();
  },
  async getById(id: string): Promise<Question | undefined> {
    return db.questions.get(id);
  },
  async getManyByIds(ids: string[]): Promise<Question[]> {
    return db.questions.where('id').anyOf(ids).toArray();
  },
  async getFailed(subjectId: string): Promise<Question[]> {
    const all = await db.questions.where('subjectId').equals(subjectId).toArray();
    return all.filter((q) => q.stats.lastResult === 'WRONG');
  },
  async create(
    data: Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>,
    alias?: string
  ): Promise<Question> {
    const topicObj = await topicRepo.getById(data.topicId);
    const topicKey = topicObj ? slugify(topicObj.title) : data.topicId;
    const contentHash = await computeContentHash(data, topicKey);

    const question: Question = {
      ...data,
      id: uuidv4(),
      contentHash,
      createdBy: alias,
      stats: { seen: 0, correct: 0, wrong: 0 },
      createdAt: now(),
      updatedAt: now(),
    };
    await db.questions.add(question);
    return question;
  },
  async update(id: string, data: Partial<Question>): Promise<void> {
    await db.questions.update(id, { ...data, updatedAt: now() });
  },
  async delete(id: string): Promise<void> {
    await db.questions.delete(id);
  },
  async duplicate(id: string): Promise<Question> {
    const q = await db.questions.get(id);
    if (!q) throw new Error('Question not found');
    const copy: Question = {
      ...q,
      id: uuidv4(),
      stats: { seen: 0, correct: 0, wrong: 0 },
      createdAt: now(),
      updatedAt: now(),
    };
    await db.questions.add(copy);
    return copy;
  },
  async updateStats(
    id: string,
    result: 'CORRECT' | 'WRONG'
  ): Promise<void> {
    const q = await db.questions.get(id);
    if (!q) return;
    const { calcNextReview } = await import('@/domain/spacedRepetition');
    const sm2 = calcNextReview(q.stats, result);
    const stats: QuestionStats = {
      seen: q.stats.seen + 1,
      correct: q.stats.correct + (result === 'CORRECT' ? 1 : 0),
      wrong: q.stats.wrong + (result === 'WRONG' ? 1 : 0),
      lastSeenAt: now(),
      lastResult: result,
      ...sm2,
    };
    await db.questions.update(id, { stats, updatedAt: now() });
  },
  async existsByHash(contentHash: string, subjectId: string): Promise<boolean> {
    const count = await db.questions
      .where('contentHash')
      .equals(contentHash)
      .and((q) => q.subjectId === subjectId)
      .count();
    return count > 0;
  },
};

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const sessionRepo = {
  async getBySubject(subjectId: string): Promise<PracticeSession[]> {
    return db.sessions
      .where('subjectId')
      .equals(subjectId)
      .reverse()
      .sortBy('createdAt');
  },
  async getById(id: string): Promise<PracticeSession | undefined> {
    return db.sessions.get(id);
  },
  async create(data: Omit<PracticeSession, 'id' | 'createdAt' | 'answers'>): Promise<PracticeSession> {
    const session: PracticeSession = {
      ...data,
      id: uuidv4(),
      answers: [],
      createdAt: now(),
    };
    await db.sessions.add(session);
    return session;
  },
  async addAnswer(sessionId: string, answer: UserAnswer): Promise<void> {
    const session = await db.sessions.get(sessionId);
    if (!session) return;
    const answers = [...session.answers, answer];
    await db.sessions.update(sessionId, { answers });
  },
  async finish(sessionId: string): Promise<void> {
    await db.sessions.update(sessionId, { finishedAt: now() });

    // Update study streak
    try {
      const { getSettings, saveSettings } = await import('./db');
      const settings = await getSettings();
      const todayStr = new Date().toISOString().split('T')[0];
      const lastStudy = settings.lastStudyDate;
      let streak = settings.studyStreak ?? 0;
      if (lastStudy === todayStr) {
        // Already studied today, streak unchanged
      } else {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        if (lastStudy === yesterdayStr) {
          streak += 1; // Extend streak
        } else {
          streak = 1; // Reset streak (missed a day)
        }
      }
      await saveSettings({ studyStreak: streak, lastStudyDate: todayStr });
    } catch {
      /* non-critical */
    }
  },
  async delete(id: string): Promise<void> {
    await db.sessions.delete(id);
  },
  async updateAnswer(sessionId: string, questionId: string, patch: Partial<UserAnswer>): Promise<void> {
    const session = await db.sessions.get(sessionId);
    if (!session) return;
    const answers = session.answers.map((a) =>
      a.questionId === questionId ? { ...a, ...patch } : a
    );
    await db.sessions.update(sessionId, { answers });
  },
};

// ─── Key Concepts ────────────────────────────────────────────────────────────

/** Hash ligero para deduplicar conceptos clave (no usa el hash de preguntas). */
async function computeConceptHash(
  category: string,
  title: string,
  content: string,
): Promise<string> {
  const raw = [category, normalizeText(title), normalizeText(content)].join('::');
  const data = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(buf));
  return 'sha256:' + arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const keyConceptRepo = {
  async getBySubject(subjectId: string): Promise<KeyConcept[]> {
    return db.keyConcepts.where('subjectId').equals(subjectId).sortBy('order');
  },

  async getById(id: string): Promise<KeyConcept | undefined> {
    return db.keyConcepts.get(id);
  },

  async create(
    data: Omit<KeyConcept, 'id' | 'createdAt' | 'updatedAt' | 'contentHash'>,
    alias?: string,
  ): Promise<KeyConcept> {
    const contentHash = await computeConceptHash(data.category, data.title, data.content);
    const concept: KeyConcept = {
      ...data,
      id: uuidv4(),
      contentHash,
      createdBy: alias ?? data.createdBy,
      createdAt: now(),
      updatedAt: now(),
    };
    await db.keyConcepts.add(concept);
    return concept;
  },

  async update(id: string, data: Partial<KeyConcept>): Promise<void> {
    // Recalcular hash si cambia el contenido
    if (data.title !== undefined || data.content !== undefined || data.category !== undefined) {
      const existing = await db.keyConcepts.get(id);
      if (existing) {
        const title = data.title ?? existing.title;
        const content = data.content ?? existing.content;
        const category = data.category ?? existing.category;
        data.contentHash = await computeConceptHash(category, title, content);
      }
    }
    await db.keyConcepts.update(id, { ...data, updatedAt: now() });
  },

  async delete(id: string): Promise<void> {
    await db.keyConcepts.delete(id);
  },

  async deleteBySubject(subjectId: string): Promise<void> {
    await db.keyConcepts.where('subjectId').equals(subjectId).delete();
  },

  async existsByHash(contentHash: string, subjectId: string): Promise<boolean> {
    const count = await db.keyConcepts
      .where('contentHash')
      .equals(contentHash)
      .and((c) => c.subjectId === subjectId)
      .count();
    return count > 0;
  },

  async getNextOrder(subjectId: string, category: KeyConceptCategory): Promise<number> {
    const concepts = await db.keyConcepts
      .where('subjectId')
      .equals(subjectId)
      .filter((c) => c.category === category)
      .toArray();
    return concepts.length === 0 ? 0 : Math.max(...concepts.map((c) => c.order)) + 1;
  },
};

// ─── Exams ────────────────────────────────────────────────────────────────────

export const examRepo = {
  async getBySubject(subjectId: string): Promise<Exam[]> {
    return db.exams.where('subjectId').equals(subjectId).sortBy('createdAt');
  },

  async getById(id: string): Promise<Exam | undefined> {
    return db.exams.get(id);
  },

  async create(data: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>): Promise<Exam> {
    const exam: Exam = {
      ...data,
      id: uuidv4(),
      createdAt: now(),
      updatedAt: now(),
    };
    await db.exams.add(exam);
    return exam;
  },

  async update(id: string, data: Partial<Exam>): Promise<void> {
    await db.exams.update(id, { ...data, updatedAt: now() });
  },

  async delete(id: string): Promise<void> {
    await db.exams.delete(id);
  },

  async duplicate(id: string): Promise<Exam> {
    const exam = await db.exams.get(id);
    if (!exam) throw new Error('Exam not found');
    const copy: Exam = {
      ...exam,
      id: uuidv4(),
      name: `${exam.name} (copia)`,
      createdAt: now(),
      updatedAt: now(),
    };
    await db.exams.add(copy);
    return copy;
  },
};
