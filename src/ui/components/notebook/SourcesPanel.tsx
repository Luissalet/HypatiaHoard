/**
 * SourcesPanel.tsx
 *
 * "Fuentes" tab: the notebook's indexed sources for this subject, upload from
 * the device, sync of the subject's PDFs stored in this browser (only the ones
 * the server lacks, by filename + size) and rescan of the repo resources.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Badge, EmptyState } from '@/ui/components';
import { listSources, uploadSource, rescanSources, deleteSource, type NotebookSource } from '@/data/hoardClient';
import { uploadMissingPdfs, type PdfUploadProgress } from '@/data/hoardSync';
import { useNotebook } from './NotebookContext';

const ORIGIN_LABEL: Record<string, string> = {
  repo: 'Repositorio',
  resources: 'Repositorio',
  upload: 'Subido',
  path: 'Carpeta local',
  local: 'Carpeta local',
  studio: 'Estudio',
};

const ACCEPT = '.pdf,.md,.markdown,.txt,.docx';
const MAX_BYTES = 50 * 1024 * 1024;

/** Subjects whose stored PDFs were already offered to the server this session. */
const autoSynced = new Set<string>();

function formatBytes(n?: number): string {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ s }: { s: NotebookSource }) {
  if (s.status === 'indexed') return <Badge color="sage">Indexada</Badge>;
  if (s.status === 'error') return <Badge color="rose">Error</Badge>;
  return <Badge color="amber">Indexando…</Badge>;
}

interface SourcesPanelProps {
  /** Called when the source list changes (for other tabs' counters). */
  onSources?: (sources: NotebookSource[]) => void;
}

export function SourcesPanel({ onSources }: SourcesPanelProps) {
  const { subjectId, serverSubjectId, findLocalPdf } = useNotebook();
  const [sources, setSources] = useState<NotebookSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pdfProgress, setPdfProgress] = useState<PdfUploadProgress | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSources(serverSubjectId);
      setSources(list);
      onSources?.(list);
      setError(null);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [serverSubjectId, onSources]);

  const syncStoredPdfs = useCallback(async (silent = false) => {
    setBusy('pdfs');
    setInfo(null);
    try {
      const uploaded = await uploadMissingPdfs(subjectId, setPdfProgress);
      if (uploaded.length > 0) setInfo(`${uploaded.length} PDF${uploaded.length === 1 ? '' : 's'} de este dispositivo añadido${uploaded.length === 1 ? '' : 's'} al cuaderno.`);
      else if (!silent) setInfo('Todos los PDFs guardados en este dispositivo ya están en el cuaderno.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setPdfProgress(null);
    }
  }, [subjectId, refresh]);

  // First load + one automatic pass of the subject's stored PDFs per session
  useEffect(() => {
    void (async () => {
      const list = await refresh();
      if (list && !autoSynced.has(subjectId)) {
        autoSynced.add(subjectId);
        void syncStoredPdfs(true);
      }
    })();
  }, [refresh, syncStoredPdfs, subjectId]);

  // Poll while something is still being indexed
  const pending = sources?.some((s) => s.status !== 'indexed' && s.status !== 'error') ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy('upload');
    setError(null);
    setInfo(null);
    try {
      let n = 0;
      for (const f of Array.from(files)) {
        if (f.size > MAX_BYTES) {
          setError(`${f.name}: supera 50 MB.`);
          continue;
        }
        setInfo(`Subiendo ${f.name}…`);
        await uploadSource(serverSubjectId, f.name, f);
        n++;
      }
      setInfo(n > 0 ? `${n} archivo${n === 1 ? '' : 's'} subido${n === 1 ? '' : 's'}. Se indexará${n === 1 ? '' : 'n'} en segundo plano.` : null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onRescan = async () => {
    setBusy('rescan');
    setError(null);
    try {
      await rescanSources(serverSubjectId);
      setInfo('Reescaneo iniciado.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (s: NotebookSource) => {
    const msg = s.origin === 'upload'
      ? `¿Quitar "${s.title || s.filename}" del cuaderno? Se borrará la copia subida.`
      : `¿Quitar "${s.title || s.filename}" del cuaderno? El archivo original no se toca.`;
    if (!confirm(msg)) return;
    try {
      await deleteSource(s.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const indexed = sources?.filter((s) => s.status === 'indexed').length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <Button size="sm" onClick={() => fileRef.current?.click()} loading={busy === 'upload'} disabled={!!busy}>
          Subir archivos
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void syncStoredPdfs()} loading={busy === 'pdfs'} disabled={!!busy}
          title="Sube los PDFs de esta asignatura guardados en el navegador que el cuaderno aún no tiene">
          Sincronizar PDFs guardados
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onRescan()} loading={busy === 'rescan'} disabled={!!busy}
          title="Vuelve a buscar PDFs y apuntes en resources/ de la asignatura">
          Reescanear
        </Button>
        {sources && (
          <span className="text-xs text-ink-500 ml-auto">
            {indexed}/{sources.length} indexadas
          </span>
        )}
      </div>

      <p className="text-xs text-ink-500 -mt-2">PDF, Markdown, TXT o DOCX (máx. 50 MB). Se guardan solo en tu PC.</p>

      {pdfProgress && pdfProgress.total > 0 && (
        <p className="text-xs text-amber-400">
          Subiendo PDFs guardados: {pdfProgress.done}/{pdfProgress.total}
          {pdfProgress.current ? ` · ${pdfProgress.current}` : ''}
        </p>
      )}
      {info && <p className="text-xs text-sage-400">{info}</p>}
      {error && <p className="text-sm text-rose-400">{error}</p>}

      {/* List */}
      {sources === null && !error && <p className="text-sm text-ink-500">Cargando fuentes…</p>}

      {sources && sources.length === 0 && (
        <EmptyState
          title="Sin fuentes todavía"
          description="Sube tus apuntes o PDFs, o pon los archivos en resources/ de la asignatura y pulsa Reescanear."
        />
      )}

      {sources && sources.length > 0 && (
        <ul className="flex flex-col divide-y divide-ink-800 border border-ink-700 rounded-xl bg-ink-800/50 overflow-hidden">
          {sources.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-4 py-3">
              <div className="w-9 h-9 flex-shrink-0 rounded-lg bg-ink-900 border border-ink-700 flex items-center justify-center text-[10px] font-mono uppercase text-ink-400">
                {(s.kind || s.filename.split('.').pop() || '').slice(0, 4)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-100 truncate" title={s.filename}>{s.title || s.filename}</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs text-ink-500">
                  <StatusBadge s={s} />
                  <span>{ORIGIN_LABEL[s.origin] ?? s.origin}</span>
                  {s.pages ? <span>· {s.pages} pág.</span> : null}
                  {s.chunks ? <span>· {s.chunks} fragmentos</span> : null}
                  {s.bytes ? <span>· {formatBytes(s.bytes)}</span> : null}
                  {findLocalPdf(s.filename) && <span className="text-sage-400">· PDF en este dispositivo</span>}
                </div>
                {s.status === 'error' && s.error && <p className="text-xs text-rose-400 mt-1 break-words">{s.error}</p>}
              </div>
              <button
                type="button"
                onClick={() => void onDelete(s)}
                className="text-ink-500 hover:text-rose-400 transition-colors p-1 rounded-lg hover:bg-ink-700 flex-shrink-0"
                title="Quitar del cuaderno"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
