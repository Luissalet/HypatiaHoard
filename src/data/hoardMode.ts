/**
 * hoardMode.ts
 *
 * Single switch for "hoard mode": the PWA is being served by the local
 * Hypatia's Hoard server (python -m hypatia) and may talk to its /api.
 *
 * Hoard mode is on only when BOTH hold:
 *   1. the bundle was built with VITE_HOARD=1 (npm run build:hoard), and
 *   2. GET /api/health answered { service: 'hypatia-hoard' } (see hoardClient.detectHoard).
 *
 * The public build (GitHub Pages) never flips the switch: every hoard-only
 * feature (sync, notebook, AI proxy, UI) must be guarded by isHoardMode().
 * This module has no dependencies so the public bundle pays nothing for it.
 */

import { useSyncExternalStore } from 'react';

/** True only in bundles built for the local server (VITE_HOARD=1). */
export const HOARD_BUILD: boolean = import.meta.env.VITE_HOARD === '1';

/** 'pending' while the health check runs; always 'off' in the public build. */
export type HoardDetection = 'off' | 'pending' | 'on';

let detection: HoardDetection = HOARD_BUILD ? 'pending' : 'off';
const listeners = new Set<() => void>();

/** The one guard for every hoard-only code path. */
export function isHoardMode(): boolean {
  return HOARD_BUILD && detection === 'on';
}

export function getHoardDetection(): HoardDetection {
  return detection;
}

/** Internal: set by detectHoard(). Ignored in the public build. */
export function setHoardDetection(next: HoardDetection): void {
  const value: HoardDetection = HOARD_BUILD ? next : 'off';
  if (value === detection) return;
  detection = value;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook: re-renders when detection finishes. */
export function useHoardDetection(): HoardDetection {
  return useSyncExternalStore(subscribe, getHoardDetection, getHoardDetection);
}

/** React hook: true when hoard mode is active (same rule as isHoardMode()). */
export function useHoardMode(): boolean {
  return useHoardDetection() === 'on' && HOARD_BUILD;
}
