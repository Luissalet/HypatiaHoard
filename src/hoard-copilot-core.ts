/**
 * hoard-copilot-core.ts
 *
 * What the Faustus copilot panel (the launcher the server injects) asks this app for: the real objects open in the
 * view. Pure (no Dexie, no DOM): the real reads are passed in as `Deps`, so the node tests run it without a browser.
 * Ids are the ones Faustus' tools use (the server's), with `local_id` beside them when this browser's differ.
 * It never throws: an unknown id, a "new" view or a failing read gives no object.
 */

export interface Editor {
  dirty: boolean;
  fields: Record<string, unknown>;
}

export interface CopilotState {
  /** Tab of the subject page (not in the URL). */
  subjectTab?: string;
  /** Topic the subject page filters questions by. */
  filterTopicId?: string;
  /** Question being answered in a practice session. */
  questionId?: string | null;
  /** Whether that question was already answered. */
  submitted?: boolean;
  /** Open forms (unsaved input), by kind; the last one reported wins. */
  editors: Record<string, Editor>;
  editorOrder: string[];
}

export function emptyState(): CopilotState {
  return { editors: {}, editorOrder: [] };
}

export function setEditor(state: CopilotState, kind: string, editor: Editor | null): void {
  state.editorOrder = state.editorOrder.filter((k) => k !== kind);
  if (editor) {
    state.editors[kind] = editor;
    state.editorOrder.push(kind);
  } else {
    delete state.editors[kind];
  }
}

export interface Route {
  page: string;
  subjectId?: string;
  topicId?: string;
  sessionId?: string;
  examId?: string;
  batchId?: string;
  tab?: string;
}

/** The HashRouter location (`#/subject/abc/notebook?tab=studio`) as a page plus the ids in it. */
export function parseRoute(hash: string): Route {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const tab = new URLSearchParams(query).get('tab') ?? undefined;
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [a, b, c, d] = parts;
  if (!a) return { page: 'dashboard' };
  if (a === 'subject' && b) {
    if (!c) return { page: 'subject', subjectId: b, tab };
    if (c === 'stats') return { page: 'subject-stats', subjectId: b };
    if (c === 'notebook') return { page: 'notebook', subjectId: b, tab: tab ?? 'chat' };
    if (c === 'read' && d) return { page: 'read', subjectId: b, topicId: d };
    if (c === 'listen' && d) return { page: 'listen', subjectId: b, topicId: d };
    if (c === 'listen-resource') return { page: 'listen-resource', subjectId: b };
  }
  if (a === 'practice' && b) return { page: 'practice', sessionId: b };
  if (a === 'results' && b) return { page: 'results', sessionId: b };
  if (a === 'flashcard' && b) return { page: 'flashcards', subjectId: b };
  if (a === 'teacher') {
    if (b === 'exam' && c) return { page: 'teacher-exam', examId: c };
    if (b === 'batch' && c) return { page: 'teacher-batch', batchId: c };
    return { page: 'teacher', tab: tab ?? 'clases' };
  }
  const simple: Record<string, string> = {
    marketplace: 'marketplace',
    'pdf-tools': 'pdf-tools',
    'global-practice': 'global-practice',
    settings: 'settings',
    deliverables: 'deliverables',
    sessions: 'sessions',
    stats: 'stats',
  };
  return { page: simple[a] ?? 'dashboard' };
}

type Id = string;
interface SubjectLike { id: Id; name: string; examDate?: string }
interface TopicLike { id: Id; subjectId: Id; title: string }
interface QuestionLike { id: Id; subjectId?: Id; type?: string; prompt?: string; topicId?: Id }
interface SessionLike { id: Id; subjectId: Id; mode?: string; questionIds: Id[]; answers: unknown[]; finishedAt?: string; topicId?: Id }
interface ExamLike { id: Id; subjectId?: Id; title: string; status?: string; items?: unknown[]; versions?: unknown[] }
interface BatchLike { id: Id; examId?: Id; title: string; status?: string }
interface SourceLike { id: Id; filename: string; title?: string; status?: string; pages?: number }

export interface Deps {
  subject(id: Id): Promise<SubjectLike | undefined>;
  subjects(): Promise<SubjectLike[]>;
  topic(id: Id): Promise<TopicLike | undefined>;
  topics(subjectId: Id): Promise<TopicLike[]>;
  questionCount(subjectId: Id): Promise<number>;
  question(id: Id): Promise<QuestionLike | undefined>;
  session(id: Id): Promise<SessionLike | undefined>;
  teacherExam(id: Id): Promise<ExamLike | undefined>;
  batch(id: Id): Promise<BatchLike | undefined>;
  sources(serverSubjectId: Id): Promise<SourceLike[]>;
  /** The id Faustus' tools know this record by. */
  serverId(kind: string, localId: Id): Promise<Id>;
}

type Obj = Record<string, unknown>;

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

const clip = (text: unknown, n = 200) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function ref(deps: Deps, kind: string, kindName: string, localId: Id, title: string, extra: Obj = {}): Promise<Obj> {
  const serverId = (await safe(() => deps.serverId(kind, localId))) || localId;
  const out: Obj = { kind: kindName, object_id: serverId, title: clip(title), ...extra };
  if (serverId !== localId) out.local_id = localId;
  return out;
}

export async function buildContext(route: Route, state: CopilotState, deps: Deps) {
  const out: { project?: Obj; active_objects: Obj[]; view: Obj } = {
    active_objects: [],
    view: { page: route.page },
  };
  let subjectId = route.subjectId;
  let session: SessionLike | undefined;
  if (route.sessionId) {
    session = await safe(() => deps.session(route.sessionId!));
    if (session) subjectId = session.subjectId;
  }

  if (route.page === 'dashboard') {
    const all = (await safe(() => deps.subjects())) ?? [];
    out.view.subjects = await Promise.all(
      all.slice(0, 40).map(async (s) => ({
        id: (await safe(() => deps.serverId('subject', s.id))) || s.id,
        name: clip(s.name, 80),
        ...(s.examDate ? { exam_date: s.examDate } : {}),
      })),
    );
  }

  let subjectRef: Obj | undefined;
  if (subjectId) {
    const subject = await safe(() => deps.subject(subjectId!));
    if (subject) {
      const [topics, questions] = await Promise.all([
        safe(() => deps.topics(subject.id)),
        safe(() => deps.questionCount(subject.id)),
      ]);
      subjectRef = await ref(deps, 'subject', 'subject', subject.id, subject.name, {
        ...(subject.examDate ? { exam_date: subject.examDate } : {}),
        topics: topics?.length ?? 0,
        questions: questions ?? 0,
      });
      out.project = { external_project_id: subjectRef.object_id, title: clip(subject.name), kind: 'subject' };
      out.active_objects.push(subjectRef);
      const topicId = route.topicId ?? (state.filterTopicId && state.filterTopicId !== '__none__' ? state.filterTopicId : undefined);
      if (topicId) {
        const topic = (topics ?? []).find((t) => t.id === topicId) ?? (await safe(() => deps.topic(topicId)));
        if (topic) out.active_objects.push(await ref(deps, 'topic', 'topic', topic.id, topic.title));
      }
      if (route.page === 'notebook') {
        const sources = (await safe(() => deps.sources(String(subjectRef!.object_id)))) ?? [];
        for (const s of sources.slice(0, 20))
          out.active_objects.push({
            kind: 'source',
            object_id: s.id,
            title: clip(s.title || s.filename),
            ...(s.status ? { status: s.status } : {}),
            ...(s.pages ? { pages: s.pages } : {}),
          });
      }
    }
  }

  if (session && subjectRef) {
    out.active_objects.push(
      await ref(deps, 'session', 'session', session.id, `${session.mode ?? 'practice'} session`, {
        mode: session.mode,
        questions: session.questionIds.length,
        answered: session.answers.length,
        finished: !!session.finishedAt,
      }),
    );
  }
  if (route.page === 'practice' && session && state.questionId) {
    const question = await safe(() => deps.question(state.questionId!));
    if (question) {
      out.active_objects.push(
        await ref(deps, 'question', 'question', question.id, question.prompt ?? '', {
          type: question.type,
          answered: !!state.submitted,
        }),
      );
    }
  }

  if (route.page === 'teacher-exam' && route.examId) {
    const exam = await safe(() => deps.teacherExam(route.examId!));
    if (exam)
      out.active_objects.push(
        await ref(deps, 'teacherExam', 'teacher_exam', exam.id, exam.title, {
          status: exam.status,
          items: exam.items?.length ?? 0,
          versions: exam.versions?.length ?? 0,
        }),
      );
  }
  if (route.page === 'teacher-batch' && route.batchId) {
    // Titles and ids only: no student names or answers go to the context.
    const batch = await safe(() => deps.batch(route.batchId!));
    if (batch) {
      out.active_objects.push(
        await ref(deps, 'gradingBatch', 'grading_batch', batch.id, batch.title, {
          status: batch.status,
          exam_id: batch.examId,
        }),
      );
    }
  }

  const tab = route.page === 'subject' ? (state.subjectTab ?? route.tab) : route.tab;
  if (tab) out.view.tab = tab;
  if (state.editorOrder.length) {
    const kind = state.editorOrder[state.editorOrder.length - 1];
    const editor = state.editors[kind];
    if (editor) out.view.editor = { kind, dirty: editor.dirty, fields: editor.fields };
  }
  return out;
}
