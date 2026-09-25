/**
 * PdfViewer.tsx
 *
 * Visor de PDF integrado usando pdfjs-dist.
 * Soporta:
 *   - Navegación por páginas (anterior / siguiente / input directo)
 *   - Zoom
 *   - goToPage(n) via ref (para los botones "Abrir en página X")
 *   - Lista de PDFs de la asignatura con selector
 */

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Worker — Vite copia el fichero .mjs al build; en dev lo sirve directamente.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PdfViewerHandle {
  /** Navega a la página indicada (1-indexed). */
  goToPage: (page: number) => void;
}

interface PdfViewerProps {
  /** Lista de PDFs disponibles (nombres de archivo). */
  pdfList: string[];
  /** Función que dada un nombre de archivo devuelve la URL completa. */
  getPdfUrl: (filename: string) => string;
  /** PDF y página inicial. */
  initialFilename?: string;
  initialPage?: number;
  /** Callback when user selects text in the PDF. */
  onTextSelected?: (text: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(
  ({ pdfList, getPdfUrl, initialFilename, initialPage = 1, onTextSelected }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

    const [selectedFile, setSelectedFile] = useState<string>(
      initialFilename ?? pdfList[0] ?? '',
    );
    const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [currentPage, setCurrentPage] = useState(initialPage);
    const [totalPages, setTotalPages] = useState(0);
    const [pageInput, setPageInput] = useState(String(initialPage));
    const [scale, setScale] = useState(1.4);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Expose goToPage via ref ──────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      goToPage: (page: number) => {
        if (page >= 1 && page <= totalPages) {
          setCurrentPage(page);
          setPageInput(String(page));
        }
      },
    }));

    // ── Load PDF when file changes ───────────────────────────────────────────
    useEffect(() => {
      if (!selectedFile) return;
      setLoading(true);
      setError(null);
      setPdfDoc(null);
      setTotalPages(0);

      const url = getPdfUrl(selectedFile);
      pdfjsLib.getDocument(url).promise
        .then((doc) => {
          // Honour initialPage for the initial file (e.g. "Abrir PDF en pág. N"); other files start at 1
          const start = selectedFile === (initialFilename ?? pdfList[0])
            ? Math.min(Math.max(1, initialPage), doc.numPages)
            : 1;
          setPdfDoc(doc);
          setTotalPages(doc.numPages);
          setCurrentPage(start);
          setPageInput(String(start));
          setLoading(false);
        })
        .catch((err) => {
          console.error('PDF load error:', err);
          setError('No se pudo cargar el PDF. Comprueba que el archivo está en resources/.');
          setLoading(false);
        });
    }, [selectedFile, getPdfUrl]);

    // ── Render page when pdfDoc or currentPage or scale changes ─────────────
    const renderPage = useCallback(async () => {
      if (!pdfDoc || !canvasRef.current) return;

      // Cancel previous render
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderContext = {
        canvasContext: ctx,
        viewport,
      };

      try {
        renderTaskRef.current = page.render(renderContext);
        await renderTaskRef.current.promise;
      } catch (err: unknown) {
        // RenderingCancelledException is expected when we cancel
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
      }
    }, [pdfDoc, currentPage, scale]);

    useEffect(() => {
      renderPage();
    }, [renderPage]);

    // ── Controls ─────────────────────────────────────────────────────────────
    const goTo = (n: number) => {
      const p = Math.max(1, Math.min(n, totalPages));
      setCurrentPage(p);
      setPageInput(String(p));
    };

    const handlePageInputBlur = () => {
      const n = parseInt(pageInput, 10);
      if (!isNaN(n)) goTo(n);
      else setPageInput(String(currentPage));
    };

    const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handlePageInputBlur();
    };

    // ── Text selection handler ─────────────────────────────────────────────────
    const handleMouseUp = useCallback(() => {
      if (!onTextSelected) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const text = selection.toString().trim();
      if (text.length > 10) {
        onTextSelected(text);
      }
    }, [onTextSelected]);

    // ── Render ────────────────────────────────────────────────────────────────
    return (
      <div className="flex flex-col gap-0 h-full">
        {/* ── Toolbar ── */}
        <div className="flex items-center gap-3 px-4 py-2 bg-ink-900 border-b border-ink-700 flex-wrap">
          {/* File selector */}
          {pdfList.length > 1 && (
            <select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              className="bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-2 py-1 text-xs font-body max-w-[220px] truncate"
            >
              {pdfList.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {pdfList.length === 1 && (
            <span className="text-xs text-ink-400 truncate max-w-[220px]">{selectedFile}</span>
          )}

          <div className="flex-1" />

          {/* Page navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo(currentPage - 1)}
              disabled={currentPage <= 1 || !pdfDoc}
              className="text-ink-300 hover:text-ink-100 disabled:text-ink-700 px-2 py-1 rounded text-sm transition-colors"
            >
              ‹
            </button>
            <div className="flex items-center gap-1.5 text-xs text-ink-400">
              <input
                type="number"
                min={1}
                max={totalPages}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onBlur={handlePageInputBlur}
                onKeyDown={handlePageInputKeyDown}
                disabled={!pdfDoc}
                className="w-12 text-center bg-ink-800 border border-ink-600 text-ink-100 rounded px-1 py-0.5 text-xs font-body"
              />
              <span>/ {totalPages || '–'}</span>
            </div>
            <button
              onClick={() => goTo(currentPage + 1)}
              disabled={currentPage >= totalPages || !pdfDoc}
              className="text-ink-300 hover:text-ink-100 disabled:text-ink-700 px-2 py-1 rounded text-sm transition-colors"
            >
              ›
            </button>
          </div>

          {/* Zoom */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}
              className="text-ink-400 hover:text-ink-200 px-1.5 py-0.5 rounded text-xs transition-colors"
              title="Zoom out"
            >
              −
            </button>
            <span className="text-xs text-ink-500 w-10 text-center">{Math.round(scale * 100)}%</span>
            <button
              onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}
              className="text-ink-400 hover:text-ink-200 px-1.5 py-0.5 rounded text-xs transition-colors"
              title="Zoom in"
            >
              +
            </button>
            <button
              onClick={() => setScale(1.4)}
              className="text-ink-500 hover:text-ink-300 px-1.5 py-0.5 rounded text-xs transition-colors"
              title="Reset zoom"
            >
              ↺
            </button>
          </div>

          {/* External open */}
          {selectedFile && (
            <a
              href={getPdfUrl(selectedFile)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-ink-400 hover:text-amber-400 transition-colors"
              title="Abrir en pestaña nueva"
            >
              ↗
            </a>
          )}
        </div>

        {/* ── Canvas area ── */}
        <div
          ref={containerRef}
          onMouseUp={handleMouseUp}
          className="flex-1 overflow-auto bg-ink-950 flex justify-center items-start p-4"
        >
          {loading && (
            <div className="text-ink-500 text-sm mt-8 flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Cargando PDF…
            </div>
          )}
          {error && (
            <div className="text-rose-400 text-sm mt-8 max-w-sm text-center">
              <p className="text-2xl mb-2">⚠️</p>
              {error}
            </div>
          )}
          {!loading && !error && !pdfDoc && !selectedFile && (
            <div className="text-ink-600 text-sm mt-8">
              No hay PDFs disponibles para esta asignatura.
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="shadow-2xl rounded"
            style={{ display: pdfDoc && !loading ? 'block' : 'none' }}
          />
        </div>
      </div>
    );
  },
);

PdfViewer.displayName = 'PdfViewer';
