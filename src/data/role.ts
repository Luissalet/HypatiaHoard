/**
 * role.ts — rol de la app en este dispositivo: Estudiante (por defecto) o Profesor.
 * El modo Profesor añade pantallas y herramientas; no quita nada (un profesor puede
 * seguir practicando). Se guarda en localStorage: es una preferencia de este equipo.
 */

import { useSyncExternalStore } from 'react';
import type { Role } from '@/domain/teacher';

const KEY = 'hypatia-role';
const listeners = new Set<() => void>();

function read(): Role {
  try { return localStorage.getItem(KEY) === 'teacher' ? 'teacher' : 'student'; } catch { return 'student'; }
}

let role: Role = read();

export function getRole(): Role { return role; }

export function setRole(next: Role): void {
  role = next;
  try { localStorage.setItem(KEY, next); } catch { /* modo privado */ }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { role = read(); fn(); } };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage); };
}

export function useRole(): Role {
  return useSyncExternalStore(subscribe, getRole, getRole);
}
