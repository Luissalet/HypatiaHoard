import { Suspense, lazy } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';

// ── Rutas críticas: carga inmediata ────────────────────────────────────────
// Estas páginas se usan desde el primer segundo, no se difieren.
import { Dashboard } from './pages/Dashboard';
import { SubjectView } from './pages/SubjectView';
import { PracticeSessionPage } from './pages/PracticeSession';
import { ResultsPage } from './pages/Results';
import { SettingsPage } from './pages/Settings';

// ── Rutas pesadas: carga diferida (lazy) ───────────────────────────────────
// Se divide el bundle: PDF.js, TTS, stats y flashcards solo se descargan
// cuando el usuario navega a esas páginas por primera vez.
const FlashcardPage        = lazy(() => import('./pages/Flashcard').then(m => ({ default: m.FlashcardPage })));
const DeliverablesPage     = lazy(() => import('./pages/Deliverables').then(m => ({ default: m.DeliverablesPage })));
const StatsPage            = lazy(() => import('./pages/Stats').then(m => ({ default: m.StatsPage })));
const GlobalStatsPage      = lazy(() => import('./pages/GlobalStats').then(m => ({ default: m.GlobalStatsPage })));
const ReadModePage         = lazy(() => import('./pages/ReadMode').then(m => ({ default: m.ReadModePage })));
const PdfListenMode        = lazy(() => import('./pages/PdfListenMode').then(m => ({ default: m.PdfListenMode })));
const SessionHistoryPage   = lazy(() => import('./pages/SessionHistory').then(m => ({ default: m.SessionHistoryPage })));
const GlobalPracticePage   = lazy(() => import('./pages/GlobalPracticePage').then(m => ({ default: m.GlobalPracticePage })));
const PdfToolsPage         = lazy(() => import('./pages/PdfToolsPage').then(m => ({ default: m.PdfToolsPage })));
const MarketplacePage      = lazy(() => import('./pages/Marketplace').then(m => ({ default: m.MarketplacePage })));
// Cuaderno (Hypatia's Hoard): solo existe en el build local (VITE_HOARD=1); la página además
// comprueba isHoardMode(). En el build público la ruta ni se registra.
const NotebookPage         = import.meta.env.VITE_HOARD === '1'
  ? lazy(() => import('./pages/Notebook').then(m => ({ default: m.NotebookPage })))
  : null;

// ── Spinner de carga para rutas diferidas ──────────────────────────────────
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-ink-950">
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin w-8 h-8 text-amber-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-xs text-ink-500 font-body">Cargando…</p>
      </div>
    </div>
  );
}

export function AppRouter() {
  return (
    <HashRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/"                                      element={<Dashboard />} />
          <Route path="/marketplace"                              element={<MarketplacePage />} />
          <Route path="/pdf-tools"                             element={<PdfToolsPage />} />
          <Route path="/global-practice"                       element={<GlobalPracticePage />} />
          <Route path="/subject/:subjectId"                    element={<SubjectView />} />
          <Route path="/subject/:subjectId/stats"              element={<StatsPage />} />
          {NotebookPage && (
            <Route path="/subject/:subjectId/notebook"         element={<NotebookPage />} />
          )}
          <Route path="/subject/:subjectId/read/:topicId"      element={<ReadModePage />} />
          <Route path="/subject/:subjectId/listen/:topicId"    element={<PdfListenMode />} />
          <Route path="/subject/:subjectId/listen-resource"   element={<PdfListenMode />} />
          <Route path="/practice/:sessionId"                   element={<PracticeSessionPage />} />
          <Route path="/results/:sessionId"                    element={<ResultsPage />} />
          <Route path="/settings"                              element={<SettingsPage />} />
          <Route path="/flashcard/:subjectId"                  element={<FlashcardPage />} />
          <Route path="/deliverables"                          element={<DeliverablesPage />} />
          <Route path="/sessions"                              element={<SessionHistoryPage />} />
          <Route path="/stats"                                 element={<GlobalStatsPage />} />
          <Route path="*"                                      element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </HashRouter>
  );
}
