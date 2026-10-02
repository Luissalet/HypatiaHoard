/**
 * teacher.ts — tipos del rol Profesor.
 *
 * DATOS LOCALES: todo lo que hay aquí (clases, alumnos, entregas, notas) vive solo
 * en este dispositivo (IndexedDB) y en el servidor local de Hypatia. Nunca entra en
 * la copia de Gist, el banco global, los contribution packs ni los paquetes
 * (ver data/studentPrivacy.ts).
 */

import type { QuestionType, QuestionOption, ClozeBlank, DifficultyLevel } from './models';

export type Role = 'student' | 'teacher';

/** Tipo de registro tal como lo nombra el servidor (hypatia/teacher/store.py). */
export type TeacherKind =
  | 'class' | 'student' | 'teacherExam' | 'rubric' | 'gradingBatch' | 'submission' | 'proposal' | 'teacherSettings';

export interface TeacherClass {
  id: string;
  name: string;
  course?: string | null;
  year?: string | null;
  subjectIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeacherStudent {
  id: string;
  classId: string;
  /** Nombre visible o alias. No se guarda ningún otro dato personal. */
  displayName: string;
  /** Solo como referencia del profesor; la app no lo usa para nada. */
  email?: string;
  order?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExamHeader {
  centre: string;
  course: string;
  date: string;
  instructions: string;
  durationMin?: number | null;
}

export type DifficultyMix = { easy: number; medium: number; hard: number };
export type ExamSource = 'bank' | 'generate' | 'mixed';

export interface ExamSpec {
  subjectId: string;
  topicIds: string[];
  counts: Partial<Record<QuestionType, number>>;
  difficulty?: DifficultyMix | null;
  source: ExamSource;
  versions: number;
  pointsByType?: Partial<Record<QuestionType, number>>;
  /** Fracción de los puntos de un TEST que resta una respuesta errónea (0 = no resta). */
  testPenalty?: number;
}

export interface ExamItem {
  questionId: string;
  points: number;
  rubricId?: string | null;
}

export interface ExamVersion {
  label: string;
  questionOrder: string[];
  /** questionId → ids de opción en el orden impreso (a, b, c…). */
  optionOrder: Record<string, string[]>;
}

export interface Citation {
  n: number;
  sourceId?: string;
  filename?: string;
  title?: string | null;
  page?: number | null;
  snippet?: string;
}

/** Pregunta generada por el modelo: borrador hasta que el profesor la aprueba. */
export interface ExamDraft {
  id: string;
  type: QuestionType;
  question: {
    type: QuestionType;
    prompt: string;
    options?: QuestionOption[];
    correctOptionIds?: string[];
    modelAnswer?: string;
    keywords?: string[];
    numericAnswer?: string;
    clozeText?: string;
    blanks?: ClozeBlank[];
    explanation?: string;
    difficulty?: DifficultyLevel;
  };
  topicId?: string | null;
  points: number;
  citations: Citation[];
  answerCitations?: Citation[];
  status: 'pending' | 'approved' | 'rejected';
  questionId?: string;
  model?: string | null;
  createdAt?: string;
}

export interface TeacherExam {
  id: string;
  subjectId: string;
  title: string;
  status: 'draft' | 'ready';
  classId?: string | null;
  header: ExamHeader;
  spec: ExamSpec;
  items: ExamItem[];
  versions: ExamVersion[];
  drafts: ExamDraft[];
  notes: string[];
  /** Copia practicable: entidad Exam del banco (pestaña Exámenes de la asignatura). */
  practiceExamId?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RubricLevel {
  id: string;
  descriptor: string;
  points: number;
}

export interface RubricCriterion {
  id: string;
  name: string;
  weight: number;
  levels: RubricLevel[];
}

export interface Rubric {
  id: string;
  subjectId: string;
  examId?: string | null;
  questionId?: string | null;
  scope: 'question' | 'exam';
  title: string;
  criteria: RubricCriterion[];
  origin: 'manual' | 'llm' | 'template';
  createdAt: string;
  updatedAt: string;
}

export interface GradingBatch {
  id: string;
  examId: string;
  classId: string;
  title: string;
  status: 'open' | 'grading' | 'review' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface StoredAnswer {
  /** TEST: letras tal como se imprimieron en la versión del alumno ("b", "a,c"). */
  letters?: string;
  selectedOptionIds?: string[];
  blankAnswers?: Record<string, string>;
  text?: string;
  source?: 'grid' | 'csv' | 'text' | 'pdf' | 'photo';
  fileName?: string;
}

export interface CriterionScore {
  criterionId: string;
  levelId: string | null;
  points: number | null;
  maxPoints: number;
  justification?: string;
  quotes?: string[];
  droppedQuotes?: number;
  name?: string | null;
}

export interface Decision {
  points: number;
  rubricId?: string | null;
  criteria?: CriterionScore[];
  comment?: string | null;
  source: 'proposal' | 'override' | 'auto';
  at?: string;
}

export interface SubmissionResult {
  points: number;
  maxPoints: number;
  grade: number | null;
  band: string | null;
  pending: string[];
  complete: boolean;
}

export interface FeedbackEntry {
  questionId: string;
  position?: number;
  topicId?: string | null;
  topic?: string | null;
  prompt: string;
  ratio: number;
  detail?: string;
}

export interface Feedback {
  strengths: FeedbackEntry[];
  strongTopics: string[];
  mistakes: FeedbackEntry[];
  review: { topicId: string | null; topic: string | null; ratio: number; keyConcepts: { id: string; title: string }[] }[];
}

export interface Submission {
  id: string;
  batchId: string;
  studentId: string;
  version: string;
  answers: Record<string, StoredAnswer>;
  decisions: Record<string, Decision>;
  confirmed: boolean;
  confirmedAt?: string;
  result?: SubmissionResult;
  feedback?: Feedback;
  comment?: string;
  reinforceExamId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Propuesta del modelo para una respuesta abierta (la escribe el servidor). */
export interface GradingProposal {
  id: string;
  batchId: string;
  submissionId: string;
  studentId: string;
  questionId: string;
  rubricId: string;
  status: 'ok' | 'partial' | 'empty' | 'error' | 'no_model';
  criteria: CriterionScore[];
  points: number | null;
  maxPoints: number;
  confidence: number | null;
  droppedQuotes: number;
  comment?: string | null;
  model?: string | null;
  note?: string | null;
  answerExcerpt?: string;
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GradeBand {
  min: number;
  label: string;
}

export interface GradeScale {
  max: number;
  decimals: number;
  bands: GradeBand[];
}

export interface TeacherSettings {
  id: 'default';
  scale: GradeScale;
  createdAt: string;
  updatedAt: string;
}
