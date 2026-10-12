import { useEffect } from 'react';

/** A live form snapshot; chat and draft storage still belong to Faustus. */
export function useCopilotDraft(kind: string, id: string | undefined, draft: object, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const provide = (event: Event) => {
      (event as CustomEvent).detail.provide({ kind, object_id: id || null, draft });
    };
    window.addEventListener('hypatia:context-request', provide);
    return () => window.removeEventListener('hypatia:context-request', provide);
  }, [kind, id, draft, enabled]);
}
