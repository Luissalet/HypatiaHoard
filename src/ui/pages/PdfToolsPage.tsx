/**
 * PdfToolsPage.tsx
 *
 * Herramientas PDF integradas en Exam Coach.
 * 100% client-side — compatible con GitHub Pages.
 */

import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Input, Select } from '@/ui/components';
import {
  mergePdfs,
  splitPdf,
  extractPages,
  getPdfPageCount,
  rotatePdf,
  imagesToPdf,
  addWatermark,
  readMetadata,
  editMetadata,
  downloadBlob,
  formatSize,
  type SplitMode,
  type RotationDegrees,
  type PageSize,
  type Orientation,
  type PdfMetadata,
  type SplitResult,
} from '@/services/pdfTools';

// ─── Types ──────────────────────────────────────────────────────────────────

type ToolId = 'merge' | 'split' | 'extract' | 'rotate' | 'images' | 'watermark' | 'metadata';

interface ToolDef {
  id: ToolId;
  label: string;
  icon: string;
  desc: string;
}

const TOOLS: ToolDef[] = [
  { id: 'merge', label: 'Unir', icon: '📎', desc: 'Combina múltiples PDFs en uno' },
  { id: 'split', label: 'Dividir', icon: '✂️', desc: 'Divide un PDF por páginas o rangos' },
  { id: 'extract', label: 'Extraer', icon: '📄', desc: 'Extrae páginas específicas' },
  { id: 'rotate', label: 'Rotar', icon: '🔄', desc: 'Rota páginas del PDF' },
  { id: 'images', label: 'Imágenes→PDF', icon: '🖼️', desc: 'Convierte imágenes a PDF' },
  { id: 'watermark', label: 'Marca de agua', icon: '💧', desc: 'Añade texto de marca de agua' },
  { id: 'metadata', label: 'Metadatos', icon: '🏷️', desc: 'Edita título, autor y más' },
];

// ─── File Drop Zone ─────────────────────────────────────────────────────────

function FileDropZone({
  accept,
  multiple,
  files,
  onAdd,
  onRemove,
  onReorder,
  label,
}: {
  accept: string;
  multiple: boolean;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (idx: number) => void;
  onReorder?: (from: number, to: number) => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = [...e.dataTransfer.files];
    if (droppedFiles.length > 0) onAdd(droppedFiles);
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
          dragOver
            ? 'border-amber-500 bg-amber-500/5 text-amber-300'
            : 'border-ink-700 text-ink-500 hover:border-ink-500 hover:text-ink-400'
        }`}
      >
        <p className="text-sm font-body">{label ?? 'Arrastra archivos aquí o haz clic para seleccionar'}</p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            const selected = [...(e.target.files ?? [])];
            if (selected.length > 0) onAdd(selected);
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((f, idx) => (
            <div
              key={`${f.name}-${idx}`}
              draggable={!!onReorder}
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx != null && onReorder) onReorder(dragIdx, idx);
                setDragIdx(null);
              }}
              className="flex items-center gap-2 bg-ink-800 rounded-lg px-3 py-2 text-sm"
            >
              {onReorder && <span className="text-ink-600 cursor-grab text-xs">⠿</span>}
              <span className="flex-1 text-ink-200 truncate">{f.name}</span>
              <span className="text-xs text-ink-500">{formatSize(f.size)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(idx); }}
                className="text-ink-600 hover:text-rose-400 transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tool Components ────────────────────────────────────────────────────────

function MergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);

  const addFiles = (newFiles: File[]) => setFiles((prev) => [...prev, ...newFiles.filter((f) => f.type === 'application/pdf')]);
  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));
  const reorder = (from: number, to: number) => {
    setFiles((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      return arr;
    });
  };

  const handleMerge = async () => {
    setLoading(true);
    try {
      const blob = await mergePdfs(files);
      downloadBlob(blob, 'unido.pdf');
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple
        files={files}
        onAdd={addFiles}
        onRemove={removeFile}
        onReorder={reorder}
        label="Arrastra PDFs aquí (se unirán en orden)"
      />
      <Button onClick={handleMerge} disabled={files.length < 2 || loading} loading={loading}>
        Unir {files.length} PDFs
      </Button>
    </div>
  );
}

function SplitTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [mode, setMode] = useState<SplitMode>('by_pages');
  const [n, setN] = useState(1);
  const [ranges, setRanges] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFile = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    const count = await getPdfPageCount(f);
    setPageCount(count);
  };

  const handleSplit = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const results: SplitResult[] = await splitPdf(file, mode, { n, ranges });
      for (const r of results) {
        downloadBlob(r.blob, r.name);
        // Small delay between downloads
        await new Promise((res) => setTimeout(res, 300));
      }
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple={false}
        files={file ? [file] : []}
        onAdd={handleFile}
        onRemove={() => { setFile(null); setPageCount(0); }}
      />
      {file && (
        <>
          <p className="text-xs text-ink-500">{pageCount} páginas</p>
          <Select label="Modo" value={mode} onChange={(e) => setMode(e.target.value as SplitMode)}>
            <option value="by_pages">Página por página</option>
            <option value="every_n">Cada N páginas</option>
            <option value="ranges">Rangos personalizados</option>
          </Select>
          {mode === 'every_n' && (
            <Input label="Páginas por fragmento" type="number" min={1} max={pageCount} value={n} onChange={(e) => setN(Number(e.target.value))} />
          )}
          {mode === 'ranges' && (
            <Input label="Rangos (ej: 1-3, 5, 8-12)" value={ranges} onChange={(e) => setRanges(e.target.value)} hint={`Páginas válidas: 1-${pageCount}`} />
          )}
          <Button onClick={handleSplit} disabled={loading} loading={loading}>
            Dividir
          </Button>
        </>
      )}
    </div>
  );
}

function ExtractTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const handleFile = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    const count = await getPdfPageCount(f);
    setPageCount(count);
    setSelectedPages(new Set());
  };

  const togglePage = (p: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedPages.size === pageCount) {
      setSelectedPages(new Set());
    } else {
      setSelectedPages(new Set(Array.from({ length: pageCount }, (_, i) => i + 1)));
    }
  };

  const handleExtract = async () => {
    if (!file || selectedPages.size === 0) return;
    setLoading(true);
    try {
      const blob = await extractPages(file, [...selectedPages]);
      const baseName = file.name.replace(/\.pdf$/i, '');
      downloadBlob(blob, `${baseName}_extracto.pdf`);
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple={false}
        files={file ? [file] : []}
        onAdd={handleFile}
        onRemove={() => { setFile(null); setPageCount(0); setSelectedPages(new Set()); }}
      />
      {file && pageCount > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-500">{selectedPages.size} de {pageCount} páginas seleccionadas</p>
            <button onClick={toggleAll} className="text-xs text-amber-400 hover:text-amber-300">
              {selectedPages.size === pageCount ? 'Ninguna' : 'Todas'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => togglePage(p)}
                className={`w-9 h-9 rounded-lg text-xs font-medium transition-all ${
                  selectedPages.has(p)
                    ? 'bg-amber-500 text-ink-900'
                    : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <Button onClick={handleExtract} disabled={selectedPages.size === 0 || loading} loading={loading}>
            Extraer {selectedPages.size} página{selectedPages.size !== 1 ? 's' : ''}
          </Button>
        </>
      )}
    </div>
  );
}

function RotateTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [degrees, setDegrees] = useState<RotationDegrees>(90);
  const [scope, setScope] = useState<'all' | 'custom'>('all');
  const [customPages, setCustomPages] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFile = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    const count = await getPdfPageCount(f);
    setPageCount(count);
  };

  const handleRotate = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const pageNumbers = scope === 'custom'
        ? customPages.split(',').map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
        : undefined;
      const blob = await rotatePdf(file, degrees, pageNumbers);
      const baseName = file.name.replace(/\.pdf$/i, '');
      downloadBlob(blob, `${baseName}_rotado.pdf`);
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple={false}
        files={file ? [file] : []}
        onAdd={handleFile}
        onRemove={() => { setFile(null); setPageCount(0); }}
      />
      {file && (
        <>
          <p className="text-xs text-ink-500">{pageCount} páginas</p>
          <div className="flex gap-3">
            <Select label="Rotación" value={String(degrees)} onChange={(e) => setDegrees(Number(e.target.value) as RotationDegrees)}>
              <option value="90">90° (derecha)</option>
              <option value="180">180°</option>
              <option value="270">270° (izquierda)</option>
            </Select>
            <Select label="Aplicar a" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'custom')}>
              <option value="all">Todas las páginas</option>
              <option value="custom">Páginas específicas</option>
            </Select>
          </div>
          {scope === 'custom' && (
            <Input label="Páginas (ej: 1, 3, 5)" value={customPages} onChange={(e) => setCustomPages(e.target.value)} />
          )}
          <Button onClick={handleRotate} disabled={loading} loading={loading}>
            Rotar
          </Button>
        </>
      )}
    </div>
  );
}

function ImagesTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [pageSize, setPageSize] = useState<PageSize>('A4');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [loading, setLoading] = useState(false);

  const addFiles = (newFiles: File[]) => {
    const imageFiles = newFiles.filter((f) => f.type.startsWith('image/'));
    setFiles((prev) => [...prev, ...imageFiles]);
  };
  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));
  const reorder = (from: number, to: number) => {
    setFiles((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      return arr;
    });
  };

  const handleConvert = async () => {
    setLoading(true);
    try {
      const blob = await imagesToPdf(files, { pageSize, orientation });
      downloadBlob(blob, 'imagenes.pdf');
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept="image/*"
        multiple
        files={files}
        onAdd={addFiles}
        onRemove={removeFile}
        onReorder={reorder}
        label="Arrastra imágenes aquí (JPG, PNG, etc.)"
      />
      {files.length > 0 && (
        <>
          <div className="flex gap-3">
            <Select label="Tamaño de página" value={pageSize} onChange={(e) => setPageSize(e.target.value as PageSize)}>
              <option value="A4">A4</option>
              <option value="Letter">Carta</option>
              <option value="fit">Ajustar a imagen</option>
            </Select>
            <Select label="Orientación" value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)}>
              <option value="auto">Automática</option>
              <option value="portrait">Vertical</option>
              <option value="landscape">Horizontal</option>
            </Select>
          </div>
          <Button onClick={handleConvert} disabled={loading} loading={loading}>
            Convertir {files.length} imagen{files.length !== 1 ? 'es' : ''} a PDF
          </Button>
        </>
      )}
    </div>
  );
}

function WatermarkTool() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('BORRADOR');
  const [opacity, setOpacity] = useState(15);
  const [angle, setAngle] = useState(-45);
  const [fontSize, setFontSize] = useState(48);
  const [loading, setLoading] = useState(false);

  const handleApply = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const blob = await addWatermark(file, text, {
        opacity: opacity / 100,
        angle,
        fontSize,
      });
      const baseName = file.name.replace(/\.pdf$/i, '');
      downloadBlob(blob, `${baseName}_watermark.pdf`);
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple={false}
        files={file ? [file] : []}
        onAdd={(fs) => setFile(fs[0] ?? null)}
        onRemove={() => setFile(null)}
      />
      {file && (
        <>
          <Input label="Texto" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-ink-400 uppercase tracking-widest">
                Opacidad: {opacity}%
              </label>
              <input
                type="range"
                min={5}
                max={80}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
            </div>
            <Input label="Ángulo" type="number" value={angle} onChange={(e) => setAngle(Number(e.target.value))} className="w-24" />
            <Input label="Tamaño fuente" type="number" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-24" />
          </div>
          <Button onClick={handleApply} disabled={!text.trim() || loading} loading={loading}>
            Aplicar marca de agua
          </Button>
        </>
      )}
    </div>
  );
}

function MetadataTool() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<PdfMetadata>({});
  const [loading, setLoading] = useState(false);

  const handleFile = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFile(f);
    try {
      const m = await readMetadata(f);
      setMeta(m);
    } catch {
      setMeta({});
    }
  };

  const handleSave = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const blob = await editMetadata(file, meta);
      const baseName = file.name.replace(/\.pdf$/i, '');
      downloadBlob(blob, `${baseName}_meta.pdf`);
    } catch (err) {
      alert('Error: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  const update = (key: keyof PdfMetadata, value: string) =>
    setMeta((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-4">
      <FileDropZone
        accept=".pdf"
        multiple={false}
        files={file ? [file] : []}
        onAdd={handleFile}
        onRemove={() => { setFile(null); setMeta({}); }}
      />
      {file && (
        <>
          <Input label="Título" value={meta.title ?? ''} onChange={(e) => update('title', e.target.value)} />
          <Input label="Autor" value={meta.author ?? ''} onChange={(e) => update('author', e.target.value)} />
          <Input label="Asunto" value={meta.subject ?? ''} onChange={(e) => update('subject', e.target.value)} />
          <Input label="Palabras clave" value={meta.keywords ?? ''} onChange={(e) => update('keywords', e.target.value)} />
          <Input label="Creador" value={meta.creator ?? ''} onChange={(e) => update('creator', e.target.value)} />
          {meta.producer && (
            <p className="text-xs text-ink-500">Productor: {meta.producer}</p>
          )}
          <Button onClick={handleSave} disabled={loading} loading={loading}>
            Guardar metadatos
          </Button>
        </>
      )}
    </div>
  );
}

// ─── Tool Renderer ──────────────────────────────────────────────────────────

function ToolContent({ toolId }: { toolId: ToolId }) {
  switch (toolId) {
    case 'merge': return <MergeTool />;
    case 'split': return <SplitTool />;
    case 'extract': return <ExtractTool />;
    case 'rotate': return <RotateTool />;
    case 'images': return <ImagesTool />;
    case 'watermark': return <WatermarkTool />;
    case 'metadata': return <MetadataTool />;
  }
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export function PdfToolsPage() {
  const navigate = useNavigate();
  const [activeTool, setActiveTool] = useState<ToolId>('merge');
  const active = TOOLS.find((t) => t.id === activeTool)!;

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      {/* Header */}
      <div className="sticky top-0 z-30 bg-ink-900/95 backdrop-blur-sm border-b border-ink-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-ink-400 hover:text-ink-200 transition-colors text-sm"
          >
            ← Dashboard
          </button>
          <h1 className="font-display text-lg text-ink-100">Herramientas PDF</h1>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 flex gap-6">
        {/* Sidebar - tool selector */}
        <aside className="w-56 flex-shrink-0">
          <nav className="sticky top-20 space-y-1">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-body transition-all flex items-center gap-2 ${
                  activeTool === tool.id
                    ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                    : 'text-ink-400 hover:text-ink-200 hover:bg-ink-800'
                }`}
              >
                <span className="text-base">{tool.icon}</span>
                {tool.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0">
          <Card className="p-6">
            <div className="mb-6">
              <h2 className="font-display text-xl text-ink-100 flex items-center gap-2">
                <span>{active.icon}</span>
                {active.label}
              </h2>
              <p className="text-sm text-ink-400 mt-1">{active.desc}</p>
            </div>
            <ToolContent toolId={activeTool} />
          </Card>
        </main>
      </div>
    </div>
  );
}
