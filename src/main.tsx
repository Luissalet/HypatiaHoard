import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppRouter } from './ui/routes';
import { PwaUpdateBanner } from './ui/components/PwaUpdateBanner';
import { PwaInstallBanner } from './ui/components/PwaInstallBanner';
import { StorageWarningBanner } from './ui/components/StorageWarningBanner';
import { ThemeProvider } from './ui/context/ThemeContext';
import { startAutoSync } from './data/gistSync';
import { setProgressUpdater } from './utils/backgroundSynthesis';
import { useStore } from './ui/store';
import { setHoardDetection } from './data/hoardMode';
import './index.css';

// Arranca auto-sync con GitHub Gist (solo hace algo si hay token + gistId configurados)
startAutoSync();

// Hypatia's Hoard (solo en el build servido por el servidor local: npm run build:hoard).
// Import dinámico: el bundle público no carga nada de esto.
if (import.meta.env.VITE_HOARD === '1') {
  import('./data/hoardSync')
    .then((m) => m.bootHoard())
    .catch(() => setHoardDetection('off'));
}

// Conectar BackgroundSynthesisManager con el Zustand store
setProgressUpdater((jobId, progress) => {
  useStore.getState().setSynthesisProgress(jobId, progress);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppRouter />
      <PwaUpdateBanner />
      <PwaInstallBanner />
      <StorageWarningBanner />
    </ThemeProvider>
  </React.StrictMode>
);
