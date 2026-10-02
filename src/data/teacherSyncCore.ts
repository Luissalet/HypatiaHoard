/**
 * teacherSyncCore.ts — reglas puras de la sincronización de los datos del Profesor
 * con el servidor local (sin Dexie, sin fetch: se prueban con node).
 *
 * Por qué no va por hoardSync: aquella sincronización empuja la copia completa que
 * también usa el Gist; los datos de alumnos no pueden entrar ahí. Esta usa
 * /api/teacher/sync/* con «gana la última escritura» por registro (`updatedAt`) y
 * una cola local de cambios y borrados pendientes.
 */

import type { TeacherKind } from '@/domain/teacher';

export const TEACHER_KIND_TABLE: Record<TeacherKind, string> = {
  class: 'teacherClasses',
  student: 'teacherStudents',
  teacherExam: 'teacherExams',
  rubric: 'rubrics',
  gradingBatch: 'gradingBatches',
  submission: 'submissions',
  proposal: 'gradingProposals',
  teacherSettings: 'teacherSettings',
};

export const TEACHER_PENDING_KEY = 'hypatia-teacher-pending';
export const TEACHER_DELETES_KEY = 'hypatia-teacher-deletes';
export const TEACHER_REV_KEY = 'hypatia-teacher-rev';

export function isTeacherKind(k: unknown): k is TeacherKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TEACHER_KIND_TABLE, k);
}

export const pendingKey = (kind: TeacherKind, id: string) => `${kind}:${id}`;

export function parsePendingKey(key: string): { kind: TeacherKind; id: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  return isTeacherKind(kind) ? { kind, id: key.slice(i + 1) } : null;
}

export function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface TeacherDelete { kind: TeacherKind; id: string; deletedAt: string }

export function parseDeletes(raw: string | null): TeacherDelete[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((d) => d && isTeacherKind(d.kind) && typeof d.id === 'string')
      .map((d) => ({ kind: d.kind, id: d.id, deletedAt: String(d.deletedAt ?? new Date(0).toISOString()) }));
  } catch {
    return [];
  }
}

export function addDelete(queue: TeacherDelete[], entry: TeacherDelete): TeacherDelete[] {
  return [...queue.filter((d) => !(d.kind === entry.kind && d.id === entry.id)), entry];
}

/** Registro tal como viaja por /api/teacher/sync. */
export interface WireRecord {
  kind: TeacherKind;
  id: string;
  updatedAt: string;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

export type RemoteDecision = 'apply' | 'delete' | 'keep' | 'skip';

/**
 * Qué hacer con un registro que llega del servidor.
 * - borrado remoto: borra la copia local salvo que haya un cambio local pendiente más nuevo;
 * - cambio remoto: se aplica si no hay copia local o si es igual o más nuevo; se conserva
 *   la copia local cuando tiene un cambio pendiente más reciente (se subirá).
 */
export function decideRemote(
  local: { updatedAt?: string } | undefined | null, remote: { updatedAt: string; deleted: boolean },
  localPending: boolean,
): RemoteDecision {
  const localAt = local?.updatedAt ?? '';
  if (remote.deleted) {
    if (!local) return 'skip';
    if (localPending && localAt > remote.updatedAt) return 'keep';
    return 'delete';
  }
  if (!local) return 'apply';
  if (localPending && localAt > remote.updatedAt) return 'keep';
  return remote.updatedAt >= localAt ? 'apply' : 'keep';
}

/**
 * Pendientes que siguen pendientes tras un push: los que cambiaron mientras se
 * subían (otro `updatedAt`) y no son «stale» (el servidor tenía algo más nuevo:
 * gana el servidor y el pull lo trae).
 */
export function remainingPending(
  pending: string[], sent: Record<string, string>, current: Record<string, string | undefined>,
  stale: { kind: string; id: string }[],
): string[] {
  const staleKeys = new Set(stale.map((s) => `${s.kind}:${s.id}`));
  return pending.filter((key) => {
    if (staleKeys.has(key)) return false;
    if (!(key in sent)) return true;
    return current[key] !== undefined && current[key] !== sent[key];
  });
}
