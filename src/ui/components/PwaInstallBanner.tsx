import { useEffect, useState } from 'react';

/**
 * Banner de instalación PWA.
 *
 * Se muestra cuando el navegador emite `beforeinstallprompt`, es decir,
 * cuando la app cumple los criterios de instalabilidad (HTTPS, SW, manifest…).
 * Funciona en Chrome/Edge en Android y escritorio. Safari/iOS no emite este
 * evento — en esos casos el usuario tiene que usar "Añadir a pantalla de inicio"
 * manualmente desde el menú de compartir.
 *
 * Se descarta de forma permanente (localStorage) si el usuario pulsa "Ahora no"
 * o si ya instaló la app.
 */

const DISMISS_KEY = 'pwa-install-dismissed';

// Tipado del evento no estándar que emite Chromium
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PwaInstallBanner() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Si el usuario ya descartó el banner permanentemente, no hacemos nada
    if (localStorage.getItem(DISMISS_KEY)) return;

    const handlePrompt = (e: Event) => {
      e.preventDefault(); // Evita que el navegador muestre el mini-banner nativo
      setPromptEvent(e as BeforeInstallPromptEvent);
    };

    const handleInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      // Ocultar el mensaje de "Instalado" después de 3 s
      setTimeout(() => setInstalled(false), 3000);
      localStorage.setItem(DISMISS_KEY, '1');
    };

    window.addEventListener('beforeinstallprompt', handlePrompt);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handlePrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!promptEvent) return;
    const evt = promptEvent;
    // Hide the banner immediately and persist dismiss so a page-reload (which
    // Chrome Android does mid-install) doesn't bring it back.
    setPromptEvent(null);
    localStorage.setItem(DISMISS_KEY, '1');
    setInstalling(true);
    try {
      await evt.prompt();
      // On Android Chrome the page often reloads before userChoice resolves.
      // That's fine — we already dismissed. On desktop we can check the outcome.
      const choice = await evt.userChoice;
      if (choice.outcome === 'dismissed') {
        // User cancelled the system dialog on desktop — let them see the banner again later
        localStorage.removeItem(DISMISS_KEY);
      }
    } catch {
      // Swallow errors (e.g. page reload interrupting the promise on Android)
    } finally {
      setInstalling(false);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setPromptEvent(null);
  };

  // ── Mensaje post-instalación ───────────────────────────────────────────────
  if (installed) {
    return (
      <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[9998] flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-2xl border border-sage-500/30 bg-ink-900/95 backdrop-blur-sm">
        <span className="text-sage-400 text-lg">✓</span>
        <p className="text-sm font-medium text-ink-100">¡Hypatia instalada!</p>
      </div>
    );
  }

  // ── Banner de instalación ──────────────────────────────────────────────────
  if (!promptEvent) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9998] flex flex-col gap-3 p-4 rounded-xl shadow-2xl border border-amber-400/20 bg-ink-900/97 backdrop-blur-sm max-w-xs w-full"
      role="dialog"
      aria-label="Instalar aplicación"
    >
      {/* Cabecera */}
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
          {/* Icono de descarga/instalar */}
          <svg className="w-5 h-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-100 leading-tight">Instala Hypatia</p>
          <p className="text-xs text-ink-400 mt-0.5 leading-snug">
            Accede más rápido, funciona sin conexión y ocupa menos espacio que una app nativa.
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-1 text-ink-500 hover:text-ink-300 hover:bg-ink-800 rounded-lg transition-colors"
          aria-label="Cerrar"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>

      {/* Beneficios rápidos */}
      <ul className="flex flex-col gap-1">
        {[
          { icon: '⚡', text: 'Abre al instante desde tu escritorio o móvil' },
          { icon: '📴', text: 'Estudia sin conexión a internet' },
          { icon: '🔔', text: 'Sin barra del navegador, pantalla completa' },
        ].map(({ icon, text }) => (
          <li key={text} className="flex items-center gap-2 text-xs text-ink-400">
            <span>{icon}</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>

      {/* Botones */}
      <div className="flex gap-2">
        <button
          onClick={handleInstall}
          disabled={installing}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-ink-900 text-xs font-semibold transition-colors"
        >
          {installing ? (
            <>
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Instalando…
            </>
          ) : (
            'Instalar ahora'
          )}
        </button>
        <button
          onClick={handleDismiss}
          className="px-3 py-2 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-400 hover:text-ink-200 text-xs font-medium transition-colors border border-ink-700"
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}
