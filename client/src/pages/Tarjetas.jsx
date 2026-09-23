import React, { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "../md.jsx";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Chip, Empty, PageHeader } from "../components/ui.jsx";
import { STATE_CHIP, STATE_LABEL } from "../format.js";

const EMPTY_FORM = { deck: "", front: "", back: "", tags: "", source: "" };

function CardForm({ decks, defaultDeck, initial, onSubmit, onCancel, submitLabel }) {
  const [form, setForm] = useState(initial || { ...EMPTY_FORM, deck: defaultDeck || "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="panel grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="label">Mazo</label>
          <select className="field" value={form.deck} onChange={set("deck")} required>
            <option value="" disabled>Elige un mazo</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Etiquetas (separadas por comas)</label>
          <input className="field" value={form.tags} onChange={set("tags")} placeholder="historia, examen" />
        </div>
      </div>
      <div>
        <label className="label">Frente (pregunta)</label>
        <textarea className="field" rows={2} value={form.front} onChange={set("front")} required />
      </div>
      <div>
        <label className="label">Reverso (respuesta)</label>
        <textarea className="field" rows={2} value={form.back} onChange={set("back")} required />
      </div>
      <div>
        <label className="label">Fuente</label>
        <input className="field" value={form.source} onChange={set("source")} placeholder="apuntes.pdf, p. 14" />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary">{submitLabel}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancelar</button>}
      </div>
    </form>
  );
}

export default function Tarjetas() {
  const { decks, act, notify } = useApp();
  const [filters, setFilters] = useState({ deck: "", tag: "", state: "", q: "" });
  const [cards, setCards] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [importDeck, setImportDeck] = useState("");
  const fileRef = useRef(null);

  const refresh = useCallback(async () => {
    const { cards } = await api.cards({ ...filters, limit: 200 });
    setCards(cards);
  }, [filters]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const deckName = (id) => decks.find((d) => d.id === id)?.name || `#${id}`;

  async function createCard(form) {
    await act(() =>
      api.addCard({ deck: Number(form.deck), front: form.front, back: form.back, source: form.source,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      "Tarjeta guardada.",
    );
    setShowNew(false);
    refresh();
  }

  async function updateCard(id, form) {
    await act(() =>
      api.updateCard(id, { deck: Number(form.deck), front: form.front, back: form.back, source: form.source,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      "Tarjeta actualizada.",
    );
    setEditingId(null);
    refresh();
  }

  async function removeCard(id) {
    if (!window.confirm("¿Eliminar esta tarjeta?")) return;
    await act(() => api.removeCard(id), "Tarjeta eliminada.");
    refresh();
  }

  async function toggleSuspend(card) {
    await act(() => (card.suspended ? api.unsuspendCard(card.id) : api.suspendCard(card.id)));
    refresh();
  }

  async function doImport() {
    const file = fileRef.current?.files?.[0];
    if (!importDeck || !file) return;
    const text = await file.text();
    const result = await act(() => api.importDeck(Number(importDeck), text));
    notify(`Importadas: ${result.created} nuevas, ${result.updated} actualizadas.`);
    refresh();
  }

  return (
    <div>
      <PageHeader title="Tarjetas" description="Busca, edita, suspende o elimina tus tarjetas.">
        <button type="button" className="btn btn-primary" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Cerrar" : "Nueva tarjeta"}
        </button>
      </PageHeader>

      {showNew && (
        <div className="mb-5">
          <CardForm decks={decks} onSubmit={createCard} onCancel={() => setShowNew(false)} submitLabel="Guardar" />
        </div>
      )}

      <div className="panel-white mb-5 grid gap-3 md:grid-cols-5">
        <input className="field md:col-span-2" placeholder="Buscar…" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
        <select className="field" value={filters.deck} onChange={(e) => setFilters((f) => ({ ...f, deck: e.target.value }))}>
          <option value="">Todos los mazos</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select className="field" value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))}>
          <option value="">Cualquier estado</option>
          {Object.entries(STATE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <input className="field" placeholder="Etiqueta" value={filters.tag} onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))} />
      </div>

      <div className="panel-white mb-5 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Importar/exportar mazo</label>
          <select className="field w-auto" value={importDeck} onChange={(e) => setImportDeck(e.target.value)}>
            <option value="">Elige un mazo</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <input ref={fileRef} type="file" accept=".json,.csv,text/*" className="field w-auto" />
        <button type="button" className="btn btn-sm" onClick={doImport} disabled={!importDeck}>Importar</button>
        {importDeck && (
          <a className="btn btn-sm" href={api.exportUrl(importDeck)} download={`mazo-${importDeck}.json`}>Exportar</a>
        )}
      </div>

      {cards.length === 0 ? (
        <Empty title="No hay tarjetas" action={<button className="btn btn-primary" onClick={() => setShowNew(true)}>Nueva tarjeta</button>}>
          Prueba a cambiar los filtros o crea tu primera tarjeta.
        </Empty>
      ) : (
        <div className="panel-white p-0">
          {cards.map((card) =>
            editingId === card.id ? (
              <div key={card.id} className="row block">
                <CardForm
                  decks={decks}
                  initial={{ deck: String(card.deck_id), front: card.front, back: card.back, tags: card.tags.join(", "), source: card.source }}
                  onSubmit={(form) => updateCard(card.id, form)}
                  onCancel={() => setEditingId(null)}
                  submitLabel="Actualizar"
                />
              </div>
            ) : (
              <div key={card.id} className="row">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{card.front}</div>
                  <Markdown text={card.back} className="help truncate block" />
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Chip className={STATE_CHIP[card.state]}>{STATE_LABEL[card.state]}</Chip>
                    <span className="help">{deckName(card.deck_id)}</span>
                    {card.tags.map((t) => <Chip key={t}>{t}</Chip>)}
                    {card.suspended && <Chip className="chip-warn">suspendida</Chip>}
                  </div>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => setEditingId(card.id)}>Editar</button>
                <button type="button" className="btn btn-sm" onClick={() => toggleSuspend(card)}>
                  {card.suspended ? "Reactivar" : "Suspender"}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => removeCard(card.id)}>Eliminar</button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
