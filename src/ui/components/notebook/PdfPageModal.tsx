/**
 * PdfPageModal.tsx
 *
 * Opens a locally stored PDF (FSA folder / IndexedDB) at a given page with the
 * app's PdfViewer — used by citation popovers ("Abrir PDF en pág. N").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/ui/components';
import { PdfViewer, type PdfViewerHandle } from '@/ui/components/PdfViewer';
import { getStoredPdfBlob } from '@/data/hoardSync';

interface PdfPageModalProps {
  subjectId: string;
  filename: string | null;
  page: number;
  onClose: () => void;
}

export function PdfPageModal({ subjectId, filename, page, onClose }: PdfPageModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewerRef = useRef<PdfViewerHandle>(null);

  useEffect(() => {
    if (!filename) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    getStoredPdfBlob(subjectId, filename)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setError('Este PDF ya no está guardado en este dispositivo.');
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setError('No se pudo abrir el PDF.'); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [subjectId, filename]);

  // Page change while the same PDF stays open
  useEffect(() => {
    viewerRef.current?.goToPage(page);
  }, [page]);

  const getPdfUrl = useCallback(() => url ?? '', [url]);

  return (
    <Modal open={!!filename} onClose={onClose} title={`${filename ?? ''} · pág. ${page}`} size="xl">
      {error && <p className="text-sm text-rose-400 py-6 text-center">{error}</p>}
      {!error && !url && <p className="text-sm text-ink-500 py-6 text-center">Cargando PDF…</p>}
      {url && filename && (
        <div className="h-[78vh]">
          <PdfViewer
            ref={viewerRef}
            pdfList={[filename]}
            getPdfUrl={getPdfUrl}
            initialFilename={filename}
            initialPage={page}
          />
        </div>
      )}
    </Modal>
  );
}
