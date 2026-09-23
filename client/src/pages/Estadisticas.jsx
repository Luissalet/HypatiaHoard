import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { PageHeader, StatTile } from "../components/ui.jsx";
import { pct } from "../format.js";

const WEEKDAY = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

export default function Estadisticas() {
  const { decks } = useApp();
  const [deckId, setDeckId] = useState("");
  const [stats, setStats] = useState(null);

  const load = useCallback(async () => {
    setStats(await api.stats(deckId || undefined));
  }, [deckId]);
  useEffect(() => {
    load();
  }, [load]);

  const maxForecast = stats ? Math.max(1, ...stats.forecast_7d.map((d) => d.due)) : 1;

  return (
    <div>
      <PageHeader title="Estadísticas" description="Cómo va tu repaso.">
        <select className="field w-auto" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          <option value="">Todos los mazos</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </PageHeader>

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Tarjetas" value={stats.cards} />
            <StatTile label="Nuevas" value={stats.new} />
            <StatTile label="Aprendiendo" value={stats.learning} />
            <StatTile label="Repaso" value={stats.review} />
            <StatTile label="Olvidadas" value={stats.lapsed} />
            <StatTile label="Suspendidas" value={stats.suspended} />
            <StatTile label="Pendientes ahora" value={stats.due_now} />
            <StatTile label="Repasadas hoy" value={stats.reviewed_today} />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="panel-white">
              <div className="help">Retención (30 días)</div>
              <div className="stat-number num mt-1">{pct(stats.retention_30d)}</div>
              <p className="help mt-1">Bien o fácil sobre el total de repasos que no eran tarjetas nuevas.</p>
            </div>
            <div className="panel-white">
              <div className="help">Racha</div>
              <div className="stat-number num mt-1">{stats.streak_days} día{stats.streak_days === 1 ? "" : "s"}</div>
              <p className="help mt-1">Días consecutivos con al menos un repaso.</p>
            </div>
          </div>

          <div className="panel-white mt-5">
            <div className="help mb-3">Previsión de los próximos 7 días</div>
            <div className="forecast-bars">
              {stats.forecast_7d.map((day) => {
                const date = new Date(`${day.date}T00:00:00`);
                return (
                  <div key={day.date}>
                    <span className="num text-[12px] font-semibold">{day.due}</span>
                    <div className="forecast-col" style={{ height: `${Math.max(4, (day.due / maxForecast) * 70)}px` }} />
                    <span className="help text-[11px]">{WEEKDAY[date.getDay()]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
