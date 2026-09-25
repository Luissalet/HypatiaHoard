import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '@/ui/store';
import { db, getSettings } from '@/data/db';
import { Button, Input, Card, Select, Modal, TypeBadge } from '@/ui/components';
import { parseAnkiTsv } from '@/utils/ankiImport';
import { exportContributionPack, importContributionPack, undoContributionImport, previewContributionPack, type ContributionPackPreview, type UnmatchedTopic, type TopicMappings } from '@/data/contributionImport';
import { downloadContributionGuide } from '@/data/generateContributionGuide';
import { exportCompactSubject, exportAllCompactSubjects } from '@/data/exportCompact';
import { parseImportFile, downloadJSON } from '@/data/exportImport';
import { exportPackage } from '@/data/packageManager';
import { downloadBlob } from '@/utils/pdfExport';
import { slugify } from '@/domain/normalize';
import { syncImagesToDevServer, type ImageSyncResult } from '@/data/questionImageStorage';
import { useHoardMode } from '@/data/hoardMode';
import { pushToGist, pullFromGist, type SyncResult } from '@/data/gistSync';
import { QuestionPreviewContent } from '@/ui/components/QuestionPreview';
import type { ImportHistoryEntry, Question } from '@/domain/models';
import {
  isFsaSupported,
  isOpfsSupported,
  selectPdfFolder,
  selectOpfsFolder,
  getStoredFolderRecord,
  clearPdfFolder,
  migrateAllPdfsToFolder,
  type MigrationResult,
} from '@/data/fsaStorage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convierte URLs de Gist (interfaz de usuario) a URL raw para fetch directo. */
function toRawUrl(url: string): string {
  // https://gist.github.com/{user}/{id}  →  https://gist.githubusercontent.com/{user}/{id}/raw
  const gistMatch = url.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)\/?$/i);
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
  }
  return url;
}

/** Formatea bytes en unidad legible (KB, MB, GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const hoard = useHoardMode();
  const { settings, loadSettings, updateSettings, subjects, loadSubjects, createQuestion } = useStore();
  const [alias, setAlias] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [exportSubjectId, setExportSubjectId] = useState('');
  const [importedPacks, setImportedPacks] = useState<string[]>([]);
  const [compactExportSubjectId, setCompactExportSubjectId] = useState('');
  const [pkgExportSubjectId, setPkgExportSubjectId] = useState('');
  const [exportingPkg, setExportingPkg] = useState(false);
  const [imageSyncResult, setImageSyncResult] = useState<ImageSyncResult | null>(null);
  const [syncingImages, setSyncingImages] = useState(false);
  const [importHistory, setImportHistory] = useState<ImportHistoryEntry[]>([]);
  const [undoMsg, setUndoMsg] = useState('');
  const [undoingPackId, setUndoingPackId] = useState<string | null>(null);
  const [packPreview, setPackPreview] = useState<ContributionPackPreview | null>(null);
  const [previewSampleQuestion, setPreviewSampleQuestion] = useState<Question | null>(null);
  // Queue para importación múltiple
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [importing, setImporting] = useState(false);
  // Unmatched topics from import
  const [unmatchedTopics, setUnmatchedTopics] = useState<UnmatchedTopic[]>([]);
  const [topicMappings, setTopicMappings] = useState<TopicMappings>({});
  const [allTopicsForMapping, setAllTopicsForMapping] = useState<{ id: string; title: string; subjectName: string }[]>([]);

  // ── Import por URL ──────────────────────────────────────────────────────────
  const [importUrl, setImportUrl] = useState('');
  const [importingUrl, setImportingUrl] = useState(false);

  // ── GitHub Gist export ──────────────────────────────────────────────────────
  const [githubToken, setGithubToken] = useState('');
  const [gistExportMsg, setGistExportMsg] = useState('');
  const [exportingGist, setExportingGist] = useState(false);
  const [lastGistUrl, setLastGistUrl] = useState('');

  // ── Cuota de almacenamiento ─────────────────────────────────────────────────
  const [storageInfo, setStorageInfo] = useState<{ used: number; quota: number } | null>(null);
  const [isPersistent, setIsPersistent] = useState<boolean | null>(null);
  const [requestingPersistence, setRequestingPersistence] = useState(false);

  // ── File System Access API / OPFS ────────────────────────────────────────────
  const fsaSupported = isFsaSupported();
  const opfsSupported = isOpfsSupported();
  const [fsaFolderName, setFsaFolderName] = useState<string | null>(null);
  const [activeFolderType, setActiveFolderType] = useState<'fsa' | 'opfs' | null>(null);
  const [fsaMsg, setFsaMsg] = useState('');
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [activatingOpfs, setActivatingOpfs] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);

  // ── Cloud Sync ─────────────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncGistId, setSyncGistId] = useState('');
  const [syncLog, setSyncLog] = useState<{ ts: string; msg: string; ok: boolean }[]>([]);
  const syncLogEndRef = useRef<HTMLDivElement>(null);
  const addLog = (msg: string, ok = true) => {
    const ts = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setSyncLog((prev) => [...prev.slice(-49), { ts, msg, ok }]);
  };
  useEffect(() => {
    syncLogEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [syncLog]);

  // ── Anki Import ──────────────────────────────────────────────────────────────
  const [ankiImportMsg, setAnkiImportMsg] = useState('');

  const refreshStorageStatus = useCallback(async () => {
    // Quota de IndexedDB
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const est = await navigator.storage.estimate();
      setStorageInfo({ used: est.usage ?? 0, quota: est.quota ?? 0 });
    }
    // Storage persistence
    if ('storage' in navigator && 'persisted' in navigator.storage) {
      setIsPersistent(await navigator.storage.persisted());
    }
    // FSA / OPFS folder configurada
    const rec = await getStoredFolderRecord();
    setFsaFolderName(rec?.name ?? null);
    setActiveFolderType(rec?.type ?? null);
  }, []);

  useEffect(() => {
    loadSettings();
    loadSubjects();
    refreshStorageStatus();
  }, []);

  useEffect(() => {
    setAlias(settings.alias);
    setImportedPacks(settings.importedPackIds);
    setImportHistory(settings.importHistory ?? []);
    setGithubToken(settings.githubToken ?? '');
    setSyncGistId(settings.syncGistId ?? '');
  }, [settings]);


  const handleSyncImages = async () => {
  setSyncingImages(true);
  setImageSyncResult(null);
  try {
    const result = await syncImagesToDevServer();
    setImageSyncResult(result);
  } finally {
    setSyncingImages(false);
  }
};

  const handleSaveAlias = async () => {
    await updateSettings({ alias });
  };


  const handleUndo = async (packId: string) => {
  if (!confirm('¿Eliminar todas las preguntas de este pack importado? La acción no se puede deshacer.')) return;
  setUndoingPackId(packId);
  setUndoMsg('');
  try {
    const result = await undoContributionImport(packId);
    setUndoMsg(`✓ ${result.deletedQuestions} preguntas eliminadas`);
    setImportHistory(h => h.filter(e => e.packId !== packId));
    setImportedPacks(p => p.filter(id => id !== packId));
    await loadSubjects();
  } catch (err) {
    setUndoMsg('Error: ' + String(err));
  } finally {
    setUndoingPackId(null);
    setTimeout(() => setUndoMsg(''), 5000);
  }
};

  // Carga el preview del siguiente archivo en la cola
  const processNextInQueue = async (queue: File[]) => {
    if (queue.length === 0) {
      setFileQueue([]);
      return;
    }
    const [next, ...rest] = queue;
    setFileQueue(rest);
    try {
      const raw = await parseImportFile(next);
      const preview = await previewContributionPack(raw);
      if ('error' in preview) {
        setImportMsg('Error: ' + preview.error);
        // Continuar con el siguiente
        await processNextInQueue(rest);
      } else {
        setPackPreview(preview);
      }
    } catch (err) {
      setImportMsg('Error: ' + String(err));
      await processNextInQueue(rest);
    }
  };

  const handleImportContribution = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setImportMsg('');
    setQueueTotal(files.length);
    const [first, ...rest] = files;
    setFileQueue(rest);
    try {
      const raw = await parseImportFile(first);
      const preview = await previewContributionPack(raw);
      if ('error' in preview) {
        setImportMsg('Error: ' + preview.error);
        if (rest.length > 0) await processNextInQueue(rest);
      } else {
        setPackPreview(preview);
      }
    } catch (err) {
      setImportMsg('Error: ' + String(err));
      if (rest.length > 0) await processNextInQueue(rest);
    }
    e.target.value = '';
  };

  const handleConfirmImport = async (mappings?: TopicMappings) => {
    if (!packPreview || importing) return;
    setImporting(true);
    try {
      const result = await importContributionPack(packPreview.rawPack, mappings);
      if (result.alreadyImported) {
        setImportMsg(`ℹ️ Pack ${result.packId.slice(0, 8)}... ya fue importado anteriormente.`);
      } else if (result.errors.length > 0) {
        setImportMsg('Error: ' + result.errors[0]);
      } else if (result.unmatchedTopics.length > 0) {
        // Show unmatched topics for manual mapping
        setUnmatchedTopics(result.unmatchedTopics);
        // Load all topics for the mapping dropdowns
        const allSubjects = await db.subjects.toArray();
        const allTopics = await db.topics.toArray();
        const topicsWithSubject = allTopics.map((t) => {
          const s = allSubjects.find((s) => s.id === t.subjectId);
          return { id: t.id, title: t.title, subjectName: s?.name ?? '' };
        });
        setAllTopicsForMapping(topicsWithSubject);
        setTopicMappings({});
        const msg = `⚠ ${result.newQuestions} preguntas importadas, pero ${result.skippedUnmatched} preguntas no se pudieron asignar porque sus temas no coinciden con los existentes. Asigna los temas manualmente abajo.`;
        setImportMsg(msg);
        if (result.newQuestions > 0) {
          setImportedPacks((p) => [...p, result.packId]);
          await loadSubjects();
        }
        setImporting(false);
        return; // Don't close preview yet
      } else {
        setImportMsg(
          `✓ Importado de ${result.createdBy}: ${result.newQuestions} preguntas nuevas, ${result.duplicates} duplicadas`
        );
        setImportedPacks((p) => [...p, result.packId]);
        await loadSubjects();
      }
      setPackPreview(null);
      setUnmatchedTopics([]);
      // Procesar siguiente en la cola
      if (fileQueue.length > 0) {
        await processNextInQueue(fileQueue);
      } else {
        setQueueTotal(0);
      }
    } catch (err) {
      setImportMsg('Error: ' + String(err));
      setPackPreview(null);
      setUnmatchedTopics([]);
      if (fileQueue.length > 0) await processNextInQueue(fileQueue);
      else setQueueTotal(0);
    } finally {
      setImporting(false);
    }
  };

  const handleRetryWithMappings = async () => {
    // Re-import with the user-defined topic mappings
    await handleConfirmImport(topicMappings);
    setUnmatchedTopics([]);
  };

  const handleExportContribution = async () => {
    if (!exportSubjectId) return;
    try {
      const pack = await exportContributionPack(alias, exportSubjectId);
      const subject = subjects.find((s) => s.id === exportSubjectId);
      const filename = `contribution-${alias || 'yo'}-${subject?.name.slice(0, 20).replace(/\s+/g, '-') ?? exportSubjectId}-${new Date().toISOString().split('T')[0]}.json`;
      downloadJSON(pack, filename);
    } catch (err) {
      setImportMsg('Error al exportar: ' + String(err));
    }
  };

  const handleExportCompactSubject = async () => {
    if (!compactExportSubjectId) return;
    try {
      const compact = await exportCompactSubject(compactExportSubjectId);
      const filename = `compact-${compact.slug}-${new Date().toISOString().split('T')[0]}.json`;
      downloadJSON(compact, filename);
      setImportMsg(`✓ Exportado banco compacto: ${compact.total} preguntas`);
    } catch (err) {
      setImportMsg('Error al exportar: ' + String(err));
    }
  };

  const handleExportAllCompact = async () => {
    try {
      const allCompact = await exportAllCompactSubjects();
      const totalQuestions = allCompact.reduce((sum, s) => sum + s.total, 0);
      const filename = `compact-all-subjects-${new Date().toISOString().split('T')[0]}.json`;
      downloadJSON(allCompact, filename);
      setImportMsg(`✓ Exportado ${allCompact.length} asignaturas, ${totalQuestions} preguntas en total`);
    } catch (err) {
      setImportMsg('Error al exportar: ' + String(err));
    }
  };

  // ── Handler: exportar paquete del marketplace (.examcoach.zip) ───────────────
  const handleExportMarketplacePackage = async () => {
    if (!pkgExportSubjectId || exportingPkg) return;
    setExportingPkg(true);
    try {
      const subject = subjects.find((s) => s.id === pkgExportSubjectId);
      const blob = await exportPackage(pkgExportSubjectId);
      const slug = subject ? slugify(subject.name) : pkgExportSubjectId;
      downloadBlob(blob, `${slug}.examcoach.zip`);
      setImportMsg(`✓ Paquete exportado: ${subject?.name ?? slug}`);
    } catch (err) {
      setImportMsg('Error al exportar paquete: ' + String(err));
    } finally {
      setExportingPkg(false);
    }
  };

  const handleExportAllMarketplacePackages = async () => {
    if (exportingPkg || subjects.length === 0) return;
    setExportingPkg(true);
    try {
      let ok = 0;
      for (const subject of subjects) {
        try {
          const blob = await exportPackage(subject.id);
          downloadBlob(blob, `${slugify(subject.name)}.examcoach.zip`);
          ok++;
        } catch (err) {
          console.error(`Error exportando ${subject.name}:`, err);
        }
      }
      setImportMsg(`✓ Exportados ${ok}/${subjects.length} paquetes del marketplace`);
    } catch (err) {
      setImportMsg('Error al exportar paquetes: ' + String(err));
    } finally {
      setExportingPkg(false);
    }
  };

  // ── Handler: importar contribution pack desde URL ────────────────────────────
  const handleImportFromUrl = useCallback(async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImportingUrl(true);
    setImportMsg('');
    try {
      const rawUrl = toRawUrl(url);
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status} – ${response.statusText}`);
      const raw = await response.json();
      const preview = await previewContributionPack(raw);
      if ('error' in preview) {
        setImportMsg('Error: ' + preview.error);
      } else {
        setPackPreview(preview);
        setImportUrl('');
      }
    } catch (err) {
      setImportMsg('Error al obtener la URL: ' + String(err));
    } finally {
      setImportingUrl(false);
    }
  }, [importUrl]);

  // ── Handler: guardar token de GitHub ─────────────────────────────────────────
  const handleSaveGithubToken = async () => {
    if (!githubToken.trim()) {
      setGistExportMsg('⚠ El token está vacío');
      setTimeout(() => setGistExportMsg(''), 4000);
      return;
    }
    try {
      await updateSettings({ githubToken: githubToken.trim() });
      // Verificar que se guardó leyendo de vuelta de IndexedDB
      const check = await getSettings();
      if (check.githubToken !== githubToken.trim()) {
        setGistExportMsg('⚠ El token no se persistió en IndexedDB — revisa permisos del navegador');
        setTimeout(() => setGistExportMsg(''), 8000);
        return;
      }
      setGistExportMsg('✓ Token guardado');
      setTimeout(() => setGistExportMsg(''), 3000);
    } catch (err) {
      setGistExportMsg('Error al guardar: ' + String(err));
      setTimeout(() => setGistExportMsg(''), 8000);
    }
  };

  // ── Handler: exportar contribution pack a GitHub Gist ─────────────────────
  const handleExportToGist = async () => {
    if (!exportSubjectId) return;
    if (!githubToken) {
      setGistExportMsg('Error: introduce y guarda un token de GitHub primero');
      return;
    }
    setExportingGist(true);
    setGistExportMsg('');
    setLastGistUrl('');
    try {
      const pack = await exportContributionPack(alias, exportSubjectId);
      const subject = subjects.find((s) => s.id === exportSubjectId);
      const filename = `contribution-${alias || 'yo'}-${subject?.name.slice(0, 20).replace(/\s+/g, '-') ?? exportSubjectId}-${new Date().toISOString().split('T')[0]}.json`;

      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Authorization: `token ${githubToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          description: `ExamCoach contribution pack — ${subject?.name ?? exportSubjectId} — ${alias || 'anónimo'}`,
          public: false,
          files: {
            [filename]: { content: JSON.stringify(pack, null, 2) },
          },
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as any).message ?? `HTTP ${response.status}`);
      }

      const gist = await response.json() as {
        html_url: string;
        files: Record<string, { raw_url: string }>;
      };

      // URL raw directa (válida para importar desde URL en esta misma pantalla)
      const rawUrl = Object.values(gist.files)[0]?.raw_url ?? gist.html_url;
      setLastGistUrl(rawUrl);
      setGistExportMsg(`✓ Gist creado`);

      // También descarga el JSON localmente como respaldo
      downloadJSON(pack, filename);
    } catch (err) {
      setGistExportMsg('Error: ' + String(err));
    } finally {
      setExportingGist(false);
    }
  };

  // ── Handler: solicitar storage persistente ───────────────────────────────────
  const handleRequestPersistence = async () => {
    if (!('storage' in navigator && 'persist' in navigator.storage)) return;
    setRequestingPersistence(true);
    try {
      const granted = await navigator.storage.persist();
      setIsPersistent(granted);
    } finally {
      setRequestingPersistence(false);
    }
  };

  // ── Handlers: File System Access API ─────────────────────────────────────────
  const handleSelectFolder = async () => {
    setSelectingFolder(true);
    setFsaMsg('');
    try {
      const handle = await selectPdfFolder();
      if (handle) {
        setFsaFolderName(handle.name);
        setActiveFolderType('fsa');
        setFsaMsg('✓ Carpeta configurada. Los nuevos PDFs se guardarán aquí.');
        await refreshStorageStatus();
      }
    } finally {
      setSelectingFolder(false);
    }
  };

  const handleActivateOpfs = async () => {
    setActivatingOpfs(true);
    setFsaMsg('');
    try {
      const handle = await selectOpfsFolder();
      if (handle) {
        setFsaFolderName('Almacenamiento interno (OPFS)');
        setActiveFolderType('opfs');
        setFsaMsg('✓ Almacenamiento interno activado. Los nuevos PDFs se guardarán aquí sin límite de quota.');
        await refreshStorageStatus();
      }
    } catch {
      setFsaMsg('Error activando el almacenamiento interno. Prueba con Chrome 86+.');
    } finally {
      setActivatingOpfs(false);
    }
  };

  const handleClearFolder = async () => {
    if (!confirm('¿Desconectar la carpeta de PDFs? Los PDFs del disco NO se eliminan, pero la app dejará de usarla y volverá a IndexedDB.')) return;
    await clearPdfFolder();
    setFsaFolderName(null);
    setFsaMsg('Carpeta desconectada. La app usará IndexedDB para los próximos PDFs.');
    setMigrationResult(null);
  };

  const handleMigrate = async () => {
    if (!confirm('¿Mover todos los PDFs de IndexedDB a la carpeta del disco? Esto liberará quota del navegador. Los PDFs que ya estén en disco se saltan automáticamente.')) return;
    setMigrating(true);
    setFsaMsg('');
    setMigrationResult(null);
    try {
      const result = await migrateAllPdfsToFolder();
      setMigrationResult(result);
      if (result.failed === 0) {
        setFsaMsg(`✓ Migración completa: ${result.migrated} PDFs movidos, ${formatBytes(result.freedBytes)} liberados de IndexedDB.`);
      } else {
        setFsaMsg(`⚠ ${result.migrated} PDFs migrados, ${result.failed} fallaron (se mantienen en IndexedDB).`);
      }
      await refreshStorageStatus();
    } catch (err) {
      setFsaMsg('Error en migración: ' + String(err));
    } finally {
      setMigrating(false);
    }
  };

  const handleClearData = async () => {
    if (!confirm('¿Eliminar TODOS los datos? Esta acción es irreversible.')) return;
    await db.subjects.clear();
    await db.topics.clear();
    await db.questions.clear();
    await db.sessions.clear();
    await db.pdfAnchors.clear();
    await db.pdfResources.clear();
    await updateSettings({ alias: '', importedPackIds: [], globalBankSyncedAt: undefined });
    // Hypatia's Hoard keeps everything on the local server: download it again into this browser.
    if (hoard) void import('@/data/hoardSync').then((m) => m.resetSyncCursor());
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <header className="border-b border-ink-800 bg-ink-900/50">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center gap-4">
          <button onClick={() => navigate('/')} className="text-ink-400 hover:text-ink-200 text-sm transition-colors">
            ← Inicio
          </button>
          <h1 className="font-display text-xl text-ink-100">Ajustes</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-6">
        {/* Identity */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-4">Identidad</h2>
          <div className="flex flex-col gap-4">
            <Input
              label="Mi alias (para contribuciones)"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="Ej: Luis, Ana, Pablo..."
              hint="Se añade a las preguntas que crees para identificar tu autoría en contributions packs"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveAlias}>Guardar alias</Button>
            </div>
          </div>
        </Card>

        {/* ── Cloud Sync ──────────────────────────────────────────────── */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">Sincronización entre dispositivos</h2>
          <p className="text-sm text-ink-500 mb-4">
            Sincroniza tus asignaturas, preguntas, sesiones de práctica, entregas y progreso entre PC y móvil
            usando un GitHub Gist privado. Solo se descargan los cambios nuevos (como git).
          </p>

          <div className="flex flex-col gap-4">
              {/* Status */}
              {settings.lastSyncAt && (
                <div className="flex items-center gap-2 text-xs text-ink-500">
                  <span className="w-2 h-2 rounded-full bg-sage-500 flex-shrink-0" />
                  Última sincronización: {new Date(settings.lastSyncAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
              )}

              {/* Sync buttons */}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    setSyncing(true);
                    setSyncMsg('');
                    // Si el Gist ID del input difiere del guardado, guardarlo antes de sync
                    const pendingGistId = syncGistId.trim();
                    if (pendingGistId && pendingGistId !== settings.syncGistId) {
                      if (pendingGistId.startsWith('ghp_') || pendingGistId.startsWith('github_pat_')) {
                        addLog('✗ El Gist ID parece ser el Token — déjalo vacío y sube primero', false);
                        setSyncing(false);
                        return;
                      }
                      await updateSettings({ syncGistId: pendingGistId });
                      addLog(`Gist ID actualizado: ${pendingGistId.slice(0, 12)}…`);
                    }
                    addLog('Descargando cambios remotos antes de subir…');
                    const pullResult = await pullFromGist(githubToken);
                    if (pullResult.success && pullResult.direction !== 'skip') {
                      addLog(`Merge: +${pullResult.added ?? 0} nuevos, ~${pullResult.updated ?? 0} actualizados`);
                    } else if (!pullResult.success) {
                      addLog(`Pull previo: ${pullResult.error ?? 'error'}`, false);
                    } else {
                      addLog('Sin cambios remotos nuevos');
                    }
                    addLog('Subiendo datos al Gist…');
                    const result = await pushToGist(githubToken);
                    if (result.success) {
                      addLog('✓ Datos subidos correctamente');
                      setSyncMsg('✓ Datos subidos al Gist');
                      await loadSettings();
                      await loadSubjects();
                    } else {
                      addLog(`✗ Error al subir: ${result.error ?? 'desconocido'}`, false);
                      setSyncMsg('Error: ' + (result.error ?? 'desconocido'));
                    }
                    setSyncing(false);
                    setTimeout(() => setSyncMsg(''), 8000);
                  }}
                  disabled={syncing}
                  loading={syncing}
                >
                  ↑ Subir cambios
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    setSyncing(true);
                    setSyncMsg('');
                    // Si el Gist ID del input difiere del guardado, guardarlo antes de sync
                    const pendingGistId = syncGistId.trim();
                    if (pendingGistId && pendingGistId !== settings.syncGistId) {
                      if (pendingGistId.startsWith('ghp_') || pendingGistId.startsWith('github_pat_')) {
                        addLog('✗ El Gist ID parece ser el Token — no es lo mismo', false);
                        setSyncing(false);
                        return;
                      }
                      await updateSettings({ syncGistId: pendingGistId });
                      addLog(`Gist ID actualizado: ${pendingGistId.slice(0, 12)}…`);
                    }
                    addLog('Conectando con GitHub…');
                    const result = await pullFromGist(githubToken);
                    if (result.success) {
                      if (result.direction === 'skip') {
                        addLog('✓ Ya estás al día, sin cambios remotos');
                        setSyncMsg('✓ Ya estás al día, sin cambios remotos');
                      } else {
                        addLog(`✓ Merge completo: +${result.added ?? 0} nuevos, ~${result.updated ?? 0} actualizados, ${result.skipped ?? 0} sin cambios`);
                        setSyncMsg(`✓ Sincronizado: ${result.added ?? 0} nuevos, ${result.updated ?? 0} actualizados`);
                        await loadSettings();
                        await loadSubjects();
                      }
                    } else {
                      addLog(`✗ Error: ${result.error ?? 'desconocido'}`, false);
                      setSyncMsg('Error: ' + (result.error ?? 'desconocido'));
                    }
                    setSyncing(false);
                    setTimeout(() => setSyncMsg(''), 8000);
                  }}
                  disabled={syncing || !settings.syncGistId}
                  loading={syncing}
                >
                  ↓ Descargar cambios
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    setSyncing(true);
                    setSyncMsg('');
                    addLog('Forzando re-descarga completa…');
                    const result = await pullFromGist(githubToken, true);
                    if (result.success) {
                      addLog(`✓ Merge completo: +${result.added ?? 0} nuevos, ~${result.updated ?? 0} actualizados, ${result.skipped ?? 0} sin cambios`);
                      setSyncMsg(`✓ Re-descarga: ${result.added ?? 0} nuevos, ${result.updated ?? 0} actualizados`);
                      await loadSettings();
                      await loadSubjects();
                    } else {
                      addLog(`✗ Error: ${result.error ?? 'desconocido'}`, false);
                      setSyncMsg('Error: ' + (result.error ?? 'desconocido'));
                    }
                    setSyncing(false);
                    setTimeout(() => setSyncMsg(''), 8000);
                  }}
                  disabled={syncing || !settings.syncGistId}
                  loading={syncing}
                  title="Ignora el timestamp y fuerza merge completo (útil si faltan PDFs)"
                >
                  ↻ Forzar re-descarga
                </Button>
              </div>

              {syncMsg && (
                <p className={`text-xs ${syncMsg.startsWith('Error') ? 'text-rose-400' : 'text-sage-400'}`}>
                  {syncMsg}
                </p>
              )}

              {/* Log de sync */}
              {syncLog.length > 0 && (
                <div className="bg-ink-900 border border-ink-700 rounded-lg p-2 max-h-32 overflow-y-auto font-mono">
                  {syncLog.map((entry, i) => (
                    <div key={i} className="flex gap-2 text-[11px] leading-5">
                      <span className="text-ink-600 flex-shrink-0">{entry.ts}</span>
                      <span className={entry.ok ? 'text-ink-300' : 'text-rose-400'}>{entry.msg}</span>
                    </div>
                  ))}
                  <div ref={syncLogEndRef} />
                </div>
              )}

              {/* Configuración — Gist ID + token, todo visible */}
              <div className="flex flex-col gap-3 border-t border-ink-800 pt-4">

                {/* Token */}
                <p className="text-xs text-ink-500 font-medium">Token de GitHub</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="flex-1 bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-200 placeholder-ink-600 focus:outline-none focus:border-amber-500/60 font-mono"
                    autoComplete="off"
                  />
                  <Button size="sm" variant="secondary" onClick={handleSaveGithubToken}>Guardar</Button>
                </div>

                {/* Gist ID */}
                <p className="text-xs text-ink-500 font-medium">Gist ID</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={syncGistId}
                    onChange={(e) => setSyncGistId(e.target.value)}
                    placeholder="Se crea al subir por primera vez..."
                    className="flex-1 bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-200 placeholder-ink-600 focus:outline-none focus:border-amber-500/60 font-mono"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      const val = syncGistId.trim();
                      if (val.startsWith('ghp_') || val.startsWith('github_pat_')) {
                        setSyncMsg('⚠ Eso es el Token, no el Gist ID. El Gist ID se genera solo al subir por primera vez.');
                        setTimeout(() => setSyncMsg(''), 6000);
                        return;
                      }
                      try {
                        await updateSettings({ syncGistId: val });
                        // Verificar persistencia
                        const check = await getSettings();
                        if (check.syncGistId !== val) {
                          setSyncMsg('⚠ El Gist ID no se persistió — revisa permisos del navegador');
                          setTimeout(() => setSyncMsg(''), 8000);
                          return;
                        }
                        setSyncMsg('✓ Gist ID guardado.');
                        setTimeout(() => setSyncMsg(''), 4000);
                      } catch (err) {
                        setSyncMsg('Error al guardar Gist ID: ' + String(err));
                        setTimeout(() => setSyncMsg(''), 8000);
                      }
                    }}
                  >
                    Guardar
                  </Button>
                </div>

                {gistExportMsg && (
                  <p className={`text-xs ${gistExportMsg.startsWith('Error') ? 'text-rose-400' : 'text-sage-400'}`}>
                    {gistExportMsg}
                  </p>
                )}
              </div>
            </div>
        </Card>

        {/* Export contribution */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">Exportar mis preguntas</h2>
          <p className="text-sm text-ink-500 mb-4">
            Genera un <code className="text-amber-400 bg-ink-900 px-1 py-0.5 rounded text-xs">contribution pack</code> para compartir con el mantenedor del banco global.
            Puedes descargarlo como JSON o publicarlo directamente como GitHub Gist para compartir por URL.
          </p>
          {!alias && (
            <p className="text-xs text-amber-400 mb-3">⚠ Define tu alias antes de exportar</p>
          )}
          <div className="flex flex-col gap-3">
            <Select
              label="Asignatura"
              value={exportSubjectId}
              onChange={(e) => setExportSubjectId(e.target.value)}
            >
              <option value="">Selecciona una asignatura...</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>

            {/* Botones de exportación */}
            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleExportContribution}
                disabled={!exportSubjectId}
                title="Descarga el pack como archivo JSON"
              >
                ↓ Descargar JSON
              </Button>
              <Button
                size="sm"
                onClick={handleExportToGist}
                disabled={!exportSubjectId || exportingGist}
                loading={exportingGist}
                title="Publica el pack como Gist privado en GitHub y obtén una URL para importar"
              >
                ⬡ Publicar en Gist
              </Button>
            </div>

            {/* Mensaje de resultado del Gist */}
            {gistExportMsg && (
              <p className={`text-xs ${gistExportMsg.startsWith('Error') ? 'text-rose-400' : 'text-sage-400'}`}>
                {gistExportMsg}
              </p>
            )}

            {/* URL raw generada — lista para copiar o pegar en "Importar por URL" */}
            {lastGistUrl && (
              <div className="flex flex-col gap-2 p-3 bg-sage-600/10 border border-sage-600/20 rounded-lg">
                <p className="text-xs text-sage-400 font-medium">✓ Gist creado — URL para importar:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs text-ink-300 bg-ink-800 px-2 py-1 rounded font-mono break-all">
                    {lastGistUrl}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(lastGistUrl); }}
                    className="flex-shrink-0 text-xs text-ink-400 hover:text-ink-200 border border-ink-600 hover:border-ink-500 px-2 py-1 rounded transition-colors"
                    title="Copiar URL al portapapeles"
                  >
                    Copiar
                  </button>
                </div>
                {/* QR code para compartir fácilmente en clase */}
                <div className="flex items-start gap-3 pt-1 border-t border-sage-600/20 mt-1">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&bgcolor=0f0f14&color=e2e8f0&data=${encodeURIComponent(lastGistUrl)}`}
                    alt="QR code para importar el pack"
                    className="w-[70px] h-[70px] rounded border border-ink-700 flex-shrink-0"
                    loading="lazy"
                  />
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-ink-300 font-medium">Código QR para compartir</p>
                    <p className="text-xs text-ink-500 leading-relaxed">
                      Muéstralo en clase: tus compañeros escanean el QR, copian la URL y la pegan en{' '}
                      <span className="text-ink-400">Ajustes → Importar contribuciones → Importar por URL</span>.
                    </p>
                    <button
                      onClick={() => setImportUrl(lastGistUrl)}
                      className="text-xs text-amber-400 hover:text-amber-300 text-left transition-colors mt-0.5 underline underline-offset-2"
                      title="Usar esta URL para importar directamente aquí"
                    >
                      Usar para importar aquí →
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        </Card>

        {/* Exportar paquete del marketplace */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">Exportar paquete del marketplace</h2>
          <p className="text-sm text-ink-500 mb-4">
            Genera un paquete <code className="text-amber-400 bg-ink-900 px-1 py-0.5 rounded text-xs">.examcoach.zip</code> (manifest + banco de preguntas + recursos)
            listo para subir como <span className="text-ink-400">GitHub Release</span> y publicarlo en el marketplace.
            Útil para mover las asignaturas que creaste en la app desplegada a paquetes instalables.
          </p>
          <div className="flex flex-col gap-3">
            <Select
              label="Asignatura"
              value={pkgExportSubjectId}
              onChange={(e) => setPkgExportSubjectId(e.target.value)}
            >
              <option value="">Selecciona una asignatura...</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>

            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleExportAllMarketplacePackages}
                disabled={exportingPkg || subjects.length === 0}
                loading={exportingPkg && !pkgExportSubjectId}
                title="Descarga un .examcoach.zip por cada asignatura"
              >
                ↓ Descargar todas ({subjects.length})
              </Button>
              <Button
                size="sm"
                onClick={handleExportMarketplacePackage}
                disabled={!pkgExportSubjectId || exportingPkg}
                loading={exportingPkg && !!pkgExportSubjectId}
                title="Descarga el paquete .examcoach.zip de la asignatura seleccionada"
              >
                ↓ Descargar paquete
              </Button>
            </div>
          </div>
        </Card>

        {/* Exportar banco compacto para ChatGPT */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">
            Exportar banco compacto (para ChatGPT)
          </h2>
          <p className="text-sm text-ink-500 mb-4">
            Exporta preguntas en formato ultra-compacto (solo tipo, prompt y hash).
            Ideal para pasarle a ChatGPT el banco de preguntas existente y evitar repeticiones
            al crear contribution packs.
          </p>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Select
                  label="Asignatura"
                  value={compactExportSubjectId}
                  onChange={(e) => setCompactExportSubjectId(e.target.value)}
                >
                  <option value="">Selecciona una asignatura...</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  onClick={handleExportCompactSubject}
                  disabled={!compactExportSubjectId}
                >
                  ⚡ Exportar una asignatura
                </Button>
              </div>

              <div className="flex flex-col justify-end">
                <Button
                  size="sm"
                  onClick={handleExportAllCompact}
                  disabled={subjects.length === 0}
                >
                  📦 Exportar todas
                </Button>
              </div>
            </div>

            <div className="bg-ink-800 border border-ink-700 rounded-lg p-3">
              <p className="text-xs text-ink-400 mb-2 font-medium">Formato de salida:</p>
              <pre className="text-xs text-ink-300 font-mono overflow-x-auto">
{`{
  "asignatura": "Técnicas de Aprendizaje Automático",
  "slug": "tecnicas-de-aprendizaje-automatico",
  "total": 150,
  "preguntas": [
    {
      "t": "T",  // T=TEST, D=DESARROLLO, C=COMPLETAR, P=PRACTICO
      "p": "¿Qué puede aprender examinando...",
      "h": "sha256:...",
      "tp": "tema-8-aprendizaje-supervisado"
    }
  ]
}`}
              </pre>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <p className="text-xs text-amber-400">
                <strong>💡 Uso recomendado:</strong> Exporta la asignatura, copia el JSON y pégaselo a ChatGPT
                junto con tu prompt de "crea 20 preguntas nuevas para el tema X". ChatGPT verá las preguntas
                existentes y evitará duplicarlas. El formato compacto usa ~90% menos caracteres que el global-bank.json.
              </p>
            </div>
          </div>
        </Card>

        {/* Generate contribution guide */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">Guía de contribución personalizada</h2>
          <p className="text-sm text-ink-500 mb-4">
            Genera una guía <code className="text-amber-400 bg-ink-900 px-1 py-0.5 rounded text-xs">GUIA_CONTRIBUTION_PACKS.md</code> con los slugs exactos de tus asignaturas y temas.
            Comparte esta guía con tus compañeros o con ChatGPT para que genere packs compatibles con tu banco.
          </p>
          <Button size="sm" variant="secondary" onClick={downloadContributionGuide}>
            📋 Descargar guía personalizada
          </Button>
        </Card>

        {/* Import contribution (maintainer mode) */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">Importar contribuciones</h2>
          <p className="text-sm text-ink-500 mb-4">
            Modo mantenedor: importa packs de tus compañeros y fusiónelos con el banco global. Dedupe automático por contenido.
            Puedes seleccionar un archivo JSON o pegar directamente una URL (GitHub Gist u otra URL pública al JSON).
          </p>

          {importMsg && (
            <div className={`mb-4 px-3 py-2.5 rounded-lg text-sm border ${
              importMsg.startsWith('Error') ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' :
              importMsg.startsWith('ℹ') ? 'bg-ink-700 border-ink-600 text-ink-300' :
              'bg-sage-600/10 border-sage-600/20 text-sage-400'
            }`}>
              {importMsg}
            </div>
          )}

          {/* Opción A: archivo JSON (comportamiento original) */}
          <div className="flex flex-col gap-3">
            <label className="cursor-pointer">
              <input type="file" accept=".json" multiple className="hidden" onChange={handleImportContribution} />
              <span className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-ink-600 bg-ink-800 text-ink-300 hover:text-ink-100 hover:border-ink-500 text-sm font-medium font-body transition-all cursor-pointer">
                ↓ Seleccionar contribution pack(s) · JSON
              </span>
            </label>

            {/* Opción B: URL (Gist u otra) */}
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-500 font-medium uppercase tracking-widest">O importar desde URL</p>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleImportFromUrl(); }}
                  placeholder="https://gist.github.com/usuario/abc123 o URL directa al JSON"
                  className="flex-1 bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-200 placeholder-ink-600 focus:outline-none focus:border-amber-500/60"
                />
                <Button
                  size="sm"
                  onClick={handleImportFromUrl}
                  disabled={!importUrl.trim() || importingUrl}
                  loading={importingUrl}
                >
                  Importar
                </Button>
              </div>
              <p className="text-xs text-ink-600">
                Las URLs de GitHub Gist se convierten automáticamente a su versión raw.
              </p>
            </div>
          </div>

          {unmatchedTopics.length > 0 && (
            <div className="mt-4 p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <p className="text-sm text-amber-400 font-medium mb-3">
                Temas no encontrados — asigna cada uno a un tema existente:
              </p>
              <div className="flex flex-col gap-3">
                {unmatchedTopics.map((ut) => (
                  <div key={`${ut.subjectKey}::${ut.topicKey}`} className="flex flex-col gap-1">
                    <p className="text-xs text-ink-300">
                      <span className="text-ink-500">{ut.subjectKey} →</span> {ut.topicTitle} <span className="text-ink-500">({ut.questionCount} preguntas)</span>
                    </p>
                    <select
                      className="w-full bg-ink-800 border border-ink-600 rounded px-2 py-1.5 text-sm text-ink-200"
                      value={topicMappings[`${ut.subjectKey}::${ut.topicKey}`] ?? ''}
                      onChange={(e) => {
                        setTopicMappings((prev) => ({
                          ...prev,
                          [`${ut.subjectKey}::${ut.topicKey}`]: e.target.value,
                        }));
                      }}
                    >
                      <option value="">— Selecciona un tema existente —</option>
                      {allTopicsForMapping.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.subjectName} → {t.title}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-4">
                <Button
                  size="sm"
                  onClick={handleRetryWithMappings}
                  disabled={unmatchedTopics.some((ut) => !topicMappings[`${ut.subjectKey}::${ut.topicKey}`])}
                >
                  Reimportar con asignaciones
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setUnmatchedTopics([]); setTopicMappings({}); }}>
                  Ignorar
                </Button>
              </div>
            </div>
          )}

          {importedPacks.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-ink-500 uppercase tracking-widest mb-2">Packs ya importados</p>
              <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                {importedPacks.map((id) => (
                  <code key={id} className="text-xs text-ink-600 font-mono">{id}</code>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Anki Import */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-2">Importar desde Anki</h2>
          <p className="text-xs text-ink-500 mb-3">
            Importa tarjetas desde un archivo .tsv exportado de Anki. Las tarjetas se crearán como preguntas de tipo Desarrollo en la asignatura que elijas.
          </p>
          <div className="flex flex-col gap-3">
            <Select
              value={exportSubjectId}
              onChange={(e) => setExportSubjectId(e.target.value)}
            >
              <option value="">Selecciona una asignatura...</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <label className={`cursor-pointer inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border transition-colors ${exportSubjectId ? 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10' : 'border-ink-700 text-ink-600 cursor-not-allowed'}`}>
              <input
                type="file"
                accept=".tsv,.txt"
                disabled={!exportSubjectId}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !exportSubjectId) return;
                  e.target.value = '';
                  try {
                    const text = await file.text();
                    const cards = parseAnkiTsv(text);
                    if (cards.length === 0) {
                      setAnkiImportMsg('No se encontraron tarjetas válidas en el archivo.');
                      return;
                    }
                    // Get first topic of subject to assign
                    const topics = await db.topics.where('subjectId').equals(exportSubjectId).toArray();
                    const topicId = topics[0]?.id;
                    if (!topicId) {
                      setAnkiImportMsg('La asignatura debe tener al menos un tema para importar.');
                      return;
                    }
                    let count = 0;
                    for (const card of cards) {
                      // Use the store's createQuestion function
                      await createQuestion({
                        subjectId: exportSubjectId,
                        topicId,
                        type: 'DESARROLLO',
                        prompt: card.front,
                        modelAnswer: card.back,
                        tags: card.tags.length > 0 ? card.tags : undefined,
                      });
                      count++;
                    }
                    setAnkiImportMsg(`✓ ${count} tarjetas importadas como preguntas de Desarrollo.`);
                  } catch (err) {
                    setAnkiImportMsg('Error: ' + String(err));
                  }
                }}
              />
              📥 Seleccionar archivo .tsv de Anki
            </label>
            {ankiImportMsg && (
              <p className={`text-xs ${ankiImportMsg.startsWith('✓') ? 'text-sage-400' : 'text-rose-400'}`}>
                {ankiImportMsg}
              </p>
            )}
          </div>
        </Card>

        {importHistory.length > 0 && (
  <Card>
    <h2 className="font-display text-base text-ink-200 mb-1">Historial de importaciones</h2>
    <p className="text-sm text-ink-500 mb-4">
      Puedes revertir cualquier contribution pack importado. Esto elimina las preguntas de ese pack de tu base de datos.
    </p>
    {undoMsg && (
      <p className="text-sm text-sage-400 mb-3">{undoMsg}</p>
    )}
    <div className="flex flex-col gap-2">
      {[...importHistory].reverse().map(entry => (
        <div key={entry.packId} className="flex items-start justify-between gap-3 p-3 bg-ink-850 rounded-lg border border-ink-700">
          <div className="flex flex-col gap-0.5 min-w-0">
            <p className="text-sm text-ink-200 font-medium">{entry.createdBy}</p>
            <p className="text-xs text-ink-500 truncate">
              {entry.subjectNames.join(', ')} · {entry.questionCount} preguntas
            </p>
            <p className="text-xs text-ink-700">
              {new Date(entry.importedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
          <button
            onClick={() => handleUndo(entry.packId)}
            disabled={undoingPackId === entry.packId}
            className="text-xs text-rose-500 hover:text-rose-300 border border-rose-800 hover:border-rose-500 px-2 py-1 rounded transition-colors flex-shrink-0 disabled:opacity-50"
          >
            {undoingPackId === entry.packId ? 'Eliminando…' : 'Revertir'}
          </button>
        </div>
      ))}
    </div>
  </Card>
)}




        {/* ── Almacenamiento ─────────────────────────────────────────────────── */}
        <Card>
          <h2 className="font-display text-base text-ink-200 mb-4">Almacenamiento</h2>

          {/* Barra de quota IndexedDB */}
          {storageInfo && (
            <div className="flex flex-col gap-2 mb-5">
              <div className="flex items-center justify-between">
                <p className="text-sm text-ink-400">Quota IndexedDB</p>
                <button
                  onClick={refreshStorageStatus}
                  className="text-xs text-ink-600 hover:text-ink-400 transition-colors"
                  title="Actualizar"
                >
                  ↺ Actualizar
                </button>
              </div>
              <div className="w-full h-2.5 bg-ink-800 rounded-full overflow-hidden">
                {storageInfo.quota > 0 && (
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      storageInfo.used / storageInfo.quota > 0.95
                        ? 'bg-rose-500'
                        : storageInfo.used / storageInfo.quota > 0.8
                        ? 'bg-amber-500'
                        : 'bg-sage-500'
                    }`}
                    style={{ width: `${Math.min(100, (storageInfo.used / storageInfo.quota) * 100).toFixed(1)}%` }}
                  />
                )}
              </div>
              <div className="flex justify-between text-xs text-ink-500">
                <span>Usado: <span className="text-ink-300 font-medium">{formatBytes(storageInfo.used)}</span></span>
                {storageInfo.quota > 0 && (
                  <span>
                    Libre: <span className={`font-medium ${storageInfo.used / storageInfo.quota > 0.8 ? 'text-amber-400' : 'text-ink-300'}`}>
                      {formatBytes(storageInfo.quota - storageInfo.used)}
                    </span>
                    {' '}/ {formatBytes(storageInfo.quota)}
                  </span>
                )}
              </div>
              {storageInfo.quota > 0 && storageInfo.used / storageInfo.quota > 0.8 && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                  <span className="text-amber-400 text-base leading-none mt-0.5">⚠</span>
                  <p className="text-xs text-amber-300">
                    Más del 80% de la quota ocupada. Considera activar la carpeta de disco (abajo)
                    para guardar los PDFs fuera de IndexedDB y liberar espacio.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Storage persistence */}
          <div className="flex flex-col gap-2 pb-5 border-b border-ink-800 mb-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-300 font-medium">Protección contra borrado automático</p>
                <p className="text-xs text-ink-500 mt-0.5">
                  Chrome puede borrar datos de IndexedDB cuando el disco está lleno.
                  El storage persistente lo evita.
                </p>
              </div>
              {isPersistent === null ? (
                <span className="text-xs text-ink-600">–</span>
              ) : isPersistent ? (
                <span className="flex items-center gap-1.5 text-xs text-sage-400 font-medium">
                  <span className="w-2 h-2 rounded-full bg-sage-400 flex-shrink-0" />
                  Protegido
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleRequestPersistence}
                  loading={requestingPersistence}
                >
                  Activar protección
                </Button>
              )}
            </div>
            {isPersistent === false && (
              <p className="text-xs text-ink-600">
                Chrome suele conceder el permiso automáticamente si la app está instalada como PWA
                o si la usas frecuentemente.
              </p>
            )}
          </div>

          {/* File System Access API / OPFS */}
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm text-ink-300 font-medium">Almacenamiento externo para archivos</p>
              <p className="text-xs text-ink-500 mt-0.5">
                Guarda PDFs fuera de IndexedDB para evitar el límite de quota del navegador.
                En escritorio elige una carpeta del disco; en móvil se usa el almacenamiento interno de la app.
              </p>
            </div>

            {fsaFolderName ? (
              /* ── Carpeta / OPFS activo ──────────────────────────────────── */
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 px-3 py-2.5 bg-sage-600/10 border border-sage-600/20 rounded-lg">
                  <span className="text-sage-400 text-base">{activeFolderType === 'opfs' ? '📱' : '📁'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-sage-300 font-medium truncate">{fsaFolderName}</p>
                    <p className="text-xs text-ink-500">
                      {activeFolderType === 'opfs'
                        ? 'Almacenamiento privado de la app — sin límite de quota del navegador'
                        : 'Los nuevos archivos se guardan en esta carpeta del disco'}
                    </p>
                  </div>
                  <button
                    onClick={handleClearFolder}
                    className="text-xs text-ink-500 hover:text-rose-400 transition-colors flex-shrink-0"
                    title="Desconectar"
                  >
                    Desconectar
                  </button>
                </div>

                {/* Migración */}
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-ink-500">
                    ¿Tienes PDFs en IndexedDB? Muévelos para liberar quota.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleMigrate}
                    loading={migrating}
                    disabled={migrating}
                  >
                    📦 Migrar archivos de IndexedDB
                  </Button>
                  {migrationResult && (
                    <p className="text-xs text-ink-400">
                      {migrationResult.migrated} archivos migrados
                      {migrationResult.freedBytes > 0 && ` · ${formatBytes(migrationResult.freedBytes)} liberados`}
                      {migrationResult.failed > 0 && ` · ${migrationResult.failed} fallaron`}
                    </p>
                  )}
                </div>
              </div>
            ) : fsaSupported ? (
              /* ── FSA disponible (escritorio) ────────────────────────────── */
              <div className="flex flex-col gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleSelectFolder}
                  loading={selectingFolder}
                  disabled={selectingFolder}
                >
                  📂 Elegir carpeta de disco
                </Button>
                <p className="text-xs text-ink-600">
                  Se pedirá permiso de lectura/escritura. El permiso se renueva automáticamente
                  en Chrome cada vez que abres la app.
                </p>
              </div>
            ) : opfsSupported ? (
              /* ── Solo OPFS disponible (Android / Firefox / Safari) ─────── */
              <div className="flex flex-col gap-3">
                <div className="px-3 py-2.5 bg-sky-500/10 border border-sky-500/20 rounded-lg">
                  <p className="text-xs text-sky-300 font-medium mb-1">📱 Almacenamiento interno disponible</p>
                  <p className="text-xs text-ink-400">
                    En Android Chrome no es posible elegir una carpeta del sistema, pero puedes activar
                    el <strong className="text-sky-300">almacenamiento interno de la app</strong> (OPFS).
                    Los PDFs se guardarán en el almacenamiento privado del navegador, sin límite de quota
                    y sin necesidad de permisos extra. Los archivos no son visibles en el explorador de archivos del sistema.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleActivateOpfs}
                  loading={activatingOpfs}
                  disabled={activatingOpfs}
                >
                  📱 Activar almacenamiento interno
                </Button>
              </div>
            ) : (
              /* ── Ninguna API disponible ──────────────────────────────────── */
              <div className="px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg flex flex-col gap-1.5">
                <p className="text-xs text-ink-400 font-medium">
                  Almacenamiento externo no disponible en este navegador
                </p>
                <p className="text-xs text-ink-500">
                  Si usas <strong className="text-ink-400">Brave</strong>, desactiva temporalmente Shields para esta página.
                  En otros navegadores usa Chrome o Edge 86+.
                </p>
              </div>
            )}

            {/* Mensaje de estado FSA */}
            {fsaMsg && (
              <p className={`text-xs ${fsaMsg.startsWith('Error') || fsaMsg.startsWith('⚠') ? 'text-amber-400' : 'text-sage-400'}`}>
                {fsaMsg}
              </p>
            )}
          </div>
        </Card>

        {/* Danger zone */}
        <Card className="border-rose-500/20">
          <h2 className="font-display text-base text-rose-400 mb-1">Zona de peligro</h2>
          <p className="text-sm text-ink-500 mb-4">
            {hoard
              ? 'Elimina los datos de este navegador. El servidor de Hypatia los conserva y se vuelven a descargar en la siguiente sincronización.'
              : 'Elimina todos los datos locales. Exporta el banco antes si quieres conservarlo.'}
          </p>
          <Button variant="danger" size="sm" onClick={handleClearData}>
            Borrar todos los datos
          </Button>
        </Card>

          {/* Developer tools: writes public/question-images/ through the Vite dev server. Under Hypatia's
              Hoard the images already reach the local server with every sync, so there is nothing to do. */}
        {!hoard && <Card>
          <h2 className="font-display text-base text-ink-200 mb-1">🛠 Herramientas de mantenedor</h2>
          <p className="text-sm text-ink-500 mb-4">
            Sincroniza las imágenes guardadas en IndexedDB con <code className="text-amber-400 bg-ink-900 px-1 py-0.5 rounded text-xs">public/question-images/</code> para poder commitearlas al repositorio.
            Solo funciona en modo desarrollo (<code className="text-amber-400 bg-ink-900 px-1 py-0.5 rounded text-xs">npm run dev</code>).
          </p>
          <Button
            size="sm"
            variant="secondary"
            loading={syncingImages}
            onClick={handleSyncImages}
          >
            🖼 Sincronizar imágenes a disco
          </Button>
          {imageSyncResult && (
            <div className="mt-3 text-sm text-ink-400">
              {imageSyncResult.errors.length > 0 ? (
                <span className="text-rose-400">
                  ✗ {imageSyncResult.errors.length} error(es): {imageSyncResult.errors[0]}
                </span>
              ) : (
                <span className="text-sage-400">
                  ✓ {imageSyncResult.total} imágenes — {imageSyncResult.synced} nuevas, {imageSyncResult.skipped} ya existían
                </span>
              )}
            </div>
          )}
        </Card>}
        {/* About */}
        <div className="text-center text-xs text-ink-700 pb-4">
          <p>{hoard ? "Hypatia's Hoard · local-first · servidor en tu PC · tus datos son tuyos" : 'StudyApp · local-first · sin backend · tus datos son tuyos'}</p>
          <p className="mt-1">Hypatia's Hoard · v2.0.0</p>
        </div>
      </main>

      {/* Modal preview contribution pack */}
      <Modal
        open={!!packPreview}
        onClose={async () => { setPackPreview(null); if (fileQueue.length > 0) await processNextInQueue(fileQueue); else setQueueTotal(0); }}
        title={queueTotal > 1 ? `Vista previa (${queueTotal - fileQueue.length}/${queueTotal})` : 'Vista previa del Contribution Pack'}
        size="lg"
      >
        {packPreview && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-sm text-ink-500 uppercase tracking-widest">Autor</p>
                  <p className="text-base text-ink-100 font-medium">{packPreview.createdBy}</p>
                </div>
                <div className="flex-1">
                  <p className="text-sm text-ink-500 uppercase tracking-widest">Exportado</p>
                  <p className="text-base text-ink-100 font-medium">
                    {new Date(packPreview.exportedAt).toLocaleDateString('es-ES')}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Card className="text-center py-3">
                  <p className="text-2xl font-display text-amber-400">{packPreview.topicsCount}</p>
                  <p className="text-xs text-ink-500 mt-1">Temas</p>
                </Card>
                <Card className="text-center py-3">
                  <p className="text-2xl font-display text-sage-400">{packPreview.questionsCount}</p>
                  <p className="text-xs text-ink-500 mt-1">Total preguntas</p>
                </Card>
                <Card className="text-center py-3 border-sage-600/30">
                  <p className="text-2xl font-display text-sage-300">{'newQuestionsCount' in packPreview ? (packPreview as any).newQuestionsCount : '?'}</p>
                  <p className="text-xs text-ink-500 mt-1">Nuevas</p>
                </Card>
              </div>

              {packPreview.alreadyImported && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                  <p className="text-sm text-amber-400">
                    ⚠ Este pack ya fue importado previamente.
                  </p>
                </div>
              )}

              {/* C1: Detailed per-topic breakdown table */}
              {'rows' in packPreview && (packPreview as any).rows.length > 0 && (
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
                        {(packPreview as any).rows.map((r: any, i: number) => (
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

              {packPreview.questionsSampleFull.length > 0 && (
                <div>
                  <p className="text-sm text-ink-500 uppercase tracking-widest mb-2">
                    Preguntas nuevas ({packPreview.questionsSampleFull.length})
                  </p>
                  <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                    {packPreview.questionsSampleFull.map((q, i) => (
                      <button
                        key={q.id ?? i}
                        onClick={() => setPreviewSampleQuestion(q)}
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

            <div className="flex justify-end gap-3 pt-4 border-t border-ink-800">
              <Button variant="ghost" onClick={async () => { setPackPreview(null); if (fileQueue.length > 0) await processNextInQueue(fileQueue); else setQueueTotal(0); }}>
                {fileQueue.length > 0 ? 'Saltar' : 'Cancelar'}
              </Button>
              <Button onClick={() => handleConfirmImport()} disabled={importing || ('newQuestionsCount' in packPreview && (packPreview as any).newQuestionsCount === 0)}>
                {importing ? '⏳ Importando…' : 'newQuestionsCount' in packPreview && (packPreview as any).newQuestionsCount > 0
                  ? `Importar ${(packPreview as any).newQuestionsCount} preguntas nuevas`
                  : 'Sin preguntas nuevas'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal preview pregunta individual (desde contribution pack) — debe estar DESPUÉS del modal de pack para quedar encima */}
      {previewSampleQuestion && (
        <Modal
          open={!!previewSampleQuestion}
          onClose={() => setPreviewSampleQuestion(null)}
          title={previewSampleQuestion.prompt.replace(/[#*`]/g, '').trim().slice(0, 60) + (previewSampleQuestion.prompt.length > 60 ? '…' : '')}
          size="lg"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <TypeBadge type={previewSampleQuestion.type} />
              {previewSampleQuestion.difficulty && (
                <span className="text-xs text-ink-500">{'★'.repeat(previewSampleQuestion.difficulty)}</span>
              )}
            </div>
            <QuestionPreviewContent question={previewSampleQuestion} />
            <div className="flex justify-end pt-2 border-t border-ink-800">
              <Button size="sm" variant="ghost" onClick={() => setPreviewSampleQuestion(null)}>
                Cerrar
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}