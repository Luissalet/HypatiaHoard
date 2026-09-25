/**
 * NotebookContext.tsx
 *
 * Shared state for the Cuaderno (notebook) page: subject ids (local and
 * server), topics, server capabilities, locally stored PDFs and the handlers
 * that open a citation popover or a PDF at a page.
 */

import { createContext, useContext } from 'react';
import type { Topic } from '@/domain/models';
import type { Citation, HoardCapabilities } from '@/data/hoardClient';
import { NO_CAPABILITIES } from '@/data/hoardClient';

export interface NotebookContextValue {
  /** Subject id in this browser's IndexedDB. */
  subjectId: string;
  /** Subject id on the Hypatia server (differs only if the server deduped it). */
  serverSubjectId: string;
  subjectName: string;
  topics: Topic[];
  caps: HoardCapabilities;
  /** Server id for a local topic id. */
  serverTopicId: (localTopicId: string) => string;
  /** Stored filename of a local PDF matching a citation filename, or null. */
  findLocalPdf: (filename?: string) => string | null;
  openPdf: (storedFilename: string, page?: number) => void;
  showCitation: (citation: Citation, anchor: DOMRect) => void;
}

export const NotebookContext = createContext<NotebookContextValue>({
  subjectId: '',
  serverSubjectId: '',
  subjectName: '',
  topics: [],
  caps: NO_CAPABILITIES,
  serverTopicId: (id) => id,
  findLocalPdf: () => null,
  openPdf: () => {},
  showCitation: () => {},
});

export function useNotebook(): NotebookContextValue {
  return useContext(NotebookContext);
}
