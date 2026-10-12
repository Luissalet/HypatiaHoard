/**
 * hoard-copilot.ts
 *
 * The Faustus copilot in the PWA (hoard build only). The server injects the launcher into the HTML it serves, but the
 * service worker answers navigations from its precached index.html, so the page adds the launcher tag itself. This
 * module answers `window.hoardCopilot.context()` with the real objects open in the view (read from this browser's
 * IndexedDB, with the ids Faustus' tools use) and syncs after an agent turn so its changes show up.
 */
import { subjectRepo, topicRepo, questionRepo, sessionRepo } from '@/data/repos';
import { teacherExamRepo, batchRepo } from '@/data/teacherRepo';
import { isRecordKind } from '@/data/hoardSyncCore';
import { buildContext, parseRoute, type Deps } from './hoard-copilot-core';
import { copilotState as state } from './hoard-copilot-state';

const deps: Deps = {
  subject: (id) => subjectRepo.getById(id),
  subjects: () => subjectRepo.getAll(),
  topic: (id) => topicRepo.getById(id),
  topics: (subjectId) => topicRepo.getBySubject(subjectId),
  questionCount: async (subjectId) => (await questionRepo.getBySubject(subjectId)).length,
  question: (id) => questionRepo.getById(id),
  session: (id) => sessionRepo.getById(id),
  teacherExam: async (id) => {
    const exam = await teacherExamRepo.get(id);
    return exam && { id: exam.id, subjectId: exam.subjectId, title: exam.title, status: exam.status, items: exam.items, versions: exam.versions };
  },
  batch: (id) => batchRepo.get(id),
  sources: async (serverSubjectId) => {
    const { isHoardMode } = await import('@/data/hoardMode');
    if (!isHoardMode()) return [];
    const { listSources } = await import('@/data/hoardClient');
    return listSources(serverSubjectId);
  },
  serverId: async (kind, localId) => {
    if (!isRecordKind(kind)) return localId;
    const { serverIdFor } = await import('@/data/hoardSync');
    return serverIdFor(kind, localId);
  },
};

/** The page adds the launcher itself (idempotent: the launcher guards against a second copy). */
function addLauncher(): void {
  if (document.querySelector('script[src="/api/copilot/launcher.js"]')) return;
  const tag = document.createElement('script');
  tag.type = 'module';
  tag.src = '/api/copilot/launcher.js';
  document.body.appendChild(tag);
}

export function installHoardCopilot(): void {
  if (typeof window === 'undefined' || import.meta.env.VITE_HOARD !== '1') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  (window as unknown as { hoardCopilot: unknown }).hoardCopilot = {
    async context() {
      try {
        return await buildContext(parseRoute(location.hash), state, deps);
      } catch {
        return { active_objects: [] };
      }
    },
    onTurnEnd() {
      // An agent changed data through the tools: pull it now instead of waiting for the next poll.
      clearTimeout(timer);
      timer = setTimeout(() => {
        void import('@/data/hoardSync').then((m) => m.syncNow()).catch(() => {});
        void import('@/data/teacherSync').then((m) => m.teacherSyncNow()).catch(() => {});
      }, 400);
    },
  };
  // Changing route changes the conversation (one per subject): tell the launcher.
  window.addEventListener('hashchange', () => window.dispatchEvent(new Event('hoard:copilot-context-changed')));
  if (document.body) addLauncher();
  else window.addEventListener('DOMContentLoaded', addLauncher, { once: true });
}
