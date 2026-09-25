import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/ui/components';
import { fetchRegistry, downloadPackage, checkForUpdates } from '@/data/packageRegistry';
import { installPackage, listInstalled, uninstallPackage } from '@/data/packageManager';
import { decryptPackage } from '@/data/packageCrypto';
import { getSettings, saveSettings } from '@/data/db';
import type { RegistryEntry, InstalledPackage, PackageManifest } from '@/domain/models';
import type { InstallProgress } from '@/data/packageManager';

export function MarketplacePage() {
  const navigate = useNavigate();
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null); // packageId being installed
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const [reg, inst] = await Promise.all([
        fetchRegistry(forceRefresh),
        listInstalled(),
      ]);
      setRegistry(reg);
      setInstalled(inst);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Install ────────────────────────────────────────────────────────────────

  const handleInstall = async (entry: RegistryEntry) => {
    let password: string | undefined;

    // Si el paquete está cifrado, pedir/verificar contraseña
    if (entry.encrypted) {
      const settings = await getSettings();
      const saved = settings.marketplacePasswords?.[entry.id];
      if (saved) {
        password = saved;
      } else {
        const input = prompt(`Contraseña para "${entry.manifest.name}":`);
        if (!input) return;
        password = input;
      }
    }

    setInstalling(entry.id);
    setInstallProgress({ phase: 'reading' });
    try {
      const blob = await downloadPackage(entry.downloadUrl);

      let zipBlob: Blob;
      if (entry.encrypted && password) {
        setInstallProgress({ phase: 'reading', detail: 'Descifrando...' });
        const decrypted = await decryptPackage(await blob.arrayBuffer(), password);
        zipBlob = new Blob([decrypted]);

        // Contraseña correcta → guardarla para futuras actualizaciones
        const settings = await getSettings();
        const passwords = { ...(settings.marketplacePasswords ?? {}), [entry.id]: password };
        await saveSettings({ marketplacePasswords: passwords });
      } else {
        zipBlob = blob;
      }

      const result = await installPackage(zipBlob, setInstallProgress);
      if (result.success) {
        setToast(`${result.packageName} instalado — ${result.stats.questions} preguntas, ${result.stats.resources} recursos`);
        await loadData();
      } else {
        setToast(`Error: ${result.errors.join(', ')}`);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Contraseña incorrecta')) {
        // Borrar contraseña guardada si era incorrecta
        const settings = await getSettings();
        const passwords = { ...(settings.marketplacePasswords ?? {}) };
        delete passwords[entry.id];
        await saveSettings({ marketplacePasswords: passwords });
        setToast('Contraseña incorrecta. Inténtalo de nuevo.');
      } else {
        setToast(`Error: ${err}`);
      }
    } finally {
      setInstalling(null);
      setInstallProgress(null);
    }
  };

  // ── Uninstall ──────────────────────────────────────────────────────────────

  const handleUninstall = async (packageId: string) => {
    if (!confirm('¿Eliminar esta asignatura y todos sus datos?')) return;
    setUninstalling(packageId);
    try {
      await uninstallPackage(packageId);
      setToast('Paquete desinstalado');
      await loadData();
    } catch (err) {
      setToast(`Error: ${err}`);
    } finally {
      setUninstalling(null);
    }
  };

  // ── Manual ZIP import ──────────────────────────────────────────────────────

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setInstalling('__file__');
    setInstallProgress({ phase: 'reading' });
    try {
      const result = await installPackage(file, setInstallProgress);
      if (result.success) {
        setToast(`${result.packageName} instalado — ${result.stats.questions} preguntas`);
        await loadData();
      } else {
        setToast(`Error: ${result.errors.join(', ')}`);
      }
    } catch (err) {
      setToast(`Error: ${err}`);
    } finally {
      setInstalling(null);
      setInstallProgress(null);
    }
    e.target.value = '';
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const installedMap = new Map(installed.map(p => [p.id, p]));
  const updates = checkForUpdates(installed, registry);
  const updateIds = new Set(updates.map(u => u.id));

  const filtered = registry.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return e.manifest.name.toLowerCase().includes(q) ||
      e.manifest.description?.toLowerCase().includes(q) ||
      e.manifest.id.includes(q);
  });

  // ── Auto-dismiss toast ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-ink-950/95 backdrop-blur-sm border-b border-ink-800/60">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-ink-400 hover:text-ink-200 transition-colors">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd"/>
              </svg>
            </button>
            <div>
              <h1 className="font-display text-xl text-ink-100">Marketplace</h1>
              <p className="text-xs text-ink-500">Paquetes de asignaturas disponibles</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="cursor-pointer">
              <input type="file" accept=".zip" className="hidden" onChange={handleFileImport} disabled={!!installing} />
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-ink-700 transition-colors cursor-pointer">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clipRule="evenodd"/>
                </svg>
                Importar ZIP
              </span>
            </label>
            <Button variant="ghost" size="sm" onClick={() => loadData(true)} disabled={loading}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className={loading ? 'animate-spin' : ''}>
                <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd"/>
              </svg>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Buscar asignaturas…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl bg-ink-900 border border-ink-800 text-ink-100 placeholder-ink-500 focus:outline-none focus:border-amber-500/50 font-body text-sm"
          />
        </div>

        {/* Updates banner */}
        {updates.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <p className="text-sm text-amber-300 font-medium">
              {updates.length} actualización{updates.length !== 1 ? 'es' : ''} disponible{updates.length !== 1 ? 's' : ''}
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/30">
            <p className="text-sm text-rose-300">{error}</p>
            <p className="text-xs text-ink-500 mt-1">Comprueba tu conexión a internet e inténtalo de nuevo.</p>
          </div>
        )}

        {/* Loading */}
        {loading && registry.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <svg className="animate-spin w-8 h-8 text-amber-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm text-ink-500">Consultando catálogo…</p>
          </div>
        )}

        {/* Empty */}
        {!loading && registry.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <svg width="48" height="48" viewBox="0 0 20 20" fill="currentColor" className="text-ink-700">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd"/>
            </svg>
            <p className="text-ink-400">No hay paquetes publicados aún.</p>
            <p className="text-xs text-ink-600">Puedes importar un archivo .examcoach.zip manualmente.</p>
          </div>
        )}

        {/* Package grid */}
        {filtered.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map(entry => (
              <PackageCard
                key={entry.id}
                entry={entry}
                installed={installedMap.get(entry.id)}
                hasUpdate={updateIds.has(entry.id)}
                installing={installing === entry.id}
                uninstalling={uninstalling === entry.id}
                installProgress={installing === entry.id ? installProgress : null}
                onInstall={() => handleInstall(entry)}
                onUninstall={() => handleUninstall(entry.id)}
              />
            ))}
          </div>
        )}

        {/* Installed but not in registry */}
        {installed.filter(p => !registry.find(r => r.id === p.id)).length > 0 && (
          <>
            <h2 className="text-xs font-medium text-ink-500 uppercase tracking-widest mt-8 mb-4">Instalados localmente</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {installed
                .filter(p => !registry.find(r => r.id === p.id))
                .map(p => (
                  <LocalPackageCard
                    key={p.id}
                    pkg={p}
                    uninstalling={uninstalling === p.id}
                    onUninstall={() => handleUninstall(p.id)}
                  />
                ))}
            </div>
          </>
        )}
      </main>

      {/* Install progress overlay */}
      {installProgress && installing && (
        <div className="fixed inset-0 bg-ink-950/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-ink-900 border border-ink-800 rounded-2xl p-6 max-w-sm w-full mx-4 text-center">
            <svg className="animate-spin w-10 h-10 text-amber-500 mx-auto mb-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-sm text-ink-200 font-medium">
              {installProgress.phase === 'reading' && 'Leyendo paquete…'}
              {installProgress.phase === 'validating' && 'Validando…'}
              {installProgress.phase === 'importing-bank' && 'Importando preguntas…'}
              {installProgress.phase === 'importing-resources' && (
                installProgress.totalFiles
                  ? `Importando recursos (${installProgress.filesProcessed}/${installProgress.totalFiles})…`
                  : 'Importando recursos…'
              )}
              {installProgress.phase === 'complete' && 'Completado'}
            </p>
            {installProgress.detail && (
              <p className="text-xs text-ink-500 mt-1 truncate">{installProgress.detail}</p>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] px-4 py-3 rounded-xl shadow-2xl border border-ink-700 bg-ink-900/95 backdrop-blur-sm text-sm text-ink-200 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Package Card ────────────────────────────────────────────────────────────

function PackageCard({
  entry,
  installed,
  hasUpdate,
  installing,
  uninstalling,
  installProgress,
  onInstall,
  onUninstall,
}: {
  entry: RegistryEntry;
  installed?: InstalledPackage;
  hasUpdate: boolean;
  installing: boolean;
  uninstalling: boolean;
  installProgress: InstallProgress | null;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const m = entry.manifest;
  const isInstalled = !!installed;

  return (
    <div className={`rounded-xl border p-4 transition-colors ${
      isInstalled
        ? 'bg-ink-900/50 border-emerald-500/30'
        : 'bg-ink-900/30 border-ink-800 hover:border-ink-700'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="font-display text-sm text-ink-100 truncate">{m.name}</h3>
          <p className="text-xs text-ink-500">v{m.version} · {formatSize(entry.size)}</p>
        </div>
        {isInstalled && (
          <span className="flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            Instalado
          </span>
        )}
        {hasUpdate && (
          <span className="flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
            Actualización
          </span>
        )}
      </div>

      {/* Description */}
      {m.description && (
        <p className="text-xs text-ink-400 mb-3 line-clamp-2">{m.description}</p>
      )}

      {/* Stats */}
      <div className="flex gap-3 mb-3 text-[11px] text-ink-500">
        <span>{m.stats.questions} preguntas</span>
        <span>{m.stats.topics} temas</span>
        {m.stats.keyConcepts > 0 && <span>{m.stats.keyConcepts} conceptos</span>}
      </div>

      {/* Meta */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 text-[11px] text-ink-600">
        {m.professor && <span>{m.professor}</span>}
        {m.credits && <span>{m.credits} ECTS</span>}
        {m.year && <span>{m.year}</span>}
        {m.authors && m.authors.length > 0 && <span>por {m.authors.join(', ')}</span>}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {!isInstalled && (
          <button
            onClick={onInstall}
            disabled={installing}
            className="flex-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-ink-900 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            {installing ? 'Instalando…' : 'Instalar'}
          </button>
        )}
        {hasUpdate && (
          <button
            onClick={onInstall}
            disabled={installing}
            className="flex-1 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-ink-900 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            {installing ? 'Actualizando…' : 'Actualizar'}
          </button>
        )}
        {isInstalled && !hasUpdate && (
          <button
            onClick={onUninstall}
            disabled={uninstalling}
            className="px-3 py-1.5 rounded-lg text-xs text-ink-500 hover:text-rose-400 hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            {uninstalling ? 'Eliminando…' : 'Desinstalar'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Local Package Card ──────────────────────────────────────────────────────

function LocalPackageCard({
  pkg,
  uninstalling,
  onUninstall,
}: {
  pkg: InstalledPackage;
  uninstalling: boolean;
  onUninstall: () => void;
}) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/30 p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-display text-sm text-ink-100 truncate">{pkg.name}</h3>
        <span className="flex-shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-ink-800 text-ink-400">
          Local
        </span>
      </div>
      <p className="text-xs text-ink-500 mb-3">v{pkg.version} · instalado {formatDate(pkg.installedAt)}</p>
      <button
        onClick={onUninstall}
        disabled={uninstalling}
        className="px-3 py-1.5 rounded-lg text-xs text-ink-500 hover:text-rose-400 hover:bg-ink-800 transition-colors disabled:opacity-50"
      >
        {uninstalling ? 'Eliminando…' : 'Desinstalar'}
      </button>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}
