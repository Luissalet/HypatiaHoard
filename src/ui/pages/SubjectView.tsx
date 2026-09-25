import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '@/ui/store';
import {
  Button, Card, Modal, Input, Tabs, Badge, TypeBadge, Difficulty,
  EmptyState, StatsSummary, Select,
} from '@/ui/components';
import { QuestionForm } from '@/ui/components/QuestionForm';
import { PdfViewer, type PdfViewerHandle } from '@/ui/components/PdfViewer';
import { MdContent } from '@/ui/components/MdContent';
import { renderMd } from '@/utils/renderMd';
import { QuestionPreviewContent } from '@/ui/components/QuestionPreview';
import { KeyConceptsTab } from '@/ui/components/KeyConceptsTab';
import { AIExtractionTab } from '@/ui/components/AIExtractionTab';
import { PdfExportModal } from '@/ui/components/PdfExportModal';
import { generateQuestionsPDF, downloadBlob } from '@/utils/pdfExport';

import { savePdfBlob, savePdfToServer, getPdfBlobUrl, listStoredPdfs, deleteStoredPdf } from '@/data/pdfStorage';
import { checkStorageQuota, isFsaSupported } from '@/data/fsaStorage';
import type { Topic, Question, QuestionOrigin, QuestionType, Exam } from '@/domain/models';
import { ExamsTab } from '@/ui/components/ExamsTab';
import { slugify } from '@/domain/normalize';
import { getResourceBlobUrl,loadCategoryFromDB } from '@/data/resourceFromDB';
import { loadPdfMapping, getPdfUrl, resourcesUrl, loadSubjectExtraInfo } from '@/data/resourceLoader';
import type { GptLink } from '@/domain/models';
import { exportContributionPackByIds, previewContributionPack, importContributionPack, type ContributionPackPreview } from '@/data/contributionImport';
import { downloadJSON } from '@/data/exportImport';
import { exportToAnkiTsv, downloadAnkiFile } from '@/utils/ankiExport';
import { getTopicWavCacheKey, getResourceWavCacheKey, hasWavEntry } from '@/utils/backgroundSynthesis';
import type { SynthesisProgress } from '@/utils/backgroundSynthesis';
import { useHoardMode, isHoardMode } from '@/data/hoardMode';
type TabId = 'topics' | 'questions' | 'practice' | 'exams' | 'resources' | 'concepts' | 'chatbots' | 'ia';

const TYPE_LABELS_MAP: Record<QuestionType, string> = {
  TEST: 'Test',
  DESARROLLO: 'Desarrollo',
  COMPLETAR: 'Completar',
  PRACTICO: 'Práctico',
};

const ORIGIN_LABELS: Record<QuestionOrigin, string> = {
  test: 'Test',
  examen_anterior: 'Examen ant.',
  clase: 'Clase',
  alumno: 'Alumno',
};

const ORIGIN_COLORS: Record<QuestionOrigin, 'amber' | 'rose' | 'blue' | 'sage'> = {
  test: 'amber',
  examen_anterior: 'rose',
  clase: 'blue',
  alumno: 'sage',
};

// ── Helper: check if question belongs to a topic (supports multi-topic) ─────
function questionBelongsToTopic(q: Question, topicId: string): boolean {
  if (q.topicId === topicId) return true;
  if (q.topicIds && q.topicIds.includes(topicId)) return true;
  return false;
}

// ── Resource file entry ─────────────────────────────────────────────────────
interface ResourceFile {
  name: string;
  path: string;
  type: string; // extension
  /** ID del tema asociado (solo para categoría Temas) */
  topicId?: string;
}

interface SubCategory {
  name: string;
  files: ResourceFile[];
}

interface ResourceCategory {
  name: string;
  slug: string;
  files: ResourceFile[];
  subcategories?: SubCategory[];
}

// ── Preview: enunciado + respuesta resuelta ─────────────────────────────────
// (QuestionPreviewContent is now imported from @/ui/components/QuestionPreview)

// ── Botón "Copiar enlace" — copia la URL actual al portapapeles ──────────────
function CopyLinkButton({ subjectId, tab }: { subjectId: string | undefined; tab: string }) {
  const [copied, setCopied] = useState(false);

  if (!subjectId) return null;

  const handleCopy = async () => {
    // Construimos la URL con hash que apunta directamente a esta asignatura y pestaña
    const url = `${window.location.origin}${window.location.pathname}#/subject/${subjectId}?tab=${tab}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback para navegadores sin Clipboard API
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      title={copied ? '¡Enlace copiado!' : 'Copiar enlace a esta asignatura'}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 ${
        copied
          ? 'bg-sage-600/20 text-sage-400 border border-sage-600/30'
          : 'text-ink-400 hover:text-ink-200 hover:bg-ink-800 border border-transparent'
      }`}
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Copiado
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z" />
          </svg>
          Copiar enlace
        </>
      )}
    </button>
  );
}

// ── WAV status icon ─────────────────────────────────────────────────────────
/**
 * Muestra el estado del caché WAV para un topic:
 *   ○  sin caché (círculo vacío gris)
 *   ⟳  sintetizando (spinner naranja)
 *   ✓  cacheado (círculo con tick verde)
 */
function WavStatusIcon({
  topicId,
  synthesisJobs,
}: {
  topicId: string;
  synthesisJobs: Record<string, SynthesisProgress>;
}) {
  const [cached, setCached] = useState<boolean | null>(null);

  // Check active synthesis job for this topic
  const job = Object.values(synthesisJobs).find((j) => j.topicId === topicId);
  const isDownloading = !!job && job.status !== 'done' && job.status !== 'error';

  useEffect(() => {
    const cacheKey = getTopicWavCacheKey(topicId);
    if (!cacheKey) {
      setCached(false);
      return;
    }
    hasWavEntry(cacheKey).then((has) => setCached(has));
  }, [topicId, synthesisJobs]); // re-check when jobs change

  if (isDownloading) {
    const pct = job!.total > 0 ? Math.round((job!.current / job!.total) * 100) : 0;
    return (
      <span
        title={`Generando audio WAV… ${pct}%`}
        className="flex items-center gap-1 text-amber-400"
      >
        {/* Spinner */}
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
          <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" />
        </svg>
        <span className="text-[10px] font-mono">{pct}%</span>
      </span>
    );
  }

  if (cached) {
    return (
      <span title="Audio WAV cacheado" className="text-sage-400">
        {/* Circle with tick */}
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="9" strokeOpacity="0.6" />
          <path d="M8 12l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  // Not yet cached / unknown
  return (
    <span title="Audio WAV no generado" className="text-ink-600">
      {/* Empty circle */}
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
      </svg>
    </span>
  );
}

// ── Resource WAV status icon ─────────────────────────────────────────────────
/**
 * Muestra el estado del caché WAV para un recurso (PDF de Otros recursos):
 *   ○  sin caché (gris)
 *   ⟳  sintetizando (spinner naranja)
 *   ✓  cacheado (verde)
 */
function ResourceWavStatusIcon({
  resourceFile,
  synthesisJobs,
}: {
  resourceFile: string;
  synthesisJobs: Record<string, SynthesisProgress>;
}) {
  const [cached, setCached] = useState<boolean | null>(null);

  // Check active synthesis job for this resource file
  // Jobs for resources use resourceFile as pdfFilename, and resourceFile as topicId
  const job = Object.values(synthesisJobs).find(
    (j) => j.pdfFilename === resourceFile || j.topicId === resourceFile,
  );
  const isDownloading = !!job && job.status !== 'done' && job.status !== 'error';

  useEffect(() => {
    const cacheKey = getResourceWavCacheKey(resourceFile);
    if (!cacheKey) { setCached(false); return; }
    hasWavEntry(cacheKey).then((has) => setCached(has));
  }, [resourceFile, synthesisJobs]); // re-check when jobs change (may have finished)

  if (isDownloading) {
    const pct = job!.total > 0 ? Math.round((job!.current / job!.total) * 100) : 0;
    return (
      <span
        title={`Generando audio WAV… ${pct}%`}
        className="flex items-center gap-1 text-amber-400"
      >
        {/* Spinner */}
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
          <path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" />
        </svg>
        <span className="text-[10px] font-mono">{pct}%</span>
      </span>
    );
  }

  if (cached) {
    return (
      <span title="Audio WAV cacheado" className="text-sage-400">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="9" strokeOpacity="0.6" />
          <path d="M8 12l3 3 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  return (
    <span title="Audio WAV no generado" className="text-ink-600">
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
      </svg>
    </span>
  );
}

export function SubjectView() {
  const { subjectId } = useParams<{ subjectId: string }>();
  const navigate = useNavigate();
  const hoard = useHoardMode();
  const [searchParams] = useSearchParams();
  const {
    subjects, topics, questions, settings, keyConcepts, exams,
    loadSubjects, loadTopics, loadQuestions, loadKeyConcepts, loadExams,
    createTopic, updateTopic, deleteTopic,
    createQuestion, updateQuestion, deleteQuestion, duplicateQuestion,
    createKeyConcept, updateKeyConcept, deleteKeyConcept,
    createExam, updateExam, deleteExam, duplicateExam,
    synthesisJobs,
  } = useStore();

  const subject = subjects.find((s) => s.id === subjectId);
  const initialTab = (searchParams.get('tab') as TabId | null) ?? 'topics';
  const autostart = searchParams.get('autostart') ?? '';
  const [tab, setTab] = useState<TabId>(initialTab);

  const [filterTopic, setFilterTopic] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterOrigin, setFilterOrigin] = useState('');
  const [filterText, setFilterText] = useState('');
  const [searchText, setSearchText] = useState('');
  // D3: Filter by author
  const [filterAuthor, setFilterAuthor] = useState('');
  // C2: Selection mode for selective export
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Question list view mode (card vs compact list)
  const [questionView, setQuestionView] = useState<'card' | 'list'>('card');
  // PDF export modal
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [pdfOriginFilter, setPdfOriginFilter] = useState<string>('');
  // Contribution pack export modal
  const [contribExportOpen, setContribExportOpen] = useState(false);
  const [contribOnlyMine, setContribOnlyMine] = useState(false);
  // Anki export modal
  const [ankiExportOpen, setAnkiExportOpen] = useState(false);
  // Subject-level contribution pack import
  const [subjectPackPreview, setSubjectPackPreview] = useState<ContributionPackPreview | null>(null);
  const [subjectImporting, setSubjectImporting] = useState(false);
  const [subjectImportMsg, setSubjectImportMsg] = useState('');
  const [subjectPreviewSampleQuestion, setSubjectPreviewSampleQuestion] = useState<Question | null>(null);

  // Importa un contribution pack (normal o "loose") directamente en esta asignatura.
  const handleSubjectPackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const { parseImportFile } = await import('@/data/exportImport');
      const raw = await parseImportFile(file);
      const preview = await previewContributionPack(raw, subjectId);
      if ('error' in preview) {
        alert('Error al leer el pack: ' + preview.error);
      } else {
        setSubjectImportMsg('');
        setSubjectPackPreview(preview);
      }
    } catch (err) {
      alert('Error: ' + String(err));
    }
  };

  // Bulk operations
  const [bulkTopicId, setBulkTopicId] = useState('');
  const [bulkTag, setBulkTag] = useState('');

  const [topicModal, setTopicModal] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [topicTitle, setTopicTitle] = useState('');
  const [questionModal, setQuestionModal] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [previewQuestion, setPreviewQuestion] = useState<Question | null>(null);

  // Lista combinada: resources/ estáticos + IndexedDB
  const [pdfList, setPdfList] = useState<string[]>([]);

  // Drag & drop state per topic (topicId → is dragging over)
  const [draggingOver, setDraggingOver] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null); // topicId uploading

  // Resources tab: set of prefixed filenames stored in IndexedDB (e.g. "Examenes/file.pdf")
  const [resourceDbFiles, setResourceDbFiles] = useState<Set<string>>(new Set());

  // B2: Drag & drop reorder state
  const [reorderDragIdx, setReorderDragIdx] = useState<number | null>(null);
  const [reorderOverIdx, setReorderOverIdx] = useState<number | null>(null);

  // ── GPT Links ────────────────────────────────────────────────────────────
  const [gptLinks, setGptLinks] = useState<GptLink[]>([]);

  // Modal ver PDF
  const [viewPdfTopic, setViewPdfTopic] = useState<Topic | null>(null);
  const [viewPdfUrl, setViewPdfUrl] = useState<string | null>(null);
  const topicPdfViewerRef = useRef<PdfViewerHandle>(null);
  const activeObjectUrlRef = useRef<string | null>(null);

  // PDF text selection → create question
  const [pdfSelectedText, setPdfSelectedText] = useState<string>('');
  const [createFromPdf, setCreateFromPdf] = useState(false);

  // Resources tab state
  const [resources, setResources] = useState<ResourceCategory[]>([]);

  // Aviso de almacenamiento lleno al intentar subir archivos
  const [storageAlert, setStorageAlert] = useState<{ msg: string; suggestFsa: boolean } | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);

  useEffect(() => {
    if (!subjects.length) loadSubjects();
  }, []);

  useEffect(() => {
    if (subjectId) {
      loadTopics(subjectId);
      loadQuestions(subjectId);
      loadKeyConcepts(subjectId);
      loadExams(subjectId);
    }
  }, [subjectId]);

  // Carga lista de PDFs y sincroniza bidireccional: DB → index.json y index.json → DB
  const refreshPdfList = useCallback(async () => {
    if (!subject || !subjectId) return;
    const currentTopics = topics.filter(t => t.subjectId === subjectId);

    const [mapping, dbList] = await Promise.all([
      loadPdfMapping(subject.name),
      listStoredPdfs(subjectId),
    ]);

    // index.json → DB: asignar PDFs a temas que coincidan por topicTitle y aún no tengan PDF
    for (const entry of mapping) {
      if (!entry.topicTitle || !entry.pdf) continue;
      const topic = currentTopics.find(
        t => !t.pdfFilename && t.title.trim().toLowerCase() === entry.topicTitle.trim().toLowerCase()
      );
      if (topic) {
        await updateTopic(topic.id, { pdfFilename: entry.pdf });
      }
    }

    // DB → index.json: sincronizar temas que ya tienen pdfFilename pero no están en el mapeo
    const topicsWithPdf = currentTopics.filter(t => t.pdfFilename);
    if (topicsWithPdf.length > 0) {
      const entriesToSync = topicsWithPdf
        .filter(t => !mapping.some(e => e.pdf === t.pdfFilename && e.topicTitle))
        .map(t => ({ topicTitle: t.title, pdf: t.pdfFilename! }));

      // Dev-server endpoint; under Hypatia's Hoard /api is the local server, which lacks it.
      if (entriesToSync.length > 0 && !isHoardMode()) {
        fetch('/api/sync-pdf-mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slugify(subject.name), entries: entriesToSync }),
        }).catch(() => { /* solo disponible en dev, ignorar en prod */ });
      }
    }

    const staticList = mapping.map(e => e.pdf);
    const merged = Array.from(new Set([...staticList, ...dbList]));
    setPdfList(merged);
  }, [subject?.name, subjectId, topics]);

  useEffect(() => {
    refreshPdfList();
  }, [refreshPdfList]);

  // ── Cargar GPT links desde extra_info.json ───────────────────────────────
  useEffect(() => {
    if (!subject) return;
    loadSubjectExtraInfo(subject.name).then((info) => {
      setGptLinks(info?.gptLinks ?? []);
    });
  }, [subject?.name]);

  // Load resources when tab changes to 'resources'
  useEffect(() => {
    if (tab !== 'resources' || !subject) return;
    loadResources();
  }, [tab, subject?.name]);

  const loadResources = async () => {
  if (!subject || !subjectId) return;
  setResourcesLoading(true);
  const slug = slugify(subject.name);
  const categories: ResourceCategory[] = [];

  // Try to load each resource category
  for (const cat of [
    { name: 'Resúmenes', slug: 'Resumenes' },
    { name: 'Exámenes', slug: 'Examenes' },
    { name: 'Práctica', slug: 'Practica' },
    
  ]) {
    // Cargar de ambas fuentes (estática + IndexedDB) y fusionar.
    // Solo estática no es suficiente porque el .gitignore excluye los archivos
    // reales (solo commitea index.json). Los usuarios que importan el ZIP
    // tienen los archivos en IndexedDB pero el index.json estático sigue presente.
    let staticFiles: ResourceFile[] = [];
    let staticSubcats: SubCategory[] | undefined;
    let dbFiles: ResourceFile[] = [];
    let dbSubcats: SubCategory[] | undefined;

    // 1. Intentar cargar desde archivos estáticos
    try {
      const res = await fetch(resourcesUrl(`resources/${slug}/${cat.slug}/index.json`), { cache: 'no-cache' });
      if (res.ok) {
        const ct = res.headers.get('Content-Type') ?? '';
        // Asegurarse de que es un JSON real y no el SPA catch-all
        if (ct.includes('json') || !ct.includes('text/html')) {
          const data = await res.json();
          staticFiles = data.files ?? [];
          staticSubcats = data.subcategories;
        }
      }
    } catch {
      // Static file not available
    }

    // 2. Cargar desde IndexedDB
    try {
      const dbData = await loadCategoryFromDB(subjectId, cat.slug);
      dbFiles = dbData.files ?? [];
      dbSubcats = dbData.subcategories;
    } catch (err) {
      console.error(`Error loading ${cat.slug} from IndexedDB:`, err);
    }

    // 3. Fusionar: usar la fuente que tenga más archivos, o combinar ambas
    //    eliminando duplicados por nombre de archivo
    const mergeFiles = (a: ResourceFile[], b: ResourceFile[]): ResourceFile[] => {
      const seen = new Set(a.map(f => f.name));
      return [...a, ...b.filter(f => !seen.has(f.name))];
    };
    const mergeSubcats = (a?: SubCategory[], b?: SubCategory[]): SubCategory[] | undefined => {
      if (!a?.length && !b?.length) return undefined;
      if (!a?.length) return b;
      if (!b?.length) return a;
      const map = new Map<string, ResourceFile[]>();
      for (const sc of a) map.set(sc.name, [...sc.files]);
      for (const sc of b) {
        const existing = map.get(sc.name);
        if (existing) {
          const seen = new Set(existing.map(f => f.name));
          existing.push(...sc.files.filter(f => !seen.has(f.name)));
        } else {
          map.set(sc.name, [...sc.files]);
        }
      }
      return Array.from(map.entries()).map(([name, files]) => ({ name, files }));
    };

    const mergedFiles = mergeFiles(staticFiles, dbFiles);
    const mergedSubcats = mergeSubcats(staticSubcats, dbSubcats);

    categories.push({
      name: cat.name,
      slug: cat.slug,
      files: mergedFiles,
      subcategories: mergedSubcats,
    });
  }

  // Compute the set of resource files stored in IndexedDB (for delete buttons)
  const RESOURCE_SLUGS = ['Examenes', 'Resumenes', 'Practica'];
  const allStored = await listStoredPdfs(subjectId);
  const dbSet = new Set(allStored.filter(f => RESOURCE_SLUGS.some(slug => f.startsWith(`${slug}/`))));
  setResourceDbFiles(dbSet);

  // ── 4. Añadir categoría "Temas" con los PDFs vinculados a temas ──
  const currentTopics = topics
    .filter((t) => t.subjectId === subjectId && t.pdfFilename)
    .sort((a, b) => a.title.localeCompare(b.title, 'es', { numeric: true }));

  if (currentTopics.length > 0) {
    const temaFiles: ResourceFile[] = currentTopics.map((t) => ({
      name: t.pdfFilename!,
      path: t.pdfFilename!,
      type: 'pdf',
      topicId: t.id,
    }));
    // Insertar al principio
    categories.unshift({
      name: 'Temas',
      slug: 'Temas',
      files: temaFiles,
      subcategories: undefined,
    });
  }

  setResources(categories);
  setResourcesLoading(false);
};

// ── Upload resources to IndexedDB / FSA ──────────────────────────────────
const handleResourceUpload = async (categorySlug: string, files: FileList) => {
  if (!subjectId) return;
  const totalSize = Array.from(files).reduce((sum, f) => sum + f.size, 0);
  const quota = await checkStorageQuota(totalSize);
  if (!quota.ok) {
    setStorageAlert({
      msg: `No hay espacio suficiente en el navegador para estos archivos (${(totalSize / 1024 / 1024).toFixed(1)} MB necesarios, ${(quota.availableBytes / 1024 / 1024).toFixed(0)} MB libres).`,
      suggestFsa: isFsaSupported() && !quota.fsaConfigured,
    });
    return;
  }
  if (!quota.fsaConfigured && quota.percentUsed > 80) {
    setStorageAlert({
      msg: `Almacenamiento al ${Math.round(quota.percentUsed)}%. Los archivos se subirán pero puede que quede poco espacio.`,
      suggestFsa: isFsaSupported(),
    });
    // No bloqueamos — dejamos subir con la advertencia visible
  }
  for (const file of Array.from(files)) {
    const prefixedFilename = `${categorySlug}/${file.name}`;
    await savePdfBlob(subjectId, prefixedFilename, file);
  }
  await loadResources();
};

const handleResourceDelete = async (categorySlug: string, filename: string) => {
  if (!subjectId) return;
  const prefixedFilename = `${categorySlug}/${filename}`;
  await deleteStoredPdf(subjectId, prefixedFilename);
  await loadResources();
};

  // Limpiar blob URL al cerrar el modal
  useEffect(() => {
    if (!viewPdfTopic) {
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
        activeObjectUrlRef.current = null;
      }
      setViewPdfUrl(null);
    }
  }, [viewPdfTopic]);

  if (!subject) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="text-ink-500 text-center">
          <p className="font-display text-xl mb-4">Asignatura no encontrada</p>
          <Button onClick={() => navigate('/')}>← Inicio</Button>
        </div>
      </div>
    );
  }

  const subjectTopics = topics
  .filter((t) => t.subjectId === subjectId)
  .sort((a, b) => a.title.localeCompare(b.title, 'es', { numeric: true }));
  const subjectQuestions = questions.filter((q) => q.subjectId === subjectId);

  const filteredQuestions = subjectQuestions.filter((q) => {
    if (searchText.trim()) {
      const terms = searchText.toLowerCase().split(/\s+/);
      const hay = [
        q.prompt,
        q.explanation ?? '',
        q.modelAnswer ?? '',
        ...(q.tags ?? []),
        ...(q.options?.map(o => o.text) ?? []),
      ].join(' ').toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    if (filterTopic === '__none__') {
      const topicIds = new Set(subjectTopics.map((t) => t.id));
      const hasValidTopic = (q.topicId && topicIds.has(q.topicId)) || (q.topicIds ?? []).some((id) => topicIds.has(id));
      if (hasValidTopic) return false;
    } else if (filterTopic && !questionBelongsToTopic(q, filterTopic)) return false;
    if (filterType && q.type !== filterType) return false;
    if (filterOrigin && q.origin !== filterOrigin) return false;
    // D3: Filter by author
    if (filterAuthor === '__mine__') { if (q.createdBy !== settings?.alias) return false; }
    else if (filterAuthor && q.createdBy !== filterAuthor) return false;
    if (filterText) {
      const text = filterText.toLowerCase();
      if (!q.prompt.toLowerCase().includes(text) && !(q.tags ?? []).join(' ').toLowerCase().includes(text))
        return false;
    }
    return true;
  });

  // ── Guardar PDF (drag drop o file input) ──────────────────────────────────
  const handlePdfFile = async (topic: Topic, file: File) => {
    if (!subjectId || file.type !== 'application/pdf') return;

    // Comprobar quota antes de subir
    const quota = await checkStorageQuota(file.size);
    if (!quota.ok) {
      setStorageAlert({
        msg: `Sin espacio para guardar el PDF (${(file.size / 1024 / 1024).toFixed(1)} MB), solo quedan ${(quota.availableBytes / 1024 / 1024).toFixed(0)} MB libres en el navegador.`,
        suggestFsa: isFsaSupported() && !quota.fsaConfigured,
      });
      return;
    }
    if (!quota.fsaConfigured && quota.percentUsed > 80) {
      setStorageAlert({
        msg: `Almacenamiento al ${Math.round(quota.percentUsed)}%. El PDF se guardará pero queda poco espacio.`,
        suggestFsa: isFsaSupported(),
      });
    }

    setUploading(topic.id);
    try {
      await Promise.all([
        savePdfBlob(subjectId, file.name, file),
        savePdfToServer(subject.name, file.name, file, topic.title),
      ]);
      await updateTopic(topic.id, { pdfFilename: file.name });
      await refreshPdfList();
    } finally {
      setUploading(null);
      setDraggingOver(null);
    }
  };

  // ── Abrir visor PDF ────────────────────────────────────────────────────────
  const openViewPdf = async (t: Topic) => {
    if (!t.pdfFilename || !subjectId) return;
    // Intentar blob URL (IndexedDB primero)
    let url = await getPdfBlobUrl(subjectId, t.pdfFilename);
    if (url) {
      activeObjectUrlRef.current = url;
    } else {
      // Fallback a recursos estáticos
      url = getPdfUrl(subject.name, t.pdfFilename);
    }
    setViewPdfUrl(url);
    setViewPdfTopic(t);
  };

  // ── Eliminar PDF de un tema ────────────────────────────────────────────────
  const removePdf = async (t: Topic) => {
    if (!subjectId || !t.pdfFilename) return;
    if (!confirm(`¿Quitar el PDF "${t.pdfFilename}" del tema? (También se borra del almacenamiento local)`)) return;
    await deleteStoredPdf(subjectId, t.pdfFilename);
    await updateTopic(t.id, { pdfFilename: undefined });
    await refreshPdfList();
  };

  // ── Topic modal ────────────────────────────────────────────────────────────
  const handleTopicSave = async () => {
    if (!topicTitle.trim() || !subjectId) return;
    if (editingTopic) {
      await updateTopic(editingTopic.id, { title: topicTitle });
    } else {
      await createTopic({ subjectId, title: topicTitle, order: subjectTopics.length });
    }
    setTopicModal(false);
    setTopicTitle('');
    setEditingTopic(null);
  };

  const handleQuestionSave = async (data: Omit<Question, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'contentHash'>) => {
    if (editingQuestion) {
      await updateQuestion(editingQuestion.id, data);
    } else {
      await createQuestion(data);
    }
    setQuestionModal(false);
    setEditingQuestion(null);
  };

  const openEditTopic = (t: Topic) => {
    setEditingTopic(t);
    setTopicTitle(t.title);
    setTopicModal(true);
  };

  const totalStats = subjectQuestions.reduce(
    (acc, q) => ({
      seen: acc.seen + q.stats.seen,
      correct: acc.correct + q.stats.correct,
      wrong: acc.wrong + q.stats.wrong,
    }),
    { seen: 0, correct: 0, wrong: 0 }
  );

  const subjectExams = exams.filter((e) => e.subjectId === subjectId);

  // Items for contribution pack export (optionally filtered to current user's questions)
  const contribItems = contribOnlyMine && settings?.alias
    ? filteredQuestions.filter((q) => q.createdBy === settings.alias)
    : filteredQuestions;

  const tabs = [
    { id: 'topics', label: 'Temas' },
    { id: 'questions', label: `Preguntas (${subjectQuestions.length})` },
    { id: 'practice', label: 'Practicar' },
    { id: 'exams', label: `Exámenes (${subjectExams.length})` },
    { id: 'resources', label: 'Otros recursos' },
    { id: 'concepts', label: 'Conceptos clave' },
    ...(gptLinks.length > 0 ? [{ id: 'chatbots', label: 'Chatbots' }] : []),
    { id: 'ia', label: 'IA' },
  ];

  // B2: Reorder topics via drag & drop
  const handleTopicReorder = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const reordered = [...subjectTopics];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    // Update order for all affected topics
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].order !== i) {
        await updateTopic(reordered[i].id, { order: i });
      }
    }
    // Reload to reflect new order
    if (subjectId) await loadTopics(subjectId);
  };

  const handleStatsClick = () => {
    navigate(`/subject/${subjectId}/stats`);
  };

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
      <header className="border-b border-ink-800 bg-ink-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <button onClick={() => navigate('/')} className="text-ink-400 hover:text-ink-200 transition-colors text-sm flex-shrink-0">
                ←
              </button>
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: subject.color ?? '#f59e0b' }} />
              <h1 className="font-display text-lg sm:text-xl text-ink-100 truncate">{subject.name}</h1>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              <CopyLinkButton subjectId={subjectId} tab={tab} />
              {hoard && (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/subject/${subjectId}/notebook`)} title="Cuaderno: fuentes, chat con citas, guías y tutor (Hypatia)">
                  <span className="sm:hidden">📓</span>
                  <span className="hidden sm:inline">📓 Cuaderno</span>
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={handleStatsClick}>
                <span className="sm:hidden">📊</span>
                <span className="hidden sm:inline">📊 Estadísticas</span>
              </Button>
            </div>
          </div>
          <div className="mt-3">
            <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-4 sm:px-6 py-4 sm:py-6 gap-4">

        {/* TEMAS */}
        {tab === 'topics' && (
          <div className="flex flex-col gap-4">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => { setEditingTopic(null); setTopicTitle(''); setTopicModal(true); }}>
                + Nuevo tema
              </Button>
            </div>
            {subjectTopics.length === 0 ? (
              <EmptyState icon={<span>📚</span>} title="Sin temas" description="Crea un tema para organizar tus preguntas" />
            ) : (
              <div className="flex flex-col gap-2">
                {subjectTopics.map((t, tIdx) => {
                  const qs = subjectQuestions.filter((q) => questionBelongsToTopic(q, t.id));
                  const isDragging = draggingOver === t.id;
                  const isUploading = uploading === t.id;
                  const isReorderTarget = reorderOverIdx === tIdx && reorderDragIdx !== tIdx;

                  return (
                    <div
                      key={t.id}
                      onDragOver={(e: React.DragEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // If this is a reorder drag (no files), set reorder target
                        if (reorderDragIdx != null) {
                          setReorderOverIdx(tIdx);
                        } else {
                          setDraggingOver(t.id);
                        }
                      }}
                      onDragLeave={(e: React.DragEvent) => {
                        e.stopPropagation();
                        if (reorderDragIdx != null) setReorderOverIdx(null);
                        else setDraggingOver(null);
                      }}
                      onDrop={(e: React.DragEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (reorderDragIdx != null) {
                          handleTopicReorder(reorderDragIdx, tIdx);
                          setReorderDragIdx(null);
                          setReorderOverIdx(null);
                          return;
                        }
                        const file = e.dataTransfer.files[0];
                        if (file) handlePdfFile(t, file);
                      }}
                    >
                    <Card
                      className={`group transition-all ${isDragging ? 'border-amber-500/60 bg-amber-500/5 ring-1 ring-amber-500/30' : ''} ${isReorderTarget ? 'border-sage-500/60 bg-sage-500/5 ring-1 ring-sage-500/30' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        {/* B2: Drag handle for reordering */}
                        <span
                          draggable
                          onDragStart={(e) => {
                            e.stopPropagation();
                            setReorderDragIdx(tIdx);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragEnd={() => { setReorderDragIdx(null); setReorderOverIdx(null); }}
                          className="cursor-grab active:cursor-grabbing text-ink-600 hover:text-ink-400 transition-colors select-none text-sm flex-shrink-0"
                          title="Arrastra para reordenar"
                        >
                          ⠿
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-ink-100">{t.title}</p>
                          <div className="mt-0.5">
                            <div className="flex items-center justify-between text-xs text-ink-500">
                              <span>{qs.length} preguntas</span>
                              <span className={`font-medium ${(() => { const seen = qs.filter(q => q.stats.seen > 0).length; const seenPct = qs.length === 0 ? 0 : Math.round((seen / qs.length) * 100); return seenPct === 100 ? 'text-sage-400' : seenPct > 0 ? 'text-amber-400' : 'text-ink-600'; })()}`}>
                                {qs.filter(q => q.stats.seen > 0).length}/{qs.length} vistas
                              </span>
                            </div>
                            {qs.length > 0 && (() => {
                              const seen = qs.filter(q => q.stats.seen > 0).length;
                              const seenPct = Math.round((seen / qs.length) * 100);
                              return (
                                <div className="h-1.5 bg-ink-700 rounded-full overflow-hidden mt-1">
                                  <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                      seenPct === 100 ? 'bg-sage-500' : 'bg-amber-500'
                                    }`}
                                    style={{ width: `${seenPct}%` }}
                                  />
                                </div>
                              );
                            })()}
                          </div>

                          {/* PDF adjunto */}
                          {isUploading ? (
                            <p className="mt-2 text-xs text-amber-400 animate-pulse">⏳ Guardando PDF…</p>
                          ) : t.pdfFilename ? (
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className="text-xs text-ink-400 flex items-center gap-1">
                                📄 <span className="truncate max-w-[200px]" title={t.pdfFilename}>{t.pdfFilename}</span>
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); openViewPdf(t); }}
                                className="text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300 transition-all font-medium px-2 py-0.5 rounded-md"
                              >
                                👁 Ver PDF
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/subject/${subjectId}/listen/${t.id}`);
                                }}
                                className="text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 hover:text-blue-300 transition-all font-medium px-2 py-0.5 rounded-md flex items-center gap-1"
                              >
                                🎧 Escuchar
                                <WavStatusIcon topicId={t.id} synthesisJobs={synthesisJobs} />
                              </button>
                              <label
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-700 transition-all px-1.5 py-0.5 rounded cursor-pointer"
                                title="Cambiar PDF"
                              >
                                ✎ Cambiar
                                <input
                                  type="file"
                                  accept="application/pdf"
                                  className="hidden"
                                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfFile(t, f); e.target.value = ''; }}
                                />
                              </label>
                              <button
                                onClick={(e) => { e.stopPropagation(); removePdf(t); }}
                                className="text-xs text-rose-500/50 hover:text-rose-400 hover:bg-ink-700 transition-all px-1.5 py-0.5 rounded"
                                title="Quitar PDF"
                              >
                                ✕
                              </button>
                            </div>
                          ) : isDragging ? (
                            <p className="mt-2 text-xs text-amber-400 font-medium">Suelta el PDF aquí</p>
                          ) : (
                            <label
                              onClick={(e) => e.stopPropagation()}
                              className="mt-2 text-xs text-amber-500/60 hover:text-amber-400 flex items-center gap-1.5 px-2 py-1 rounded-md border border-dashed border-amber-500/25 hover:border-amber-500/50 hover:bg-amber-500/5 w-fit transition-all cursor-pointer"
                            >
                              📎 Añadir PDF <span className="text-ink-600">(arrastra o haz clic)</span>
                              <input
                                type="file"
                                accept="application/pdf"
                                className="hidden"
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfFile(t, f); e.target.value = ''; }}
                              />
                            </label>
                          )}
                        </div>

                        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <Button size="sm" variant="ghost" onClick={() => navigate(`/subject/${subjectId}/read/${t.id}`)} title="Lectura rápida">📖</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setFilterTopic(t.id); setTab('questions'); }}>Ver</Button>
                          <Button size="sm" variant="ghost" onClick={() => openEditTopic(t)}>✎</Button>
                          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`¿Eliminar "${t.title}" y sus preguntas?`)) deleteTopic(t.id); }}>
                            <span className="text-rose-400">✕</span>
                          </Button>
                        </div>
                      </div>
                    </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* PREGUNTAS */}
        {tab === 'questions' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <StatsSummary seen={totalStats.seen} correct={totalStats.correct} wrong={totalStats.wrong} />
              <div className="flex items-center gap-2">
                <Button size="sm" variant={questionView === 'card' ? 'primary' : 'ghost'} onClick={() => setQuestionView('card')} title="Vista tarjeta">⊟</Button>
                <Button size="sm" variant={questionView === 'list' ? 'primary' : 'ghost'} onClick={() => setQuestionView('list')} title="Vista lista densa">≡</Button>
                {/* Import contribution pack — siempre visible (incl. asignatura vacía) */}
                {!selectMode && (
                  <label className="cursor-pointer" title="Importar contribution pack JSON directamente en esta asignatura">
                    <input type="file" accept=".json" className="hidden" onChange={handleSubjectPackFile} />
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg font-medium font-body transition-all text-ink-300 hover:text-ink-100 hover:bg-ink-800 cursor-pointer">
                      ↓ Pack
                    </span>
                  </label>
                )}
                <Button size="sm" onClick={() => { setEditingQuestion(null); setQuestionModal(true); }}>+ Nueva pregunta</Button>
              </div>
            </div>
            {subjectQuestions.length > 0 && (
              <div className="flex flex-col gap-3">
                <input
                  type="search"
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder="Buscar en preguntas..."
                  className="w-full bg-ink-900 border border-ink-700 rounded-xl px-4 py-2.5 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-amber-500"
                />
                <div className="flex gap-3 flex-wrap">
                  <Select value={filterTopic} onChange={(e) => setFilterTopic(e.target.value)} className="text-xs py-1.5">
                  <option value="">Todos los temas</option>
                  <option value="__none__">Sin tema asignado</option>
                  {subjectTopics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                </Select>
                <Select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="text-xs py-1.5">
                  <option value="">Todos los tipos</option>
                  <option value="TEST">Test</option>
                  <option value="DESARROLLO">Desarrollo</option>
                  <option value="COMPLETAR">Completar</option>
                  <option value="PRACTICO">Práctico</option>
                </Select>
                <Select value={filterOrigin} onChange={(e) => setFilterOrigin(e.target.value)} className="text-xs py-1.5">
                  <option value="">Todos los orígenes</option>
                  <option value="test">Test / Práctica</option>
                  <option value="examen_anterior">Examen anterior</option>
                  <option value="clase">Clase</option>
                  <option value="alumno">Alumno</option>
                </Select>
                {/* D3: Author filter */}
                {(() => {
                  const authors = [...new Set(subjectQuestions.map((q) => q.createdBy).filter(Boolean))] as string[];
                  return authors.length > 0 ? (
                    <Select value={filterAuthor} onChange={(e) => setFilterAuthor(e.target.value)} className="text-xs py-1.5">
                      <option value="">Todos los autores</option>
                      <option value="__mine__">Mis preguntas</option>
                      {authors.map((a) => <option key={a} value={a}>{a}</option>)}
                    </Select>
                  ) : null;
                })()}
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Buscar..."
                  className="bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-1.5 text-sm font-body placeholder:text-ink-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
                {(searchText || filterTopic || filterType || filterOrigin || filterText || filterAuthor) && (
                  <Button size="sm" variant="ghost" onClick={() => { setSearchText(''); setFilterTopic(''); setFilterType(''); setFilterOrigin(''); setFilterText(''); setFilterAuthor(''); }}>
                    × Limpiar
                  </Button>
                )}
                {/* PDF Export */}
                {filteredQuestions.length > 0 && !selectMode && (
                  <Button size="sm" variant="ghost" onClick={() => setPdfExportOpen(true)} title="Exportar preguntas como PDF">
                    PDF
                  </Button>
                )}
                {/* Contribution Pack export */}
                {filteredQuestions.length > 0 && !selectMode && (
                  <>
                    <label className="flex items-center gap-1 cursor-pointer" title="Solo exportar mis preguntas (por alias)">
                      <input
                        type="checkbox"
                        checked={contribOnlyMine}
                        onChange={(e) => setContribOnlyMine(e.target.checked)}
                        className="accent-amber-500 w-3 h-3"
                      />
                      <span className="text-xs text-ink-500">Mías</span>
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setContribExportOpen(true)}
                      title="Exportar como Contribution Pack JSON para compartir"
                    >
                      ↑ Pack ({contribItems.length})
                    </Button>
                  </>
                )}
                {/* Anki export */}
                {filteredQuestions.length > 0 && !selectMode && (
                  <Button size="sm" variant="ghost" onClick={() => setAnkiExportOpen(true)} title="Exportar preguntas para importar en Anki">
                    Anki
                  </Button>
                )}
                {/* C2: Selection mode toggle */}
                <Button
                  size="sm"
                  variant={selectMode ? 'primary' : 'ghost'}
                  onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); setBulkTopicId(''); setBulkTag(''); }}
                >
                  {selectMode ? '✕ Cancelar selección' : '☐ Seleccionar'}
                </Button>
                </div>
              </div>
            )}
            {subjectQuestions.length === 0 ? (
              <EmptyState icon={<span>❓</span>} title="Sin preguntas" description="Añade preguntas para empezar a practicar" />
            ) : filteredQuestions.length === 0 ? (
              <EmptyState icon={<span>🔍</span>} title="Sin resultados" description="Prueba otros filtros" />
            ) : questionView === 'list' ? (
              <div className="flex flex-col gap-0.5">
                {filteredQuestions.map((q) => {
                  const topic = subjectTopics.find((t) => t.id === q.topicId);
                  return (
                    <div
                      key={q.id}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent hover:border-ink-700 hover:bg-ink-800/40 cursor-pointer transition-all text-sm group ${selectMode && selectedIds.has(q.id) ? 'bg-amber-500/10 border-amber-500/30' : ''}`}
                      onClick={() => selectMode ? setSelectedIds((prev) => { const next = new Set(prev); next.has(q.id) ? next.delete(q.id) : next.add(q.id); return next; }) : setPreviewQuestion(q)}
                    >
                      {selectMode && (
                        <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => {}} className="accent-amber-500 flex-shrink-0" onClick={(e) => e.stopPropagation()} />
                      )}
                      <TypeBadge type={q.type} />
                      {topic && <span className="text-xs text-ink-500 flex-shrink-0 hidden sm:inline">{topic.title}</span>}
                      <p className="flex-1 truncate text-ink-200">{q.prompt}</p>
                      {q.starred && <span className="text-amber-400 text-xs flex-shrink-0">★</span>}
                      {q.notes && <span className="text-xs text-ink-600 flex-shrink-0">📝</span>}
                      <span className="text-xs text-ink-600 flex-shrink-0 hidden sm:inline">
                        {q.stats.seen > 0 ? `${Math.round(q.stats.correct / q.stats.seen * 100)}%` : '–'}
                      </span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 flex-shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); setEditingQuestion(q); setQuestionModal(true); }} className="text-xs text-ink-600 hover:text-amber-400 px-1">✎</button>
                        <button onClick={(e) => { e.stopPropagation(); if (confirm('¿Eliminar?')) deleteQuestion(q.id); }} className="text-xs text-rose-600 hover:text-rose-400 px-1">✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filteredQuestions.map((q) => {
                  const topic = subjectTopics.find((t) => t.id === q.topicId);
                  const extraTopics = q.topicIds?.length
                    ? q.topicIds.filter((id) => id !== q.topicId).map((id) => subjectTopics.find((t) => t.id === id)).filter(Boolean)
                    : [];
                  return (
                    <Card key={q.id} className="group cursor-pointer" onClick={() => selectMode ? setSelectedIds((prev) => { const next = new Set(prev); next.has(q.id) ? next.delete(q.id) : next.add(q.id); return next; }) : setPreviewQuestion(q)}>
                       <div className="flex items-start gap-3">
                        {/* C2: Selection checkbox */}
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(q.id)}
                            onChange={() => {}}
                            className="mt-1 accent-amber-500 flex-shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1.5">
                            <TypeBadge type={q.type} />
                            {q.origin && <Badge color={ORIGIN_COLORS[q.origin]}>{ORIGIN_LABELS[q.origin]}</Badge>}
                            {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                            {!topic && filterTopic === '__none__' && (
                              <select
                                onClick={(e) => e.stopPropagation()}
                                onChange={async (e) => {
                                  e.stopPropagation();
                                  if (e.target.value) {
                                    await updateQuestion(q.id, { topicId: e.target.value });
                                  }
                                }}
                                className="text-[10px] bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded px-1 py-0.5 cursor-pointer"
                                defaultValue=""
                              >
                                <option value="" disabled>Asignar tema</option>
                                {subjectTopics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                              </select>
                            )}
                            {extraTopics.map((et) => (
                              <span key={et!.id} className="text-xs text-ink-600">+{et!.title}</span>
                            ))}
                            <Difficulty level={q.difficulty} />
                            {(q.tags ?? []).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                            {/* A5: indicador ★ siempre visible para preguntas marcadas */}
                            {q.starred && <span className="text-amber-400 text-xs">★</span>}
                            {/* A4: indicador de nota personal */}
                            {q.notes && <span className="text-xs text-ink-600" title="Tiene notas personales">📝</span>}
                          </div>
                          <p className="text-sm text-ink-200 line-clamp-2">{q.prompt}</p>
                          <div className="mt-2">
                            <StatsSummary seen={q.stats.seen} correct={q.stats.correct} wrong={q.stats.wrong} />
                          </div>
                        </div>
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          {/* A5: Botón ★ para marcar como difícil */}
                          <button
                            onClick={(e) => { e.stopPropagation(); updateQuestion(q.id, { starred: !q.starred }); }}
                            className={`text-base px-1.5 py-0.5 rounded transition-colors ${q.starred ? 'text-amber-400' : 'text-ink-600 hover:text-amber-400'}`}
                            title={q.starred ? 'Quitar de difíciles' : 'Marcar como difícil'}
                          >
                            {q.starred ? '★' : '☆'}
                          </button>
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEditingQuestion(q); setQuestionModal(true); }} title="Editar">✎</Button>
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); duplicateQuestion(q.id); }} title="Duplicar">⧉</Button>
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); if (confirm('¿Eliminar pregunta?')) deleteQuestion(q.id); }} title="Eliminar">
                            <span className="text-rose-400">✕</span>
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* C2: Selection action bar (extended) */}
            {selectMode && selectedIds.size > 0 && (
              <div className="sticky bottom-0 bg-ink-900/95 border border-amber-500/30 rounded-xl p-3 mt-4 backdrop-blur-sm flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-300">
                    {selectedIds.size} pregunta{selectedIds.size !== 1 ? 's' : ''} seleccionada{selectedIds.size !== 1 ? 's' : ''}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set(filteredQuestions.map((q) => q.id)))}>
                    Seleccionar todas
                  </Button>
                </div>
                <div className="flex gap-2 flex-wrap items-center">
                  {/* Export pack */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        const pack = await exportContributionPackByIds(settings.alias ?? '', [...selectedIds]);
                        downloadJSON(pack, `contribution-selection-${new Date().toISOString().slice(0, 10)}.json`);
                        setSelectMode(false);
                        setSelectedIds(new Set());
                      } catch (err) {
                        alert('Error al exportar: ' + String(err));
                      }
                    }}
                  >
                    ↑ Exportar pack
                  </Button>
                  {/* Bulk delete */}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm(`¿Eliminar las ${selectedIds.size} preguntas seleccionadas? Esta acción no se puede deshacer.`)) return;
                      for (const id of selectedIds) {
                        await deleteQuestion(id);
                      }
                      setSelectMode(false);
                      setSelectedIds(new Set());
                    }}
                  >
                    <span className="text-rose-400">✕ Borrar ({selectedIds.size})</span>
                  </Button>
                  {/* Bulk assign topic */}
                  <select
                    value={bulkTopicId}
                    onChange={(e) => setBulkTopicId(e.target.value)}
                    className="bg-ink-800 border border-ink-600 text-ink-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-amber-500 cursor-pointer"
                  >
                    <option value="">Asignar tema…</option>
                    {subjectTopics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                  {bulkTopicId && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        for (const id of selectedIds) {
                          await updateQuestion(id, { topicId: bulkTopicId });
                        }
                        setBulkTopicId('');
                        setSelectMode(false);
                        setSelectedIds(new Set());
                      }}
                    >
                      ✓ Asignar
                    </Button>
                  )}
                  {/* Bulk add tag */}
                  <input
                    type="text"
                    value={bulkTag}
                    onChange={(e) => setBulkTag(e.target.value)}
                    placeholder="Añadir tag…"
                    className="bg-ink-800 border border-ink-600 text-ink-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-amber-500 w-28"
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && bulkTag.trim()) {
                        const tag = bulkTag.trim();
                        for (const id of selectedIds) {
                          const q = subjectQuestions.find((q) => q.id === id);
                          if (q) await updateQuestion(id, { tags: [...new Set([...(q.tags ?? []), tag])] });
                        }
                        setBulkTag('');
                        setSelectMode(false);
                        setSelectedIds(new Set());
                      }
                    }}
                  />
                  {bulkTag.trim() && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        const tag = bulkTag.trim();
                        for (const id of selectedIds) {
                          const q = subjectQuestions.find((q) => q.id === id);
                          if (q) await updateQuestion(id, { tags: [...new Set([...(q.tags ?? []), tag])] });
                        }
                        setBulkTag('');
                        setSelectMode(false);
                        setSelectedIds(new Set());
                      }}
                    >
                      + Tag
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* PDF Export modal for questions */}
        <PdfExportModal
          open={pdfExportOpen}
          onClose={() => { setPdfExportOpen(false); setPdfOriginFilter(''); }}
          title="Exportar preguntas como PDF"
          items={pdfOriginFilter ? filteredQuestions.filter((q) => q.origin === pdfOriginFilter) : filteredQuestions}
          getId={(q) => q.id}
          groupBy={(q) => TYPE_LABELS_MAP[q.type] ?? q.type}
          groupOrder={['Test', 'Desarrollo', 'Completar', 'Práctico']}
          renderFilters={() => (
            <div>
              <p className="text-xs font-medium text-ink-400 uppercase tracking-widest mb-1.5">Filtrar por origen</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { value: '', label: 'Todos' },
                  { value: 'test', label: 'Test / Práctica' },
                  { value: 'examen_anterior', label: 'Examen anterior' },
                  { value: 'clase', label: 'Clase' },
                  { value: 'alumno', label: 'Alumno' },
                ].map(({ value, label }) => {
                  const active = pdfOriginFilter === value;
                  const count = value
                    ? filteredQuestions.filter((q) => q.origin === value).length
                    : filteredQuestions.length;
                  return (
                    <button
                      key={value}
                      onClick={() => setPdfOriginFilter(value)}
                      className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${
                        active
                          ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                          : 'bg-ink-800 border-ink-700 text-ink-400 hover:border-ink-500'
                      }`}
                    >
                      {label} <span className="opacity-60">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          renderItem={(q) => {
            const topic = subjectTopics.find((t) => t.id === q.topicId);
            return (
              <div>
                <div className="flex items-center gap-2">
                  <TypeBadge type={q.type} />
                  {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                  {q.origin && <span className="text-[10px] text-ink-500 bg-ink-800 px-1.5 py-0.5 rounded">{ORIGIN_LABELS[q.origin]}</span>}
                </div>
                <p className="text-xs text-ink-200 mt-0.5 line-clamp-2">{q.prompt}</p>
              </div>
            );
          }}
          onExport={async (selIds) => {
            const exportQuestions = pdfOriginFilter
              ? filteredQuestions.filter((q) => q.origin === pdfOriginFilter)
              : filteredQuestions;
            const blob = await generateQuestionsPDF(
              exportQuestions,
              subjectTopics,
              subject?.name ?? '',
              selIds,
            );
            downloadBlob(blob, `preguntas-${subject?.name ?? 'export'}.pdf`);
          }}
        />

        {/* Contribution Pack Export modal */}
        <PdfExportModal
          open={contribExportOpen}
          onClose={() => setContribExportOpen(false)}
          title={`Exportar Contribution Pack${contribOnlyMine && settings?.alias ? ` · solo de "${settings.alias}"` : ''}`}
          items={contribItems}
          getId={(q) => q.id}
          groupBy={(q) => subjectTopics.find((t) => t.id === q.topicId)?.title ?? 'Sin tema'}
          groupOrder={subjectTopics.map((t) => t.title)}
          renderItem={(q) => {
            const topic = subjectTopics.find((t) => t.id === q.topicId);
            return (
              <div>
                <div className="flex items-center gap-2">
                  <TypeBadge type={q.type} />
                  {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                  {q.createdBy && <span className="text-xs text-ink-600 italic">by {q.createdBy}</span>}
                </div>
                <p className="text-xs text-ink-200 mt-0.5 line-clamp-2">{q.prompt}</p>
              </div>
            );
          }}
          onExport={async (selIds) => {
            const date = new Date().toISOString().slice(0, 10);
            const pack = await exportContributionPackByIds(settings?.alias ?? '', [...selIds]);
            downloadJSON(pack, `contribution-${settings?.alias || 'pack'}-${subject?.name?.slice(0, 20).replace(/\s+/g, '-') ?? 'subject'}-${date}.json`);
          }}
        />

        {/* Anki Export modal */}
        <PdfExportModal
          open={ankiExportOpen}
          onClose={() => setAnkiExportOpen(false)}
          title="Exportar para Anki (.txt TSV)"
          items={filteredQuestions}
          getId={(q) => q.id}
          groupBy={(q) => subjectTopics.find((t) => t.id === q.topicId)?.title ?? 'Sin tema'}
          groupOrder={subjectTopics.map((t) => t.title)}
          renderItem={(q) => {
            const topic = subjectTopics.find((t) => t.id === q.topicId);
            return (
              <div>
                <div className="flex items-center gap-2">
                  <TypeBadge type={q.type} />
                  {topic && <span className="text-xs text-ink-500">{topic.title}</span>}
                </div>
                <p className="text-xs text-ink-200 mt-0.5 line-clamp-2">{q.prompt}</p>
              </div>
            );
          }}
          onExport={async (selIds) => {
            const content = exportToAnkiTsv(filteredQuestions, subjectTopics, subject?.name ?? 'ExamCoach', selIds);
            downloadAnkiFile(content, `anki-${subject?.name?.replace(/\s+/g, '-') ?? 'export'}.txt`);
          }}
        />

        {/* Subject-level contribution pack import modal */}
        {subjectPackPreview && (
          <Modal
            open={!!subjectPackPreview}
            onClose={() => { setSubjectPackPreview(null); setSubjectImportMsg(''); }}
            title="Vista previa del Contribution Pack"
            size="lg"
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <p className="text-sm text-ink-500 uppercase tracking-widest">Autor</p>
                    <p className="text-base text-ink-100 font-medium">{subjectPackPreview.createdBy}</p>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-ink-500 uppercase tracking-widest">Exportado</p>
                    <p className="text-base text-ink-100 font-medium">
                      {new Date(subjectPackPreview.exportedAt).toLocaleDateString('es-ES')}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Card className="text-center py-3">
                    <p className="text-2xl font-display text-amber-400">{subjectPackPreview.topicsCount}</p>
                    <p className="text-xs text-ink-500 mt-1">Temas</p>
                  </Card>
                  <Card className="text-center py-3">
                    <p className="text-2xl font-display text-sage-400">{subjectPackPreview.questionsCount}</p>
                    <p className="text-xs text-ink-500 mt-1">Total preguntas</p>
                  </Card>
                  <Card className="text-center py-3 border-sage-600/30">
                    <p className="text-2xl font-display text-sage-300">{subjectPackPreview.newQuestionsCount}</p>
                    <p className="text-xs text-ink-500 mt-1">Nuevas</p>
                  </Card>
                </div>

                {subjectPackPreview.alreadyImported && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                    <p className="text-sm text-amber-400">
                      ⚠ Este pack ya fue importado previamente.
                    </p>
                  </div>
                )}

                {/* Detailed per-topic breakdown table */}
                {subjectPackPreview.rows && subjectPackPreview.rows.length > 0 && (
                  <div>
                    <p className="text-sm text-ink-500 uppercase tracking-widest mb-2">Desglose por tema</p>
                    <div className="overflow-x-auto max-h-48 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-ink-700 text-ink-500 text-left">
                            <th className="pb-1.5 font-normal">Asignatura</th>
                            <th className="pb-1.5 font-normal">Tema</th>
                            <th className="pb-1.5 font-normal text-center">Preguntas</th>
                            <th className="pb-1.5 font-normal text-center">Nuevas</th>
                          </tr>
                        </thead>
                        <tbody>
                          {subjectPackPreview.rows.map((r: any, i: number) => (
                            <tr key={i} className="border-b border-ink-800 last:border-0">
                              <td className="py-1.5 text-ink-300">{r.subjectName}</td>
                              <td className="py-1.5 text-ink-300">{r.topicName}</td>
                              <td className="py-1.5 text-center text-ink-400">{r.questionsCount}</td>
                              <td className="py-1.5 text-center text-sage-400 font-medium">{r.newCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Clickable question list with preview */}
                {subjectPackPreview.questionsSampleFull.length > 0 && (
                  <div>
                    <p className="text-sm text-ink-500 uppercase tracking-widest mb-2">
                      Preguntas nuevas ({subjectPackPreview.questionsSampleFull.length})
                    </p>
                    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                      {subjectPackPreview.questionsSampleFull.map((q, i) => (
                        <button
                          key={q.id ?? i}
                          onClick={() => setSubjectPreviewSampleQuestion(q)}
                          className="w-full text-left group flex items-start gap-3 p-3 bg-ink-800 rounded-lg border border-ink-700 hover:border-ink-500 hover:bg-ink-750 transition-all duration-150 cursor-pointer"
                        >
                          <TypeBadge type={q.type} />
                          <span className="text-xs text-ink-300 group-hover:text-ink-100 transition-colors line-clamp-2 flex-1">
                            {q.prompt.replace(/[#*`]/g, '').trim()}
                          </span>
                          <span className="text-ink-600 group-hover:text-ink-400 text-xs flex-shrink-0 mt-0.5">›</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {subjectImportMsg && (
                <p className={`text-xs ${subjectImportMsg.startsWith('Error') ? 'text-rose-400' : 'text-sage-400'}`}>
                  {subjectImportMsg}
                </p>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-ink-800">
                <Button variant="ghost" onClick={() => { setSubjectPackPreview(null); setSubjectImportMsg(''); }}>
                  Cancelar
                </Button>
                <Button
                  disabled={subjectImporting || subjectPackPreview.newQuestionsCount === 0}
                  onClick={async () => {
                    setSubjectImporting(true);
                    try {
                      const result = await importContributionPack(subjectPackPreview.rawPack, undefined, subjectId);
                      if (result.alreadyImported) {
                        setSubjectImportMsg('ℹ Este pack ya fue importado anteriormente');
                      } else if (result.errors.length > 0) {
                        setSubjectImportMsg('Error: ' + result.errors[0]);
                      } else {
                        setSubjectImportMsg(`✓ ${result.newQuestions} preguntas importadas`);
                        if (subjectId) await loadQuestions(subjectId);
                        setTimeout(() => { setSubjectPackPreview(null); setSubjectImportMsg(''); }, 1800);
                      }
                    } catch (err) {
                      setSubjectImportMsg('Error: ' + String(err));
                    } finally {
                      setSubjectImporting(false);
                    }
                  }}
                >
                  {subjectImporting ? 'Importando...' : subjectPackPreview.newQuestionsCount > 0
                    ? `Importar ${subjectPackPreview.newQuestionsCount} preguntas nuevas`
                    : 'Sin preguntas nuevas'}
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {/* Modal preview pregunta individual (desde contribution pack en subject) */}
        {subjectPreviewSampleQuestion && (
          <Modal
            open={!!subjectPreviewSampleQuestion}
            onClose={() => setSubjectPreviewSampleQuestion(null)}
            title={subjectPreviewSampleQuestion.prompt.replace(/[#*`]/g, '').trim().slice(0, 60) + (subjectPreviewSampleQuestion.prompt.length > 60 ? '...' : '')}
            size="lg"
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2 flex-wrap">
                <TypeBadge type={subjectPreviewSampleQuestion.type} />
                {subjectPreviewSampleQuestion.difficulty && (
                  <span className="text-xs text-ink-500">{'★'.repeat(subjectPreviewSampleQuestion.difficulty)}</span>
                )}
              </div>
              <QuestionPreviewContent question={subjectPreviewSampleQuestion} />
              <div className="flex justify-end pt-2 border-t border-ink-800">
                <Button size="sm" variant="ghost" onClick={() => setSubjectPreviewSampleQuestion(null)}>
                  Cerrar
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {/* PRACTICAR */}
        {tab === 'practice' && (
          <PracticeConfig subjectId={subjectId!} topics={subjectTopics} questions={subjectQuestions} defaultTopicId={filterTopic} autostart={autostart} />
        )}

        {/* EXÁMENES */}
        {tab === 'exams' && subjectId && (
          <ExamsTab
            subjectId={subjectId}
            exams={subjectExams}
            questions={subjectQuestions}
            topics={subjectTopics}
            onCreate={createExam}
            onUpdate={updateExam}
            onDelete={deleteExam}
            onDuplicate={duplicateExam}
          />
        )}

        {/* OTROS RECURSOS */}
        {tab === 'resources' && (
          <ResourcesTab
            subject={subject}
            subjectId={subjectId!}
            resources={resources}
            loading={resourcesLoading}
            dbFiles={resourceDbFiles}
            onUpload={handleResourceUpload}
            onDelete={handleResourceDelete}
            synthesisJobs={synthesisJobs}
          />
        )}

        {tab === 'concepts' && (
          <KeyConceptsTab
            subjectId={subjectId!}
            concepts={keyConcepts}
            topics={subjectTopics}
            onCreate={async (data) => {
              await createKeyConcept({ subjectId: subjectId!, ...data });
            }}
            onUpdate={updateKeyConcept}
            onDelete={deleteKeyConcept}
            onReload={async () => { await loadKeyConcepts(subjectId!); }}
          />
        )}

        {tab === 'chatbots' && (
          <div className="flex flex-col gap-6">
            <p className="text-ink-400 text-sm">
              Chatbots personalizados con el contenido de esta asignatura. Se abren en ChatGPT en una nueva pestaña.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {gptLinks.map((link, i) => (
                <button
                  key={i}
                  onClick={() => window.open(link.url, '_blank')}
                  className="group flex items-start gap-4 p-5 rounded-xl border border-ink-800 bg-ink-900/50 hover:border-amber-500/40 hover:bg-ink-800/60 transition-all text-left"
                >
                  <span className="text-3xl flex-shrink-0 mt-0.5">🤖</span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-semibold text-ink-100 group-hover:text-amber-400 transition-colors">
                      {link.name}
                    </span>
                    {link.description && (
                      <span className="text-sm text-ink-400">{link.description}</span>
                    )}
                    <span className="text-xs text-ink-500 mt-1 truncate">{link.url}</span>
                  </div>
                  <span className="ml-auto text-ink-600 group-hover:text-amber-500 transition-colors flex-shrink-0 self-center">
                    ↗
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'ia' && subject && (
          <AIExtractionTab subject={subject} topics={subjectTopics} />
        )}
      </main>

      {/* Modal ver PDF */}
      <Modal
        open={!!viewPdfTopic && !!viewPdfUrl}
        onClose={() => setViewPdfTopic(null)}
        title={`${viewPdfTopic?.title ?? ''} — ${viewPdfTopic?.pdfFilename ?? ''}`}
        size="xl"
      >
        {viewPdfUrl && (
          <div className="h-[78vh]">
            <PdfViewer
              ref={topicPdfViewerRef}
              pdfList={[viewPdfTopic?.pdfFilename ?? '']}
              getPdfUrl={() => viewPdfUrl}
              initialPage={1}
              onTextSelected={(text) => {
                setPdfSelectedText(text);
                setCreateFromPdf(true);
              }}
            />
          </div>
        )}
      </Modal>

      {/* Modal editar tema */}
      <Modal open={topicModal} onClose={() => setTopicModal(false)} title={editingTopic ? 'Editar tema' : 'Nuevo tema'}>
        <div className="flex flex-col gap-4">
          <Input label="Título del tema" value={topicTitle} onChange={(e) => setTopicTitle(e.target.value)} placeholder="Ej: Tema 2 - Búsqueda" autoFocus />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setTopicModal(false)}>Cancelar</Button>
            <Button onClick={handleTopicSave} disabled={!topicTitle.trim()}>{editingTopic ? 'Guardar' : 'Crear tema'}</Button>
          </div>
        </div>
      </Modal>

      {/* Modal pregunta */}
      <Modal open={questionModal} onClose={() => { setQuestionModal(false); setEditingQuestion(null); }} title={editingQuestion ? 'Editar pregunta' : 'Nueva pregunta'} size="lg">
        {subjectId && (
          <QuestionForm
            topics={subjectTopics}
            initial={editingQuestion ?? undefined}
            subjectId={subjectId}
            onSave={handleQuestionSave}
            onCancel={() => { setQuestionModal(false); setEditingQuestion(null); }}
          />
        )}
      </Modal>

      {/* Modal preview pregunta */}
      {previewQuestion && (
        <Modal
          open={!!previewQuestion}
          onClose={() => setPreviewQuestion(null)}
          title={previewQuestion.prompt.slice(0, 60) + (previewQuestion.prompt.length > 60 ? '…' : '')}
          size="lg"
        >
          <div className="flex flex-col gap-4">
            {/* Badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <TypeBadge type={previewQuestion.type} />
              {previewQuestion.origin && (
                <Badge color={ORIGIN_COLORS[previewQuestion.origin]}>
                  {ORIGIN_LABELS[previewQuestion.origin]}
                </Badge>
              )}
              {previewQuestion.difficulty && (
                <span className="text-xs text-ink-500">{'★'.repeat(previewQuestion.difficulty)}</span>
              )}
            </div>
            <QuestionPreviewContent
              question={previewQuestion}
              onExplanationGenerated={(explanation) => {
                setPreviewQuestion((q) =>
                  q ? { ...q, explanation } : null
                );
              }}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-ink-800">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingQuestion(previewQuestion);
                  setPreviewQuestion(null);
                  setQuestionModal(true);
                }}
              >
                ✎ Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreviewQuestion(null)}>
                Cerrar
              </Button>
              
            </div>
          </div>
        </Modal>
      )}

      {/* Modal crear pregunta desde texto seleccionado en PDF */}
      {createFromPdf && pdfSelectedText && (
        <Modal open onClose={() => { setCreateFromPdf(false); setPdfSelectedText(''); }} title="Crear pregunta desde texto seleccionado">
          <div className="mb-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
            <p className="text-xs text-amber-600 mb-1">Texto seleccionado:</p>
            <p className="text-sm text-ink-300 line-clamp-3">{pdfSelectedText}</p>
          </div>
          <QuestionForm
            subjectId={subjectId!}
            topics={topics.filter((t) => t.subjectId === subjectId)}
            initial={{
              subjectId: subjectId!,
              topicId: viewPdfTopic?.id ?? topics.find((t) => t.subjectId === subjectId)?.id ?? '',
              type: 'DESARROLLO',
              prompt: pdfSelectedText,
              stats: { seen: 0, correct: 0, wrong: 0 },
            } as any}
            onSave={async (data) => {
              await createQuestion(data);
              setCreateFromPdf(false);
              setPdfSelectedText('');
            }}
            onCancel={() => { setCreateFromPdf(false); setPdfSelectedText(''); }}
          />
        </Modal>
      )}

      {/* Modal aviso de almacenamiento insuficiente */}
      <Modal
        open={!!storageAlert}
        onClose={() => setStorageAlert(null)}
        title={storageAlert?.suggestFsa ? '⚠ Almacenamiento casi lleno' : '⚠ Sin espacio disponible'}
        size="sm"
      >
        {storageAlert && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-300">{storageAlert.msg}</p>
            {storageAlert.suggestFsa && (
              <div className="flex flex-col gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-sm text-amber-300 font-medium">💡 Solución recomendada</p>
                <p className="text-xs text-ink-400">
                  Configura una <strong>carpeta de disco</strong> en Ajustes → Almacenamiento para guardar
                  archivos directamente en tu ordenador, sin límite de quota del navegador.
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2 border-t border-ink-800">
              <Button variant="ghost" size="sm" onClick={() => setStorageAlert(null)}>
                Cerrar
              </Button>
              {storageAlert.suggestFsa && (
                <Button size="sm" onClick={() => { setStorageAlert(null); navigate('/settings'); }}>
                  Ir a Ajustes
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Resources Tab ──────────────────────────────────────────────────────────

interface ResourcesTabProps {
  subject: import('@/domain/models').Subject;
  subjectId: string;
  resources: ResourceCategory[];
  loading: boolean;
  /** Prefixed filenames stored in IndexedDB, e.g. "Examenes/file.pdf" */
  dbFiles: Set<string>;
  onUpload: (categorySlug: string, files: FileList) => Promise<void>;
  onDelete: (categorySlug: string, filename: string) => Promise<void>;
  synthesisJobs: Record<string, SynthesisProgress>;
}

const CATEGORY_ICONS: Record<string, string> = {
  'Temas': '📚',
  'Exámenes': '📝',
  'Resúmenes': '📋',
  'Práctica': '💻',
};

// Extensiones que el navegador puede renderizar en una pestaña; el resto se descarga.
const INLINE_VIEWABLE = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  'txt', 'md', 'html', 'htm', 'json', 'csv',
]);

/**
 * Abre el archivo en una pestaña nueva si el navegador puede mostrarlo (PDF, imágenes…);
 * en caso contrario (docx, pptx, xlsx, zip…) lo descarga con su nombre original en lugar
 * de abrir una pestaña con el binario en crudo.
 */
function openOrDownload(url: string, filename: string) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (INLINE_VIEWABLE.has(ext)) {
    window.open(url, '_blank');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ResourcesTab({ subject, subjectId, resources, loading, dbFiles, onUpload, onDelete, synthesisJobs }: ResourcesTabProps) {
  const slug = slugify(subject.name);
  const navigate = useNavigate();

  const [dragOverCat, setDragOverCat] = useState<string | null>(null);
  const [uploadingCat, setUploadingCat] = useState<string | null>(null);
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  const toggleCat = (slug: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  // Open a file: try static URL first, then IndexedDB blob
  const handleFileClick = async (file: ResourceFile, categorySlug: string, subcategoryName?: string) => {
    // Los PDFs de temas se almacenan directamente bajo el subjectId (no como recurso categorizado)
    if (categorySlug === 'Temas') {
      // 1. Intentar URL estática
      const staticUrl = resourcesUrl(`resources/${slug}/Temas/${file.name}`);
      try {
        const res = await fetch(staticUrl, { method: 'HEAD' });
        if (res.ok) {
          const ct = res.headers.get('Content-Type') ?? '';
          if (!ct.includes('text/html')) {
            openOrDownload(staticUrl, file.name);
            return;
          }
        }
      } catch {}
      // 2. Intentar desde pdfStorage (IndexedDB/FSA)
      const blobUrl = await getPdfBlobUrl(subjectId, file.name);
      if (blobUrl) {
        openOrDownload(blobUrl, file.name);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } else {
        alert('Archivo no encontrado');
      }
      return;
    }

    const staticPath = subcategoryName
      ? `${categorySlug}/${subcategoryName}/${file.name}`
      : `${categorySlug}/${file.name}`;
    const staticUrl = resourcesUrl(`resources/${slug}/${staticPath}`);

    try {
      const res = await fetch(staticUrl, { method: 'HEAD' });
      if (res.ok) {
        const ct = res.headers.get('Content-Type') ?? '';
        if (!ct.includes('text/html')) {
          openOrDownload(staticUrl, file.name);
          return;
        }
      }
    } catch {}

    const dbPath = subcategoryName
      ? `${categorySlug}/${subcategoryName}/${file.name}`
      : `${categorySlug}/${file.name}`;
    const blobUrl = await getResourceBlobUrl(subject.id, dbPath);

    if (blobUrl) {
      openOrDownload(blobUrl, file.name);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } else {
      alert('Archivo no encontrado');
    }
  };

  const handleDrop = async (categorySlug: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCat(null);
    const files = e.dataTransfer.files;
    if (!files.length) return;
    setUploadingCat(categorySlug);
    try {
      await onUpload(categorySlug, files);
    } finally {
      setUploadingCat(null);
    }
  };

  const handleFileInput = async (categorySlug: string, files: FileList | null) => {
    if (!files?.length) return;
    setUploadingCat(categorySlug);
    try {
      await onUpload(categorySlug, files);
    } finally {
      setUploadingCat(null);
    }
  };

  const handleDelete = async (categorySlug: string, filename: string, subcategoryName?: string) => {
    if (!confirm(`¿Eliminar "${filename}"?`)) return;
    const prefixed = subcategoryName ? `${filename}` : filename;
    await onDelete(categorySlug, subcategoryName ? `${subcategoryName}/${prefixed}` : prefixed);
  };

  const isDbFile = (categorySlug: string, filename: string, subcategoryName?: string) => {
    const key = subcategoryName
      ? `${categorySlug}/${subcategoryName}/${filename}`
      : `${categorySlug}/${filename}`;
    return dbFiles.has(key);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-ink-400 text-sm animate-pulse">Cargando recursos…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Global drop hint */}
      <p className="text-xs text-ink-500">
        Arrastra cualquier archivo (PDF, DOCX, imágenes…) sobre una categoría para guardarlo localmente en tu navegador.
      </p>

      {resources.map((cat) => {
        const totalFiles = cat.files.length + (cat.subcategories?.reduce((acc, sc) => acc + sc.files.length, 0) ?? 0);
        const isDragOver = dragOverCat === cat.slug;
        const isUploading = uploadingCat === cat.slug;
        const isCollapsed = collapsedCats.has(cat.slug);
        const isTemas = cat.slug === 'Temas';

        return (
          <div
            key={cat.slug}
            onDragOver={isTemas ? undefined : (e) => { e.preventDefault(); setDragOverCat(cat.slug); }}
            onDragLeave={isTemas ? undefined : (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCat(null); }}
            onDrop={isTemas ? undefined : (e) => handleDrop(cat.slug, e)}
            className={`rounded-xl transition-all ${isDragOver ? 'ring-2 ring-amber-500/40 bg-amber-500/5' : ''}`}
          >
            {/* Category header — clickable to collapse */}
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => toggleCat(cat.slug)}
                className="font-display text-lg text-ink-200 flex items-center gap-2 flex-1 text-left hover:text-ink-100 transition-colors"
              >
                <span className={`text-xs text-ink-500 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                {CATEGORY_ICONS[cat.name] ?? '📁'}
                {cat.name}
                {totalFiles > 0 && (
                  <span className="text-xs text-ink-500 font-body">({totalFiles} archivo{totalFiles !== 1 ? 's' : ''})</span>
                )}
              </button>
              {/* Upload button (no upload for Temas — those come from topics) */}
              {!isTemas && (
                <label
                  className={`cursor-pointer text-xs font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all ${
                    isUploading
                      ? 'bg-amber-500/20 text-amber-400 animate-pulse'
                      : 'bg-ink-700 hover:bg-ink-600 text-ink-300 hover:text-ink-100'
                  }`}
                  title={`Subir archivos a ${cat.name}`}
                >
                  {isUploading ? '⏳ Subiendo…' : '↑ Subir archivos'}
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFileInput(cat.slug, e.target.files)}
                  />
                </label>
              )}
            </div>

            {/* Collapsible content */}
            {!isCollapsed && (<>
            {/* Drag overlay */}
            {isDragOver && (
              <div className="border-2 border-dashed border-amber-500/60 rounded-xl p-8 text-center text-amber-400 text-sm mb-3 pointer-events-none">
                📂 Suelta los archivos aquí para añadirlos a <strong>{cat.name}</strong>
              </div>
            )}

            {/* Empty state with upload zone */}
            {totalFiles === 0 && !isDragOver && !isTemas && (
              <label className="flex flex-col items-center gap-2 border-2 border-dashed border-ink-700 hover:border-amber-500/40 hover:bg-amber-500/5 rounded-xl p-8 text-center text-ink-500 hover:text-ink-300 cursor-pointer transition-all">
                <span className="text-2xl">📁</span>
                <span className="text-sm font-medium">Arrastra archivos o haz clic para subir</span>
                <span className="text-xs">PDF, DOCX, imágenes… se guardan en tu navegador</span>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFileInput(cat.slug, e.target.files)}
                />
              </label>
            )}

            {/* Direct files */}
            {cat.files.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-3">
                {cat.files.map((f) => (
                  <div
                    key={f.path || f.name}
                    className="flex items-center gap-2 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 hover:border-ink-500 transition-all group"
                  >
                    <button
                      onClick={() => handleFileClick(f, cat.slug)}
                      className="flex items-center gap-2 text-left flex-1 min-w-0"
                    >
                      <span className="text-base flex-shrink-0">{getFileIcon(f.name)}</span>
                      <span className="text-sm text-ink-200 truncate group-hover:text-amber-300 transition-colors">{f.name}</span>
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {f.name.toLowerCase().endsWith('.pdf') && (
                        <button
                          onClick={() => {
                            if (isTemas && f.topicId) {
                              navigate(`/subject/${subject.id}/listen/${f.topicId}`);
                            } else {
                              navigate(`/subject/${subject.id}/listen-resource?file=${encodeURIComponent(`${cat.slug}/${f.name}`)}`);
                            }
                          }}
                          className="text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 hover:text-blue-300 transition-all font-medium px-1.5 py-0.5 rounded flex items-center gap-1"
                          title="Escuchar PDF"
                        >
                          🎧
                          {!isTemas && <ResourceWavStatusIcon resourceFile={`${cat.slug}/${f.name}`} synthesisJobs={synthesisJobs} />}
                        </button>
                      )}
                      {!isTemas && isDbFile(cat.slug, f.name) && (
                        <button
                          onClick={() => handleDelete(cat.slug, f.name)}
                          className="text-xs text-rose-500/50 hover:text-rose-400 hover:bg-ink-700 px-1.5 py-0.5 rounded transition-all opacity-0 group-hover:opacity-100"
                          title="Eliminar archivo"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Subcategories */}
            {cat.subcategories && cat.subcategories.filter((sc) => sc.files.length > 0).map((sc) => (
              <div key={sc.name} className="ml-4 mb-3">
                <p className="text-sm text-ink-400 font-medium mb-2">{sc.name}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {sc.files.map((f) => (
                    <div
                      key={f.path || f.name}
                      className="flex items-center gap-2 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2.5 hover:border-ink-500 transition-all group"
                    >
                      <button
                        onClick={() => handleFileClick(f, cat.slug, sc.name)}
                        className="flex items-center gap-2 text-left flex-1 min-w-0"
                      >
                        <span className="text-base flex-shrink-0">{getFileIcon(f.name)}</span>
                        <span className="text-sm text-ink-200 truncate group-hover:text-amber-300 transition-colors">{f.name}</span>
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {f.name.toLowerCase().endsWith('.pdf') && (
                          <button
                            onClick={() => navigate(`/subject/${subject.id}/listen-resource?file=${encodeURIComponent(`${cat.slug}/${sc.name}/${f.name}`)}`)}
                            className="text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 hover:text-blue-300 transition-all font-medium px-1.5 py-0.5 rounded flex items-center gap-1"
                            title="Escuchar PDF"
                          >
                            🎧
                            <ResourceWavStatusIcon resourceFile={`${cat.slug}/${sc.name}/${f.name}`} synthesisJobs={synthesisJobs} />
                          </button>
                        )}
                        {isDbFile(cat.slug, f.name, sc.name) && (
                          <button
                            onClick={() => handleDelete(cat.slug, f.name, sc.name)}
                            className="text-xs text-rose-500/50 hover:text-rose-400 hover:bg-ink-700 px-1.5 py-0.5 rounded transition-all opacity-0 group-hover:opacity-100"
                            title="Eliminar archivo"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            </>)}
          </div>
        );
      })}
    </div>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, string> = {
    pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊',
    ipynb: '🔬', py: '🐍', txt: '📃', md: '📃', zip: '📦',
    png: '🖼', jpg: '🖼', jpeg: '🖼',
  };
  return icons[ext] ?? '📁';
}

// ─── Practice config ──────────────────────────────────────────────────────────

const ALL_TYPES: { type: QuestionType; label: string }[] = [
  { type: 'TEST', label: 'Test' },
  { type: 'DESARROLLO', label: 'Desarrollo' },
  { type: 'COMPLETAR', label: 'Completar' },
  { type: 'PRACTICO', label: 'Práctico' },
];

interface PracticeConfigProps {
  subjectId: string;
  topics: import('@/domain/models').Topic[];
  questions: Question[];
  defaultTopicId?: string;
  autostart?: string;
}

function PracticeConfig({ subjectId, topics, questions, defaultTopicId, autostart }: PracticeConfigProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'random' | 'all' | 'failed' | 'topic' | 'smart' | 'starred' | 'exam'>(
    autostart === 'smart' ? 'smart' : 'random'
  );
  const [count, setCount] = useState('20');
  const [topicId, setTopicId] = useState(defaultTopicId ?? '');
  // D1: Exam simulation
  const [examDuration, setExamDuration] = useState('60');

  // Type filter checklist — all enabled by default
  const [enabledTypes, setEnabledTypes] = useState<Set<QuestionType>>(new Set(['TEST', 'DESARROLLO', 'COMPLETAR', 'PRACTICO']));

  // Feature 4: Filters
  const [onlyUnseen, setOnlyUnseen] = useState(false);
  const [selectedDifficulties, setSelectedDifficulties] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));

  const toggleType = (t: QuestionType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        // Don't allow deselecting all
        if (next.size > 1) next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  };

  // Count questions by type (to show next to checkbox)
  const countByType = (type: QuestionType) => questions.filter((q) => q.type === type).length;

  // Count by difficulty
  const countByDifficulty = (difficulty: number) => questions.filter((q) => q.difficulty === difficulty).length;

  // Filtered questions by enabled types
  const typeFilteredQuestions = questions.filter((q) => enabledTypes.has(q.type));

  const failedCount = typeFilteredQuestions.filter((q) => q.stats.lastResult === 'WRONG').length;

  const getSmartReviewCount = () => {
    const today = new Date().toISOString().split('T')[0];
    return typeFilteredQuestions.filter((q) =>
      !q.stats.nextReviewAt || q.stats.nextReviewAt <= today
    ).length;
  };
  const smartReviewCount = getSmartReviewCount();

  const starredCount = typeFilteredQuestions.filter((q) => q.starred).length;

  const getAvailableCount = () => {
    let base: Question[] = [];
    if (mode === 'failed') base = typeFilteredQuestions.filter((q) => q.stats.lastResult === 'WRONG');
    else if (mode === 'topic') base = typeFilteredQuestions.filter((q) => questionBelongsToTopic(q, topicId));
    else if (mode === 'smart') {
      const today = new Date().toISOString().split('T')[0];
      base = typeFilteredQuestions.filter((q) =>
        !q.stats.nextReviewAt || q.stats.nextReviewAt <= today
      );
      if (base.length === 0) base = typeFilteredQuestions;
    }
    else if (mode === 'starred') base = typeFilteredQuestions.filter((q) => q.starred);
    else base = typeFilteredQuestions;

    // Apply Feature 4 filters
    if (onlyUnseen) {
      base = base.filter((q) => q.stats.seen === 0);
    }
    if (selectedDifficulties.size < 5) {
      base = base.filter((q) => !q.difficulty || selectedDifficulties.has(q.difficulty));
    }

    return base.length;
  };
  const available = getAvailableCount();

  const handleStart = async () => {
    if (available === 0) return;
    let pool: Question[] = [];

    if (mode === 'all') pool = [...typeFilteredQuestions];
    else if (mode === 'failed') pool = typeFilteredQuestions.filter((q) => q.stats.lastResult === 'WRONG');
    else if (mode === 'topic') pool = typeFilteredQuestions.filter((q) => questionBelongsToTopic(q, topicId));
    else if (mode === 'smart') {
      const { sortByPriority } = await import('@/domain/spacedRepetition');
      const today = new Date().toISOString().split('T')[0];
      pool = typeFilteredQuestions.filter((q) =>
        !q.stats.nextReviewAt || q.stats.nextReviewAt <= today
      );
      pool = sortByPriority(pool);
      if (pool.length === 0) {
        pool = sortByPriority(typeFilteredQuestions).slice(0, 20);
      }
    }
    else if (mode === 'starred') {
      pool = typeFilteredQuestions.filter((q) => q.starred);
    }
    else if (mode === 'exam') {
      const n = Math.min(parseInt(count) || 20, typeFilteredQuestions.length);
      pool = [...typeFilteredQuestions].sort(() => Math.random() - 0.5).slice(0, n);
    }
    else {
      const n = Math.min(parseInt(count) || 20, typeFilteredQuestions.length);
      pool = [...typeFilteredQuestions].sort(() => Math.random() - 0.5).slice(0, n);
    }

    // Apply additional filters (Feature 4)
    if (onlyUnseen) {
      pool = pool.filter((q) => q.stats.seen === 0);
    }
    if (selectedDifficulties.size < 5) {
      pool = pool.filter((q) => !q.difficulty || selectedDifficulties.has(q.difficulty));
    }

    pool = pool.sort(() => Math.random() - 0.5);
    const { sessionRepo } = await import('@/data/repos');
    const sessionMode = mode === 'starred' ? 'failed' : mode === 'exam' ? 'exam' : mode; // reusar 'failed' como modo base para sesiones starring
    const session = await sessionRepo.create({ subjectId, mode: sessionMode as any, topicId: mode === 'topic' ? topicId : undefined, questionIds: pool.map((q) => q.id) });
    const examParams = mode === 'exam' ? `?examMode=true&duration=${examDuration}` : '';
    navigate(`/practice/${session.id}${examParams}`);
  };

  // Auto-launch cuando viene del badge "Repaso de hoy" (A1)
  const autostartedRef = useRef(false);
  useEffect(() => {
    if (autostart === 'smart' && !autostartedRef.current && questions.length > 0) {
      autostartedRef.current = true;
      handleStart();
    }
  }, [autostart, questions.length]);

  const handleFlashcard = () => {
    if (available === 0) return;
    const params = new URLSearchParams();
    if (mode === 'topic' && topicId) params.set('topic', topicId);
    params.set('mode', mode === 'all' ? 'all' : mode === 'failed' ? 'failed' : 'random');
    params.set('types', [...enabledTypes].join(','));
    if (mode === 'random') params.set('count', count);
    navigate(`/flashcard/${subjectId}?${params.toString()}`);
  };

  return (
    <Card className="max-w-md">
      <div className="flex flex-col gap-4">
        <h3 className="font-display text-ink-200">Configurar sesión</h3>

        {/* Type filter checklist */}
        <div>
          <p className="text-xs font-medium text-ink-400 uppercase tracking-widest mb-2">Tipos de pregunta</p>
          <div className="flex flex-wrap gap-2">
            {ALL_TYPES.map(({ type, label }) => {
              const c = countByType(type);
              const active = enabledTypes.has(type);
              return (
                <label
                  key={type}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-all ${
                    active
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      : 'bg-ink-800 border-ink-700 text-ink-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleType(type)}
                    className="accent-amber-500 w-3.5 h-3.5"
                  />
                  {label} <span className="text-xs opacity-60">({c})</span>
                </label>
              );
            })}
          </div>
        </div>

        <Select label="Modo" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="random">Aleatorio</option>
          <option value="all">Todas las preguntas</option>
          <option value="failed">Sólo falladas ({failedCount})</option>
          <option value="smart">Repaso inteligente ({smartReviewCount} pendientes)</option>
          <option value="starred">★ Solo difíciles ({starredCount})</option>
          <option value="topic">Por tema</option>
          <option value="exam">🎓 Simulacro de examen</option>
        </Select>
        {(mode === 'random' || mode === 'exam') && <Input label="Número de preguntas" type="number" min="1" max={typeFilteredQuestions.length} value={count} onChange={(e) => setCount(e.target.value)} />}
        {mode === 'exam' && <Input label="Duración (minutos)" type="number" min="5" max="300" value={examDuration} onChange={(e) => setExamDuration(e.target.value)} />}
        {mode === 'topic' && (
          <Select label="Tema" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">Selecciona un tema…</option>
            {topics.map((t) => { const n = typeFilteredQuestions.filter((q) => questionBelongsToTopic(q, t.id)).length; return <option key={t.id} value={t.id}>{t.title} ({n})</option>; })}
          </Select>
        )}

        {/* Feature 4: Additional filters */}
        <div className="border-t border-ink-700 pt-3">
          <p className="text-xs font-medium text-ink-400 uppercase tracking-widest mb-2">Filtros adicionales</p>

          {/* Only unseen filter */}
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-ink-700 text-sm cursor-pointer hover:border-ink-600 transition-all mb-2">
            <input
              type="checkbox"
              checked={onlyUnseen}
              onChange={(e) => setOnlyUnseen(e.target.checked)}
              className="accent-amber-500 w-3.5 h-3.5"
            />
            <span className="text-ink-300">Solo no vistas ({typeFilteredQuestions.filter(q => q.stats.seen === 0).length})</span>
          </label>

          {/* Difficulty filter */}
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4, 5].map((difficulty) => {
              const count = countByDifficulty(difficulty);
              const isSelected = selectedDifficulties.has(difficulty);
              return (
                <button
                  key={difficulty}
                  onClick={() => {
                    setSelectedDifficulties((prev) => {
                      const next = new Set(prev);
                      if (next.has(difficulty)) {
                        if (next.size > 1) next.delete(difficulty);
                      } else {
                        next.add(difficulty);
                      }
                      return next;
                    });
                  }}
                  className={`px-2 py-1 rounded text-xs font-medium transition-all ${
                    isSelected
                      ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300'
                      : 'bg-ink-800 border border-ink-700 text-ink-500'
                  }`}
                  title={`${count} pregunta${count !== 1 ? 's' : ''}`}
                >
                  {'★'.repeat(difficulty)} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="flex flex-col gap-2">
          <Button onClick={handleStart} disabled={available === 0 || (mode === 'topic' && !topicId)}>
            Empezar ({available} preguntas)
          </Button>
          <Button
            variant="secondary"
            onClick={handleFlashcard}
            disabled={available === 0 || (mode === 'topic' && !topicId)}
          >
            🃏 Flashcards ({available})
          </Button>
        </div>
      </div>
    </Card>
  );
}
