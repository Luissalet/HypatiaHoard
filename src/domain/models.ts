// ─── Core types ──────────────────────────────────────────────────────────────

export type QuestionType = 'TEST' | 'DESARROLLO' | 'COMPLETAR' | 'PRACTICO';
export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

/**
 * ITER2 — Origen de la pregunta: de dónde fue extraída.
 * - test: de un test/examen de práctica
 * - examen_anterior: de un examen oficial de años anteriores
 * - clase: pregunta planteada durante clase
 * - alumno: aportada directamente por un alumno
 */
export type QuestionOrigin = 'test' | 'examen_anterior' | 'clase' | 'alumno';

// ─── Entities ─────────────────────────────────────────────────────────────────

export interface Subject {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  /**
   * Fecha de examen personal — NUNCA se exporta al banco global ni se importa
   * desde él. Cada usuario la configura localmente.
   */
  examDate?: string; // ISO YYYY-MM-DD
  /**
   * Si la asignatura permite apuntes/chuleta en el examen.
   * Cuando está definido, tiene prioridad sobre extra_info.json.
   * undefined = no configurado (se usa el valor de extra_info.json si existe).
   */
  allowsNotes?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Topic {
  id: string;
  subjectId: string;
  title: string;
  order: number;
  tags?: string[];
  /** Nombre del archivo PDF asociado a este tema (de resources/[slug]/Temas/) */
  pdfFilename?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Key Concepts ────────────────────────────────────────────────────────────

export type KeyConceptCategory = 'formula' | 'definition' | 'remark';

/**
 * Concepto clave de una asignatura: fórmula, definición u observación.
 * Se almacena en IndexedDB y se puede exportar/importar como JSON pack.
 */
export interface KeyConcept {
  id: string;
  subjectId: string;
  /** Enlace opcional al tema al que pertenece este concepto. */
  topicId?: string;
  category: KeyConceptCategory;
  title: string;
  /** Contenido en Markdown con soporte LaTeX (KaTeX). */
  content: string;
  tags?: string[];
  /** Orden dentro de su categoría para la asignatura. */
  order: number;
  createdBy?: string;
  sourcePackId?: string;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

/** Formato portable de un concepto para export/import (usa topicKey en vez de topicId). */
export interface KeyConceptExport {
  id: string;
  topicKey?: string;
  category: KeyConceptCategory;
  title: string;
  content: string;
  tags?: string[];
  order: number;
  createdBy?: string;
  contentHash?: string;
}

/** Pack de conceptos clave para compartir en GitHub / generar con ChatGPT. */
export interface KeyConceptsPack {
  version: 1;
  kind: 'keyconcepts';
  packId: string;
  createdBy: string;
  exportedAt: string;
  subjectKey: string;
  subjectName: string;
  topics?: { topicKey: string; topicTitle: string }[];
  concepts: KeyConceptExport[];
}

export interface QuestionOption {
  id: string;
  text: string;
}

export interface ClozeBlank {
  id: string;
  accepted: string[]; // accepted answers (normalized at check time)
}

export interface QuestionStats {
  seen: number;
  correct: number;
  wrong: number;
  lastSeenAt?: string;
  lastResult?: 'CORRECT' | 'WRONG';
  // Spaced Repetition SM-2
  easeFactor?: number;
  interval?: number;
  nextReviewAt?: string;  // ISO date
  repetitions?: number;
}

export interface Question {
  id: string;
  subjectId: string;
  topicId: string;
  /**
   * ITER3 — Temas adicionales. Una pregunta puede abarcar varios temas.
   * topicId sigue siendo el tema principal (para backward-compat e indexación).
   * topicIds incluye TODOS los temas (incluido topicId) cuando hay más de uno.
   */
  topicIds?: string[];
  type: QuestionType;
  prompt: string;
  explanation?: string;
  difficulty?: DifficultyLevel;
  tags?: string[];

  /** ITER2 — Origen de la pregunta (dónde fue extraída). */
  origin?: QuestionOrigin;

  // TEST
  options?: QuestionOption[];
  correctOptionIds?: string[];

  // DESARROLLO / PRACTICO
  modelAnswer?: string;
  keywords?: string[];
  /** ITER3 — Resultado numérico esperado (para preguntas de tipo PRACTICO). */
  numericAnswer?: string;

  // COMPLETAR
  clozeText?: string;
  blanks?: ClozeBlank[];

  // PDF anchor
  pdfAnchorId?: string;

  /**
   * @deprecated — Imágenes antiguas adjuntas como base64 data URIs.
   * Las nuevas imágenes van inline en el markdown del prompt como
   * ![alt](question-images/uuid.ext) y se gestionan via questionImageStorage.
   */
  imageDataUrls?: string[];

  // Contribution metadata
  createdBy?: string;
  sourcePackId?: string;
  contentHash?: string;

  /**
   * Nota personal del usuario. LOCAL — nunca se exporta al banco global,
   * contribution packs, ni se incluye en contentHash.
   */
  notes?: string;

  /**
   * Marcada como "difícil" por el usuario. LOCAL — nunca se exporta.
   */
  starred?: boolean;

  stats: QuestionStats;
  createdAt: string;
  updatedAt: string;
}

// ─── Question Images ──────────────────────────────────────────────────────────

/**
 * Registro de imagen de pregunta en IndexedDB.
 * Las imágenes se referencian en markdown como: ![alt](question-images/filename)
 */
export interface QuestionImageRecord {
  /** UUID (sin extensión) — clave primaria */
  id: string;
  /** "uuid.ext" — filename como aparece en la ruta question-images/ */
  filename: string;
  blob: Blob;
  mimeType: string;
  createdAt: string;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export type SessionMode = 'random' | 'all' | 'failed' | 'topic' | 'smart' | 'exam';

export interface UserAnswer {
  questionId: string;
  // TEST: selected option IDs
  selectedOptionIds?: string[];
  // DESARROLLO: free text
  freeText?: string;
  // COMPLETAR: map blank id -> answer text
  blankAnswers?: Record<string, string>;
  // Manual override for DESARROLLO
  manualResult?: 'CORRECT' | 'WRONG';
  // Auto-computed result (null for DESARROLLO before manual)
  result?: 'CORRECT' | 'WRONG' | null;
  answeredAt: string;
}

export interface PracticeSession {
  id: string;
  subjectId: string;
  /** When set, this is a multi-subject (global) session */
  subjectIds?: string[];
  mode: SessionMode;
  topicId?: string; // if mode === 'topic'
  createdAt: string;
  finishedAt?: string;
  questionIds: string[];
  answers: UserAnswer[];
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

export interface PdfResource {
  id: string;
  subjectId: string;
  filename: string;
  mime: string;
  blob: Blob;
  createdAt: string;
}

export interface PdfAnchor {
  id: string;
  subjectId: string;
  pdfId: string;
  page: number;
  bbox?: { x: number; y: number; w: number; h: number };
  label?: string;
}

// ─── ITER2: Recursos estáticos del repo ───────────────────────────────────────
//
// Los PDFs de temas se guardan en resources/[slug-asignatura]/Temas/*.pdf
// El JSON de info extra vive en resources/[slug-asignatura]/extra_info.json
// Esto permite commitearlos a GitHub y servirlos como assets estáticos.

export interface SubjectExtraInfo {
  /** Si la asignatura permite llevar apuntes/chuleta al examen. */
  allowsNotes?: boolean;
  /** Nombre del profesor/a. */
  professor?: string;
  /** Créditos ECTS de la asignatura. */
  credits?: number;
  /** Descripción libre. */
  description?: string;
  /**
   * Lista de nombres de archivo PDF disponibles en resources/[slug]/Temas/.
   * Ej: ["Tema1.pdf", "Tema2.pdf"]
   */
  pdfs?: string[];
  /** ITER3 — Enlaces externos útiles (webs de consulta, apps de ayuda). */
  externalLinks?: ExternalLink[];
  /** Enlaces a Custom GPTs para conversar sobre la asignatura. */
  gptLinks?: GptLink[];
}

// ─── ITER3: Enlaces externos útiles ──────────────────────────────────────────

export interface ExternalLink {
  name: string;
  url: string;
  icon?: string; // URL del favicon o emoji
}

// ─── GPT Links ───────────────────────────────────────────────────────────────

/**
 * Enlace a un Custom GPT de ChatGPT configurado para la asignatura.
 * Se define en extra_info.json de cada asignatura y se muestra como botón
 * en el header de SubjectView.
 */
export interface GptLink {
  /** Nombre visible del botón (ej: "Conversador TAA") */
  name: string;
  /** URL completa del Custom GPT */
  url: string;
  /** Descripción opcional (ej: "Basado en resúmenes Temas 1-11") */
  description?: string;
}

// ─── Exams (curated question sets) ────────────────────────────────────────────

/**
 * Examen personalizado: un conjunto ordenado de preguntas del banco.
 * El usuario selecciona preguntas y las ordena para practicar
 * como si fuera un examen real o un set de flashcards curado.
 */
export interface Exam {
  id: string;
  subjectId: string;
  /** Nombre visible del examen (ej: "Parcial Temas 1-5") */
  name: string;
  /** Descripción opcional */
  description?: string;
  /** IDs de preguntas en el orden deseado */
  questionIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ─── Export formats ───────────────────────────────────────────────────────────

export interface ExamExport {
  version: 1;
  kind: 'exams';
  exportedAt: string;
  exams: Exam[];
  /** Solo las preguntas referenciadas por los exámenes (para archivo autónomo). */
  questions: Question[];
}

export interface BankExport {
  version: 1;
  kind: 'bank';
  exportedAt: string;
  subjects: Subject[];
  topics: Topic[];
  questions: Question[];
  pdfAnchors: PdfAnchor[];
  /** Conceptos clave incluidos en el banco global (opcional para retrocompatibilidad). */
  keyConcepts?: KeyConcept[];
}

export interface ContributionQuestion {
  id: string;
  /**
   * Opcionales para "loose packs": packs creados para una asignatura sin temas.
   * Si se omiten, la pregunta solo puede importarse desde DENTRO de una
   * asignatura, y se asigna a esa asignatura (sin tema).
   */
  subjectKey?: string;
  topicKey?: string;
  topicKeys?: string[]; // ITER3 — temas adicionales
  type: QuestionType;
  prompt: string;
  options?: QuestionOption[];
  correctOptionIds?: string[];
  modelAnswer?: string;
  keywords?: string[];
  numericAnswer?: string; // ITER3 — resultado numérico (PRACTICO)
  clozeText?: string;
  blanks?: ClozeBlank[];
  explanation?: string;
  difficulty?: DifficultyLevel;
  tags?: string[];
  origin?: QuestionOrigin;
  pdfAnchor?: { page: number; label?: string };
  createdBy?: string;
  contentHash?: string;
  /** @deprecated — usar imágenes inline en markdown */
  imageDataUrls?: string[];
}

export interface ContributionTarget {
  subjectKey: string;
  subjectName: string;
  topics: { topicKey: string; topicTitle: string }[];
}

export interface ContributionPack {
  version: 1;
  kind: 'contribution';
  packId: string;
  createdBy: string;
  exportedAt: string;
  targets: ContributionTarget[];
  questions: ContributionQuestion[];
  /**
   * Imágenes inline referenciadas en el markdown de las preguntas.
   * Mapa de { "uuid.ext" → "base64" }.
   * Al importar, se guardan en IndexedDB y se intentan escribir en
   * public/question-images/ via dev server.
   */
  questionImages?: Record<string, string>;
}

/**
 * Registro de un contribution pack importado.
 * Se guarda en AppSettings.importHistory para permitir undo.
 */
export interface ImportHistoryEntry {
  packId: string;
  createdBy: string;
  importedAt: string;   // ISO timestamp
  questionCount: number;
  subjectNames: string[];
}

// ─── Packages & Marketplace ───────────────────────────────────────────────

/**
 * Manifiesto de un paquete de asignatura (.examcoach.zip).
 * Absorbe lo que antes era extra_info.json + metadatos de distribución.
 */
export interface PackageManifest {
  formatVersion: 1;
  /** Slug único del paquete (e.g. "ingenieria-del-software") */
  id: string;
  /** Nombre visible */
  name: string;
  /** Versión semántica del paquete */
  version: string;
  description?: string;
  authors?: string[];
  university?: string;
  degree?: string;
  year?: string;
  credits?: number;
  professor?: string;
  allowsNotes?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Estadísticas para mostrar en el marketplace sin descomprimir el banco */
  stats: {
    questions: number;
    topics: number;
    exams: number;
    keyConcepts: number;
  };
  /** Versión mínima de la app requerida */
  minAppVersion?: string;
  gptLinks?: GptLink[];
  externalLinks?: ExternalLink[];
}

/**
 * Banco de preguntas de una asignatura dentro de un paquete.
 * Independiente y autocontenido.
 */
export interface SubjectBank {
  formatVersion: 1;
  /** Slug del paquete al que pertenece */
  subject: string;
  topics: Topic[];
  questions: Question[];
  keyConcepts?: KeyConcept[];
  exams?: Exam[];
  pdfAnchors?: PdfAnchor[];
}

/**
 * Registro de un paquete instalado en la app.
 * Se almacena en IndexedDB para tracking de versiones y actualizaciones.
 */
export interface InstalledPackage {
  /** Slug del paquete (= manifest.id) */
  id: string;
  /** ID local de la asignatura creada al instalar */
  subjectId: string;
  /** Versión instalada */
  version: string;
  /** Nombre visible */
  name: string;
  /** ISO timestamp de la instalación */
  installedAt: string;
  /** Manifest completo (para comparar con el registry) */
  manifest: PackageManifest;
}

/**
 * Entrada del catálogo remoto (parseada de GitHub Releases).
 */
export interface RegistryEntry {
  /** Slug del paquete */
  id: string;
  /** Manifest completo del paquete */
  manifest: PackageManifest;
  /** URL de descarga del ZIP (GitHub Release asset) */
  downloadUrl: string;
  /** Tamaño del archivo en bytes */
  size?: number;
  /** Fecha de publicación del release */
  publishedAt: string;
  /** Si el archivo está cifrado con AES-256-GCM */
  encrypted?: boolean;
}

// ─── AI Settings ──────────────────────────────────────────────────────────────

/** 'hoard' = local models through Hypatia's Hoard (OpenAI-compatible proxy); hoard mode only. */
export type AIProviderType = 'openai' | 'anthropic' | 'webllm' | 'hoard';

export interface AISettings {
  provider: AIProviderType;
  openaiApiKey?: string;
  openaiModel?: string;       // gpt-4o, gpt-4o-mini, etc.
  anthropicApiKey?: string;
  anthropicModel?: string;    // claude-sonnet-4-5-20250929, etc.
  webllmModel?: string;       // Llama-3.1-8B-Instruct-q4f16_1-MLC, etc.
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  alias: string;
  importedPackIds: string[];
  /**
   * ISO timestamp de la última vez que se sincronizó con el banco global.
   */
  globalBankSyncedAt?: string;
  /**
   * Historial de contribution packs importados.
   * Permite hacer undo de un import concreto eliminando sus preguntas.
   */
  importHistory?: ImportHistoryEntry[];
  /**
   * Configuración del motor de IA para extracción de preguntas.
   * API keys se almacenan solo en IndexedDB local.
   */
  aiSettings?: AISettings;
  /**
   * Token personal de GitHub para exportar contribution packs a Gists y sync.
   * Se almacena solo en IndexedDB local, nunca se exporta.
   * Scope mínimo requerido: gist (create/read gists).
   */
  githubToken?: string;
  /** Contraseñas por paquete del marketplace { packageId: password } */
  marketplacePasswords?: Record<string, string>;
  /**
   * ID del Gist privado usado para sincronización entre dispositivos.
   * Se crea automáticamente en el primer push y se reutiliza.
   * LOCAL — nunca se exporta (cada dispositivo lo configura).
   */
  syncGistId?: string;
  /**
   * ISO timestamp del último sync exitoso con el Gist.
   * Se usa para saber si hay cambios remotos pendientes (como git fetch).
   */
  lastSyncAt?: string;
  /**
   * Contador de días consecutivos con actividad de estudio.
   * Se actualiza cuando el usuario completa una sesión de práctica.
   */
  studyStreak?: number;
  /**
   * Fecha ISO (YYYY-MM-DD) del último día con actividad de estudio.
   */
  lastStudyDate?: string;
  /**
   * Objetivos de % de acierto por asignatura. subjectId → porcentaje objetivo (0-100).
   * LOCAL — nunca se exporta.
   */
  subjectGoals?: Record<string, number>;
  /**
   * Flag que indica que la migración de asignaturas huérfanas (pre-marketplace)
   * ya se ejecutó. Evita re-ejecutar la migración en cada arranque.
   */
  orphanMigrationDone?: boolean;
}

// ─── Deliverables & Grading (LOCAL — never exported to global bank) ───────────

export type DeliverableType = 'activity' | 'test' | 'exam' | 'otro';

export type DeliverableStatus = 'pending' | 'in_progress' | 'done' | 'submitted';

/** Helper: true si el estado cuenta como "completado" a efectos de nota continua. */
export function isDeliverableCompleted(status: DeliverableStatus): boolean {
  return status === 'done' || status === 'submitted';
}

/**
 * A course deliverable: an activity (graded) or a test (binary done/not-done).
 * - activity: graded 0-10, contributes `continuousPoints` proportionally
 *   contribution = (grade / 10) * continuousPoints
 * - test: binary, contributes `continuousPoints` flat when completed
 */
export interface Deliverable {
  id: string;
  subjectId: string;
  name: string;
  type: DeliverableType;
  startDate?: string;   // ISO YYYY-MM-DD
  dueDate?: string;     // ISO YYYY-MM-DD
  dueTime?: string;     // HH:MM hora local (opcional)
  /** Estado del deliverable. Reemplaza el anterior `completed: boolean`. */
  status: DeliverableStatus;
  /** 0-10 grade received. Activities only. */
  grade?: number;
  /** Max continuous raw points this deliverable contributes. */
  continuousPoints: number;
  createdAt: string;
  updatedAt: string;
}


/**
 * Per-subject grading configuration. LOCAL data only.
 * id === subjectId for easy lookup.
 */
export interface SubjectGradingConfig {
  /** Same as subjectId — used as primary key. */
  id: string;
  /** Weight of continuous eval in final grade. e.g. 0.4 = 40% */
  continuousWeight: number;
  /** Cap for continuous raw score. e.g. 10 */
  maxContinuousPoints: number;
  /** Default continuousPoints for new test deliverables. e.g. 0.1 */
  testContinuousPoints: number;
  /** Exam grade (0-10) once taken. */
  examGrade?: number;
}