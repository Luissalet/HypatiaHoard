/**
 * hoard-copilot-state.ts
 *
 * What the pages tell the Faustus copilot that the route does not say: the active tab, the topic filter, the question
 * being answered and the unsaved input of an open form. Tiny on purpose: pages import it, nothing else.
 */
import { emptyState, setEditor, type CopilotState, type Editor } from './hoard-copilot-core';

export const copilotState: CopilotState = emptyState();

export function reportView(patch: Partial<Omit<CopilotState, 'editors' | 'editorOrder'>>): void {
  Object.assign(copilotState, patch);
}

/** A form reports its unsaved input (null when it closes). */
export function reportEditor(kind: string, editor: Editor | null): void {
  setEditor(copilotState, kind, editor);
}
