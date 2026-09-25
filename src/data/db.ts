import Dexie, { type Table } from 'dexie';
import type {
  Subject,
  Topic,
  Question,
  PracticeSession,
  PdfResource,
  PdfAnchor,
  AppSettings,
  QuestionImageRecord,
  Deliverable,
  SubjectGradingConfig,
  KeyConcept,
  Exam,
  InstalledPackage,
} from '@/domain/models';

/** Registro para guardar un FileSystemDirectoryHandle en IndexedDB. */
export interface FsaHandleRecord {
  key: string;
  handle: FileSystemDirectoryHandle;
  /** Nombre visible del directorio elegido por el usuario */
  name: string;
  /** ISO timestamp de cuándo se configuró */
  savedAt: string;
  /**
   * 'fsa' = File System Access API (desktop, showDirectoryPicker)
   * 'opfs' = Origin Private File System (Android Chrome compatible)
   */
  type?: 'fsa' | 'opfs';
}

export class StudyDB extends Dexie {
  subjects!: Table<Subject, string>;
  topics!: Table<Topic, string>;
  questions!: Table<Question, string>;
  sessions!: Table<PracticeSession, string>;
  pdfResources!: Table<PdfResource, string>;
  pdfAnchors!: Table<PdfAnchor, string>;
  settings!: Table<AppSettings & { id: string }, string>;
  questionImages!: Table<QuestionImageRecord, string>;
  deliverables!: Table<Deliverable, string>;
  gradingConfigs!: Table<SubjectGradingConfig, string>;
  keyConcepts!: Table<KeyConcept, string>;
  exams!: Table<Exam, string>;
  /** Almacena FileSystemDirectoryHandle para File System Access API */
  fsaHandles!: Table<FsaHandleRecord, string>;
  /** Paquetes instalados desde el marketplace */
  installedPackages!: Table<InstalledPackage, string>;

  constructor() {
    super('StudyAppDB');

    this.version(1).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
    });

    // v2: question images (inline en markdown)
    this.version(2).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
    });

    // v3: deliverables + grading configs (local, never synced to global bank)
    this.version(3).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
      deliverables: 'id, subjectId, type, dueDate, completed, createdAt',
      gradingConfigs: 'id',
    });

    // v4: reemplaza `completed: boolean` por `status: DeliverableStatus`
    // Migración automática: completed=true+grade → submitted, completed=true → done, false → pending
    this.version(4)
      .stores({
        subjects: 'id, name, examDate, createdAt',
        topics: 'id, subjectId, order, createdAt',
        questions:
          'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
        sessions: 'id, subjectId, mode, createdAt',
        pdfResources: 'id, subjectId, createdAt',
        pdfAnchors: 'id, subjectId, pdfId',
        settings: 'id',
        questionImages: 'id, filename, createdAt',
        deliverables: 'id, subjectId, type, dueDate, status, createdAt',
        gradingConfigs: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table('deliverables')
          .toCollection()
          .modify((d: Deliverable & { completed?: boolean }) => {
            if (d.status) return; // ya migrado
            const wasCompleted = !!(d as { completed?: boolean }).completed;
            const hasGrade = d.grade != null;
            if (wasCompleted && hasGrade) {
              d.status = 'submitted';
            } else if (wasCompleted) {
              d.status = 'done';
            } else {
              d.status = 'pending';
            }
            // Limpiar campo legacy
            delete (d as { completed?: boolean }).completed;
          });
      });

    // v5: key concepts (formulas, definitions, remarks)
    this.version(5).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
      deliverables: 'id, subjectId, type, dueDate, status, createdAt',
      gradingConfigs: 'id',
      keyConcepts: 'id, subjectId, category, order, contentHash, createdAt',
    });

    // v6: exams (curated question sets)
    this.version(6).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
      deliverables: 'id, subjectId, type, dueDate, status, createdAt',
      gradingConfigs: 'id',
      keyConcepts: 'id, subjectId, category, order, contentHash, createdAt',
      exams: 'id, subjectId, createdAt',
    });

    // v7: File System Access API handles — permite almacenar PDFs directamente en disco
    this.version(7).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
      deliverables: 'id, subjectId, type, dueDate, status, createdAt',
      gradingConfigs: 'id',
      keyConcepts: 'id, subjectId, category, order, contentHash, createdAt',
      exams: 'id, subjectId, createdAt',
      // Solo se indexa la clave primaria; el handle se almacena como objeto opaco
      fsaHandles: 'key',
    });

    // v8: installed packages (marketplace)
    this.version(8).stores({
      subjects: 'id, name, examDate, createdAt',
      topics: 'id, subjectId, order, createdAt',
      questions:
        'id, subjectId, topicId, type, difficulty, contentHash, createdAt',
      sessions: 'id, subjectId, mode, createdAt',
      pdfResources: 'id, subjectId, createdAt',
      pdfAnchors: 'id, subjectId, pdfId',
      settings: 'id',
      questionImages: 'id, filename, createdAt',
      deliverables: 'id, subjectId, type, dueDate, status, createdAt',
      gradingConfigs: 'id',
      keyConcepts: 'id, subjectId, category, order, contentHash, createdAt',
      exams: 'id, subjectId, createdAt',
      fsaHandles: 'key',
      installedPackages: 'id, subjectId, installedAt',
    });
  }
}

export const db = new StudyDB();

// Settings helpers
const SETTINGS_ID = 'global';

export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get(SETTINGS_ID);
  return row ?? { alias: '', importedPackIds: [] };
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const row = await db.settings.get(SETTINGS_ID);
    const current: AppSettings = row ?? { alias: '', importedPackIds: [] };
    await db.settings.put({ ...current, ...settings, id: SETTINGS_ID });
  });
}