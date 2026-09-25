import { create } from 'zustand';
import type { Subject, Topic, Question, PracticeSession, AppSettings, KeyConcept, Exam } from '@/domain/models';
import { subjectRepo, topicRepo, questionRepo, sessionRepo, keyConceptRepo, examRepo } from '@/data/repos';
import { getSettings, saveSettings } from '@/data/db';
import { syncWithGlobalBank, type GlobalBankSyncResult } from '@/data/globalBank';
import type { SynthesisProgress } from '@/utils/backgroundSynthesis';

/** Sync status with the local Hypatia's Hoard server (hoard mode only; null otherwise). */
export interface HoardStatus {
  connected: boolean;
  lastSyncAt: string | null;
  rev: number;
  error: string | null;
  syncing: boolean;
}

interface AppStore {
  // Data
  subjects: Subject[];
  topics: Topic[];
  questions: Question[];
  currentSession: PracticeSession | null;
  keyConcepts: KeyConcept[];
  exams: Exam[];
  settings: AppSettings;

  // Loading state
  loading: boolean;
  error: string | null;

  // Global bank sync state
  syncing: boolean;
  lastSyncResult: GlobalBankSyncResult | null;

  // Background synthesis state
  synthesisJobs: Record<string, SynthesisProgress>;
  setSynthesisProgress: (jobId: string, progress: SynthesisProgress | null) => void;

  // Hypatia's Hoard sync (hoard mode only)
  hoardStatus: HoardStatus | null;
  setHoardStatus: (patch: Partial<HoardStatus>) => void;

  // Actions - Subjects
  loadSubjects: () => Promise<void>;
  createSubject: (data: Omit<Subject, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Subject>;
  updateSubject: (id: string, data: Partial<Subject>) => Promise<void>;
  deleteSubject: (id: string) => Promise<void>;

  // Actions - Topics
  loadTopics: (subjectId: string) => Promise<void>;
  createTopic: (data: Omit<Topic, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Topic>;
  updateTopic: (id: string, data: Partial<Topic>) => Promise<void>;
  deleteTopic: (id: string) => Promise<void>;

  // Actions - Questions
  loadQuestions: (subjectId: string) => Promise<void>;
  createQuestion: (data: Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>) => Promise<Question>;
  updateQuestion: (id: string, data: Partial<Question>) => Promise<void>;
  deleteQuestion: (id: string) => Promise<void>;
  duplicateQuestion: (id: string) => Promise<void>;

  // Actions - Key Concepts
  loadKeyConcepts: (subjectId: string) => Promise<void>;
  createKeyConcept: (data: Omit<KeyConcept, 'id' | 'createdAt' | 'updatedAt' | 'contentHash'>) => Promise<KeyConcept>;
  updateKeyConcept: (id: string, data: Partial<KeyConcept>) => Promise<void>;
  deleteKeyConcept: (id: string) => Promise<void>;

  // Actions - Exams
  loadExams: (subjectId: string) => Promise<void>;
  createExam: (data: Omit<Exam, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Exam>;
  updateExam: (id: string, data: Partial<Exam>) => Promise<void>;
  deleteExam: (id: string) => Promise<void>;
  duplicateExam: (id: string) => Promise<void>;

  // Actions - Sessions
  setCurrentSession: (session: PracticeSession | null) => void;
  loadSession: (id: string) => Promise<void>;

  // Actions - Settings
  loadSettings: () => Promise<void>;
  updateSettings: (data: Partial<AppSettings>) => Promise<void>;

  // Actions - Global bank
  /**
   * Sincroniza con /data/global-bank.json.
   * - Primera vez (nunca sincronizado): siempre lo hace.
   * - Siguientes veces: solo si force=true o han pasado más de 1h.
   * - Es idempotente: deduplicación por contentHash.
   */
  syncGlobalBank: (force?: boolean) => Promise<GlobalBankSyncResult | null>;
}

export const useStore = create<AppStore>((set, get) => ({
  subjects: [],
  topics: [],
  questions: [],
  currentSession: null,
  keyConcepts: [],
  exams: [],
  settings: { alias: '', importedPackIds: [] },
  loading: false,
  error: null,
  syncing: false,
  lastSyncResult: null,
  synthesisJobs: {},
  hoardStatus: null,

  setHoardStatus: (patch) => {
    set((s) => ({
      hoardStatus: {
        ...(s.hoardStatus ?? { connected: false, lastSyncAt: null, rev: 0, error: null, syncing: false }),
        ...patch,
      },
    }));
  },

  setSynthesisProgress: (jobId, progress) => {
    set((s) => {
      const jobs = { ...s.synthesisJobs };
      if (progress === null) {
        delete jobs[jobId];
      } else {
        jobs[jobId] = progress;
      }
      return { synthesisJobs: jobs };
    });
  },

  loadSubjects: async () => {
    set({ loading: true });
    try {
      const subjects = await subjectRepo.getAll();
      set({ subjects, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createSubject: async (data) => {
    const subject = await subjectRepo.create(data);
    set((s) => ({ subjects: [...s.subjects, subject] }));
    return subject;
  },

  updateSubject: async (id, data) => {
    await subjectRepo.update(id, data);
    set((s) => ({
      subjects: s.subjects.map((sub) => (sub.id === id ? { ...sub, ...data } : sub)),
    }));
  },

  deleteSubject: async (id) => {
    await subjectRepo.delete(id);
    set((s) => ({ subjects: s.subjects.filter((sub) => sub.id !== id) }));
  },

  loadTopics: async (subjectId) => {
    const topics = await topicRepo.getBySubject(subjectId);
    set({ topics });
  },

  createTopic: async (data) => {
    const topic = await topicRepo.create(data);
    set((s) => ({ topics: [...s.topics, topic] }));
    return topic;
  },

  updateTopic: async (id, data) => {
    await topicRepo.update(id, data);
    set((s) => ({
      topics: s.topics.map((t) => (t.id === id ? { ...t, ...data } : t)),
    }));
  },

  deleteTopic: async (id) => {
    await topicRepo.delete(id);
    set((s) => ({
      topics: s.topics.filter((t) => t.id !== id),
      questions: s.questions.filter((q) => q.topicId !== id),
    }));
  },

  loadQuestions: async (subjectId) => {
    const questions = await questionRepo.getBySubject(subjectId);
    set({ questions });
  },

  createQuestion: async (data) => {
    const { settings } = get();
    const question = await questionRepo.create(data, settings.alias);
    set((s) => ({ questions: [...s.questions, question] }));
    return question;
  },

  updateQuestion: async (id, data) => {
    await questionRepo.update(id, data);
    set((s) => ({
      questions: s.questions.map((q) => (q.id === id ? { ...q, ...data } : q)),
    }));
  },

  deleteQuestion: async (id) => {
    await questionRepo.delete(id);
    set((s) => ({ questions: s.questions.filter((q) => q.id !== id) }));
  },

  duplicateQuestion: async (id) => {
    const copy = await questionRepo.duplicate(id);
    set((s) => ({ questions: [...s.questions, copy] }));
  },

  // ─── Key Concepts ──────────────────────────────────────────────────────────
  loadKeyConcepts: async (subjectId) => {
    const keyConcepts = await keyConceptRepo.getBySubject(subjectId);
    set({ keyConcepts });
  },

  createKeyConcept: async (data) => {
    const { settings } = get();
    const concept = await keyConceptRepo.create(data, settings.alias);
    set((s) => ({ keyConcepts: [...s.keyConcepts, concept] }));
    return concept;
  },

  updateKeyConcept: async (id, data) => {
    await keyConceptRepo.update(id, data);
    set((s) => ({
      keyConcepts: s.keyConcepts.map((c) => (c.id === id ? { ...c, ...data } : c)),
    }));
  },

  deleteKeyConcept: async (id) => {
    await keyConceptRepo.delete(id);
    set((s) => ({ keyConcepts: s.keyConcepts.filter((c) => c.id !== id) }));
  },

  // ─── Exams ────────────────────────────────────────────────────────────────
  loadExams: async (subjectId) => {
    const exams = await examRepo.getBySubject(subjectId);
    set({ exams });
  },

  createExam: async (data) => {
    const exam = await examRepo.create(data);
    set((s) => ({ exams: [...s.exams, exam] }));
    return exam;
  },

  updateExam: async (id, data) => {
    await examRepo.update(id, data);
    set((s) => ({
      exams: s.exams.map((e) => (e.id === id ? { ...e, ...data } : e)),
    }));
  },

  deleteExam: async (id) => {
    await examRepo.delete(id);
    set((s) => ({ exams: s.exams.filter((e) => e.id !== id) }));
  },

  duplicateExam: async (id) => {
    const copy = await examRepo.duplicate(id);
    set((s) => ({ exams: [...s.exams, copy] }));
  },

  setCurrentSession: (session) => set({ currentSession: session }),

  loadSession: async (id) => {
    const session = await sessionRepo.getById(id);
    set({ currentSession: session ?? null });
  },

  loadSettings: async () => {
    const settings = await getSettings();
    set({ settings });
  },

  updateSettings: async (data) => {
    await saveSettings(data);
    set((s) => ({ settings: { ...s.settings, ...data } }));
  },

  syncGlobalBank: async (force = false) => {
  const { syncing, settings } = get();
  if (syncing) return null;

  // Si ya se sincronizó antes y no es forzado, no repetir
  if (!force && settings.globalBankSyncedAt) {
    return null;
  }

  set({ syncing: true });
  try {
    const result = await syncWithGlobalBank();
    if (result.subjectsAdded > 0 || result.topicsAdded > 0 || result.questionsAdded > 0) {
      const subjects = await subjectRepo.getAll();
      set({ subjects });
    }
    const updatedSettings = await getSettings();
    set({ settings: updatedSettings, lastSyncResult: result, syncing: false });
    return result;
  } catch (e) {
    set({ syncing: false });
    return null;
  }
},
}));