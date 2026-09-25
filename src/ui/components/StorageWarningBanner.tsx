import { useEffect, useState } from 'react';
import { checkStorageQuota } from '@/data/fsaStorage';

/**
 * Banner global que aparece cuando la quota de IndexedDB supera el 80%.
 *
 * Se oculta automáticamente si:
 *   - La carpeta FSA está configurada (sin límite de quota)
 *   - El usuario lo cierra manualmente (se recuerda con sessionStorage)
 *   - El uso baja del 80% (p.ej. tras migrar PDFs a disco)
 *
 * Chequea el estado cada 5 minutos y también al montar.
 */
const DISMISS_KEY = 'storage-warning-dismissed';

export function StorageWarningBanner() {
  const [percentUsed, setPercentUsed] = useState<number>(0);
  const [visible, setVisible] = useState(false);

  const check = async () => {
    // Si ya fue descartado en esta sesión, no molestar de nuevo
    if (sessionStorage.getItem(DISMISS_KEY)) return;

    const result = await checkStorageQuota(0); // solo queremos el % actual
    if (result.fsaConfigured || result.percentUsed < 80) {
      setVisible(false);
      return;
    }
    setPercentUsed(Math.round(result.percentUsed));
    setVisible(true);
  };

  useEffect(() => {
    check();
    // Revisar cada 5 minutos
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  };

  const handleGoToSettings = () => {
    handleDismiss();
    // El banner está fuera del HashRouter, así que navegamos directamente con hash
    window.location.hash = '/settings';
  };

  if (!visible) return null;

  const isCritical = percentUsed >= 95;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9998] flex items-center justify-between gap-3 px-4 py-2.5 text-sm ${
        isCritical
          ? 'bg-rose-900/95 border-b border-rose-700/60 text-rose-100'
          : 'bg-amber-900/95 border-b border-amber-700/60 text-amber-100'
      } backdrop-blur-sm`}
      role="alert"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-shrink-0 text-base">{isCritical ? '🔴' : '🟡'}</span>
        <p className="text-xs leading-snug">
          <strong>Almacenamiento al {percentUsed}%.</strong>{' '}
          {isCritical
            ? 'Subir más archivos puede fallar. '
            : 'Espacio limitado en el navegador. '}
          Configura una carpeta de disco para guardar PDFs sin límite.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleGoToSettings}
          className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
            isCritical
              ? 'bg-rose-700 hover:bg-rose-600 text-white'
              : 'bg-amber-700 hover:bg-amber-600 text-white'
          }`}
        >
          Configurar
        </button>
        <button
          onClick={handleDismiss}
          className="text-xs opacity-60 hover:opacity-100 transition-opacity px-1"
          aria-label="Cerrar"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
