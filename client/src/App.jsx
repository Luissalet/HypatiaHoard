import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { Toast } from "./components/ui.jsx";
import Repasar from "./pages/Repasar.jsx";
import Tarjetas from "./pages/Tarjetas.jsx";
import Mazos from "./pages/Mazos.jsx";
import Estadisticas from "./pages/Estadisticas.jsx";

const PAGES = [
  { path: "repasar", label: "Repasar", icon: "M12 3v18M5 8l7-5 7 5M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8", component: Repasar },
  { path: "tarjetas", label: "Tarjetas", icon: "M4 5h16v4H4zM4 11h16v8H4zM8 15h8", component: Tarjetas },
  { path: "mazos", label: "Mazos", icon: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z", component: Mazos },
  { path: "estadisticas", label: "Estadísticas", icon: "M4 20V10m5 10V4m5 16v-8m5 8V7", component: Estadisticas },
];

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

function useHashRoute() {
  const read = () => {
    const parts = window.location.hash.replace(/^#\/?/, "").split("/");
    return { page: parts[0] || "repasar", param: parts[1] || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function Icon({ d }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function App() {
  const route = useHashRoute();
  const [decks, setDecks] = useState([]);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const refreshDecks = useCallback(async () => {
    try {
      const { decks } = await api.decks();
      setDecks(decks);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    refreshDecks();
    const timer = setInterval(refreshDecks, 8000);
    return () => clearInterval(timer);
  }, [refreshDecks]);

  const notify = useCallback((message) => setToast(message), []);
  const act = useCallback(
    async (fn, okMessage) => {
      try {
        const result = await fn();
        if (okMessage) setToast(okMessage);
        await refreshDecks();
        return result;
      } catch (e) {
        setToast(e.message);
        throw e;
      }
    },
    [refreshDecks],
  );
  const value = useMemo(() => ({ decks, refreshDecks, notify, act }), [decks, refreshDecks, notify, act]);

  const page = PAGES.find((p) => p.path === route.page) || PAGES[0];
  const Component = page.component;
  const totalDue = decks.reduce((sum, d) => sum + (d.due || 0), 0);

  return (
    <AppContext.Provider value={value}>
      <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="sticky top-0 z-10 border-b md:h-dvh md:border-b-0 md:border-r" style={{ background: "var(--sidebar)", borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2 px-4 py-3 md:px-5 md:py-5">
            <span className="serif grid h-8 w-8 place-items-center rounded-md text-[15px] font-bold text-white" style={{ background: "var(--accent)" }}>H</span>
            <div className="leading-tight">
              <div className="text-[15px] font-semibold">Hypatia's Hoard</div>
              <div className="help text-[11px]">Tarjetas de repaso</div>
            </div>
          </div>
          <nav aria-label="Secciones" className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:px-3">
            {PAGES.map((p) => (
              <a key={p.path} href={`#/${p.path}`} className="nav-link shrink-0 text-[13px]" aria-current={p.path === page.path ? "page" : undefined}>
                <Icon d={p.icon} />
                {p.label}
                {p.path === "repasar" && totalDue > 0 && (
                  <span className="chip chip-accent ml-auto">{totalDue}</span>
                )}
              </a>
            ))}
          </nav>
          {decks.length > 0 && (
            <div className="hidden px-5 pt-4 md:block">
              <div className="help text-[11px]">Mazos</div>
              <div className="text-[13px]"><span className="num font-semibold">{decks.length}</span> mazos · <span className="num">{decks.reduce((s, d) => s + (d.cards || 0), 0)}</span> tarjetas</div>
              {totalDue > 0 && <div className="help mt-2 text-[11px]">Pendientes: <span className="num font-semibold" style={{ color: "var(--accent)" }}>{totalDue}</span></div>}
            </div>
          )}
        </aside>
        <main className="min-w-0 px-4 py-4 md:px-10 md:py-8">
          {error && (
            <div className="mb-4 rounded-md border p-4 text-[13px]" style={{ background: "var(--danger-bg)", color: "var(--danger-ink)", borderColor: "var(--danger-line)" }} role="alert">
              No se pudo contactar con Hypatia: {error}. <button type="button" className="btn-link" onClick={refreshDecks}>Reintentar</button>
            </div>
          )}
          <Component param={route.param} />
        </main>
      </div>
      <Toast message={toast} onClose={() => setToast(null)} />
    </AppContext.Provider>
  );
}
