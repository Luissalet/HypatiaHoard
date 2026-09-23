import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Empty, PageHeader, ProgressBar } from "../components/ui.jsx";
import { Markdown } from "../md.jsx";
import { GRADE_LABEL } from "../format.js";

const GRADES = [
  { grade: 0, key: "1", cls: "grade-again", label: GRADE_LABEL[0] },
  { grade: 1, key: "2", cls: "grade-hard", label: GRADE_LABEL[1] },
  { grade: 2, key: "3", cls: "grade-good", label: GRADE_LABEL[2] },
  { grade: 3, key: "4", cls: "grade-easy", label: GRADE_LABEL[3] },
];

export default function Repasar() {
  const { decks, act } = useApp();
  const [deckId, setDeckId] = useState("");
  const [queue, setQueue] = useState(null);
  const [index, setIndex] = useState(0);
  const [back, setBack] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [summary, setSummary] = useState(null);
  const startedRef = useRef(0);

  const load = useCallback(async () => {
    setSummary(null);
    const { queue } = await api.queue({ deck: deckId || undefined, limit: 200 });
    setQueue(queue);
    setIndex(0);
    setRevealed(false);
    setBack(null);
    startedRef.current = performance.now();
  }, [deckId]);

  useEffect(() => {
    load();
  }, [load]);

  const current = queue && queue[index];

  const reveal = useCallback(async () => {
    if (!current || revealed) return;
    setRevealed(true);
    const card = await api.card(current.id);
    setBack(card.back);
  }, [current, revealed]);

  const grade = useCallback(
    async (g) => {
      if (!current || !revealed) return;
      const elapsed = Math.round(performance.now() - startedRef.current);
      await act(() => api.review(current.id, g, elapsed));
      if (index + 1 >= queue.length) {
        setSummary({ total: queue.length });
        setQueue([]);
      } else {
        setIndex(index + 1);
        setRevealed(false);
        setBack(null);
        startedRef.current = performance.now();
      }
    },
    [act, current, revealed, index, queue],
  );

  useEffect(() => {
    function onKey(e) {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!revealed) reveal();
        return;
      }
      if (revealed && ["Digit1", "Digit2", "Digit3", "Digit4"].includes(e.code)) {
        const g = Number(e.code.slice(-1)) - 1;
        grade(g);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, reveal, grade]);

  return (
    <div className="mx-auto max-w-[720px]">
      <PageHeader title="Repasar" description="El frente, tu respuesta, y solo entonces el reverso.">
        <select className="field w-auto" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
          <option value="">Todos los mazos</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </PageHeader>

      {summary && (
        <div className="panel-white text-center">
          <p className="text-[18px] font-semibold">Sesión terminada</p>
          <p className="help mt-1">Has repasado {summary.total} tarjeta{summary.total === 1 ? "" : "s"}.</p>
          <button type="button" className="btn btn-primary mt-4" onClick={load}>Repasar más</button>
        </div>
      )}

      {!summary && queue && queue.length === 0 && (
        <Empty title="No hay tarjetas pendientes" action={<a className="btn btn-primary" href="#/tarjetas">Añadir tarjetas</a>}>
          Vuelve más tarde o añade tarjetas nuevas en Tarjetas.
        </Empty>
      )}

      {!summary && current && (
        <div>
          <div className="mb-3 flex items-center justify-between text-[12px]">
            <span className="help">{index + 1} de {queue.length} pendientes</span>
          </div>
          <ProgressBar pct={(index / queue.length) * 100} />

          <div className="review-card mt-4 flex-col">
            <div className="review-text"><Markdown text={current.front} /></div>
            {revealed && back !== null && (
              <div className="review-back">
                <div className="review-text" style={{ fontSize: "17px" }}><Markdown text={back} /></div>
                {current.source && <p className="help mt-3">Fuente: {current.source}</p>}
              </div>
            )}
          </div>

          {!revealed ? (
            <button type="button" className="btn btn-primary mt-5 w-full" onClick={reveal}>
              Mostrar respuesta <span className="help">(espacio)</span>
            </button>
          ) : (
            <div className="mt-5 flex gap-2">
              {GRADES.map((g) => (
                <button key={g.grade} type="button" className={`grade-btn ${g.cls}`} onClick={() => grade(g.grade)}>
                  {g.label}
                  <span className="key">{g.key}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
