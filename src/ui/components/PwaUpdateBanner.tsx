import { useEffect, useState } from 'react';

/**
 * Banner que aparece cuando hay una nueva versión de la app disponible.
 *
 * Con registerType: 'autoUpdate' (vite-plugin-pwa), el service worker nuevo
 * se instala automáticamente y llama a skipWaiting(). Esto dispara el evento
 * 'controllerchange' en el SW registrado. En ese momento la nueva versión está
 * activa pero la página sigue corriendo el JS/CSS viejo, así que hay que recargar.
 */
export function PwaUpdateBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // Evitar recarga en bucle: si acabamos de recargar por actualización, no mostrar banner
    let reloading = false;
    // En la primera visita no hay controller: el SW recién instalado toma el control
    // (clientsClaim) y dispara 'controllerchange' sin que haya ninguna versión nueva.
    const hadController = !!navigator.serviceWorker.controller;

    const handleControllerChange = () => {
      if (reloading || !hadController) return;
      setShowBanner(true);
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

    // También detectar si ya hay un SW esperando al montar el componente
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting) {
        setShowBanner(true);
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // El nuevo SW se instaló y hay un controller activo → hay actualización pendiente
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            setShowBanner(true);
          }
        });
      });
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, []);

  if (!showBanner) return null;

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border border-amber-400/30 bg-ink-900/95 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      {/* Icono */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
        <svg className="w-4 h-4 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
            clipRule="evenodd"
          />
        </svg>
      </div>

      {/* Texto */}
      <div className="flex flex-col">
        <p className="text-sm font-medium text-ink-100 leading-tight">Nueva versión disponible</p>
        <p className="text-xs text-ink-400 leading-tight">Recarga para aplicar la actualización</p>
      </div>

      {/* Botones */}
      <div className="flex items-center gap-2 ml-2">
        <button
          onClick={handleReload}
          className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-ink-900 text-xs font-semibold transition-colors"
        >
          Actualizar
        </button>
        <button
          onClick={() => setShowBanner(false)}
          className="p-1.5 rounded-lg text-ink-500 hover:text-ink-300 hover:bg-ink-800 transition-colors"
          aria-label="Cerrar"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
