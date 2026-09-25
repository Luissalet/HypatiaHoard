/**
 * Notebook.tsx — "Cuaderno" (hoard mode only)
 *
 * Source notebook for one subject, backed by the local
 * Hypatia's Hoard server: Fuentes (sources), Chat (grounded Q&A with
 * citations), Estudio (generated guides, mind map, audio) and Tutor.
 * Route: /subject/:subjectId/notebook (registered only in the hoard build).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Tabs, EmptyState, Button } from '@/ui/components';
import { subjectRepo, topicRepo } from '@/data/repos';
import { listStoredPdfs } from '@/data/pdfStorage';
import { useHoardDetection, isHoardMode } from '@/data/hoardMode';
import { getCapabilities, NO_CAPABILITIES, type Citation, type HoardCapabilities, type NotebookSource } from '@/data/hoardClient';
import { serverIdFor } from '@/data/hoardSync';
import { basename } from '@/data/hoardSyncCore';
import type { Subject, Topic } from '@/domain/models';
import { NotebookContext, type NotebookContextValue } from '@/ui/components/notebook/NotebookContext';
import { CitationPopover } from '@/ui/components/notebook/CitationChip';
import { PdfPageModal } from '@/ui/components/notebook/PdfPageModal';
import { SourcesPanel } from '@/ui/components/notebook/SourcesPanel';
import { ChatPanel } from '@/ui/components/notebook/ChatPanel';
import { StudioPanel } from '@/ui/components/notebook/StudioPanel';

type TabId = 'sources' | 'chat' | 'studio' | 'tutor';
const TAB_IDS: TabId[] = ['sources', 'chat', 'studio', 'tutor'];

export function NotebookPage() {
  const { subjectId = '' } = useParams<{ subjectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const detection = useHoardDetection();

  const initialTab = searchParams.get('tab') as TabId | null;
  const [tab, setTabState] = useState<TabId>(initialTab && TAB_IDS.includes(initialTab) ? initialTab : 'chat');
  const setTab = (id: TabId) => {
    setTabState(id);
    setSearchParams(id === 'chat' ? {} : { tab: id }, { replace: true });
  };

  const [subject, setSubject] = useState<Subject | null | undefined>(undefined);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [caps, setCaps] = useState<HoardCapabilities>(NO_CAPABILITIES);
  const [localPdfs, setLocalPdfs] = useState<string[]>([]);
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [popover, setPopover] = useState<{ citation: Citation; anchor: DOMRect } | null>(null);
  const [pdf, setPdf] = useState<{ filename: string; page: number } | null>(null);

  const active = detection === 'on' && isHoardMode();

  // Subject + topics (IndexedDB), capabilities and local PDFs
  useEffect(() => {
    if (!active || !subjectId) return;
    let cancelled = false;
    const load = async () => {
      const [s, t, pdfs] = await Promise.all([
        subjectRepo.getById(subjectId),
        topicRepo.getBySubject(subjectId),
        listStoredPdfs(subjectId).catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      setSubject(s ?? null);
      setTopics(t);
      setLocalPdfs(pdfs);
    };
    void load();
    getCapabilities(true).then((c) => { if (!cancelled) setCaps(c); });
    // Topics/subjects may arrive from a sync while the page is open
    const onSynced = () => { void load(); };
    window.addEventListener('hypatia-synced', onSynced);
    return () => {
      cancelled = true;
      window.removeEventListener('hypatia-synced', onSynced);
    };
  }, [active, subjectId]);

  const pdfIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const name of localPdfs) m.set(basename(name).toLowerCase(), name);
    return m;
  }, [localPdfs]);

  const findLocalPdf = useCallback((filename?: string) => {
    if (!filename) return null;
    return pdfIndex.get(basename(filename).toLowerCase()) ?? null;
  }, [pdfIndex]);

  const ctx: NotebookContextValue = useMemo(() => ({
    subjectId,
    serverSubjectId: active ? serverIdFor('subject', subjectId) : subjectId,
    subjectName: subject?.name ?? '',
    topics,
    caps,
    serverTopicId: (id: string) => serverIdFor('topic', id),
    findLocalPdf,
    openPdf: (filename: string, page = 1) => setPdf({ filename, page }),
    showCitation: (citation: Citation, anchor: DOMRect) => setPopover({ citation, anchor }),
  }), [subjectId, active, subject?.name, topics, caps, findLocalPdf]);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (detection === 'pending') {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-sm text-ink-500">Conectando con Hypatia…</p>
      </div>
    );
  }
  if (!active) {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-100 flex items-center justify-center px-4">
        <EmptyState
          title="Cuaderno no disponible"
          description="El cuaderno necesita el servidor de Hypatia's Hoard en tu PC (python -m hypatia)."
          action={<Button variant="secondary" onClick={() => navigate(`/subject/${subjectId}`)}>Volver a la asignatura</Button>}
        />
      </div>
    );
  }
  if (subject === null) {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-100 flex items-center justify-center px-4">
        <EmptyState
          title="Asignatura no encontrada"
          action={<Button variant="secondary" onClick={() => navigate('/')}>Ir al inicio</Button>}
        />
      </div>
    );
  }

  const indexed = sources.filter((s) => s.status === 'indexed').length;
  const tabs = [
    { id: 'sources', label: sources.length ? `Fuentes · ${indexed}` : 'Fuentes' },
    { id: 'chat', label: 'Chat' },
    { id: 'studio', label: 'Estudio' },
    { id: 'tutor', label: 'Tutor' },
  ];

  return (
    <NotebookContext.Provider value={ctx}>
      <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
        <header className="border-b border-ink-800 bg-ink-900/50 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
            <div className="flex items-center justify-between gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                <button
                  onClick={() => navigate(`/subject/${subjectId}`)}
                  className="text-ink-400 hover:text-ink-200 transition-colors text-sm flex-shrink-0"
                  title="Volver a la asignatura"
                >
                  ←
                </button>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: subject?.color ?? '#f59e0b' }} />
                <div className="min-w-0">
                  <h1 className="font-display text-lg sm:text-xl text-ink-100 truncate">{subject?.name ?? '…'}</h1>
                  <p className="text-[11px] text-ink-500 -mt-0.5">Cuaderno · Hypatia</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0 text-[11px] text-ink-500" title="Capacidades del servidor local">
                <CapDot on={caps.llm} label="Texto" />
                <CapDot on={caps.embeddings} label="Búsqueda semántica" short="Vectores" />
                <CapDot on={caps.tts} label="Voz" />
              </div>
            </div>
            <div className="mt-3">
              <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
            </div>
          </div>
        </header>

        <main className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-4 sm:px-6 py-4 sm:py-6 gap-4">
          {/* Sources stays mounted so its indexing poll and counter keep working */}
          <div className={tab === 'sources' ? '' : 'hidden'}>
            <SourcesPanel onSources={setSources} />
          </div>
          {tab === 'chat' && <ChatPanel key="chat" mode="sources" />}
          {tab === 'studio' && <StudioPanel />}
          {tab === 'tutor' && <ChatPanel key="tutor" mode="tutor" />}
        </main>

        {popover && (
          <CitationPopover citation={popover.citation} anchor={popover.anchor} onClose={() => setPopover(null)} />
        )}
        <PdfPageModal
          subjectId={subjectId}
          filename={pdf?.filename ?? null}
          page={pdf?.page ?? 1}
          onClose={() => setPdf(null)}
        />
      </div>
    </NotebookContext.Provider>
  );
}

function CapDot({ on, label, short }: { on: boolean; label: string; short?: string }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${label}: ${on ? 'disponible' : 'no disponible'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-sage-500' : 'bg-ink-600'}`} />
      <span className="hidden sm:inline">{short ?? label}</span>
    </span>
  );
}
