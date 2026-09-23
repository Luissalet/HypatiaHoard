import React, { useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { Empty, PageHeader } from "../components/ui.jsx";

export default function Mazos() {
  const { decks, act } = useApp();
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState(null); // deck id being renamed
  const [editValues, setEditValues] = useState({});

  async function createDeck(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await act(() => api.addDeck({ name, description }), "Mazo creado.");
    setName("");
    setDescription("");
    setShowNew(false);
  }

  function startEdit(deck) {
    setEditing(deck.id);
    setEditValues({ name: deck.name, description: deck.description, new_per_day: deck.new_per_day });
  }

  async function saveEdit(id) {
    await act(() => api.updateDeck(id, editValues), "Mazo actualizado.");
    setEditing(null);
  }

  async function removeDeck(deck) {
    const withCards = window.confirm(
      `¿Eliminar "${deck.name}"? Aceptar borra también sus ${deck.cards} tarjetas. Cancelar las mueve a General.`,
    );
    await act(() => api.removeDeck(deck.id, withCards), "Mazo eliminado.");
  }

  return (
    <div>
      <PageHeader title="Mazos" description="Tus mazos de tarjetas, con su progreso.">
        <button type="button" className="btn btn-primary" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Cerrar" : "Nuevo mazo"}
        </button>
      </PageHeader>

      {showNew && (
        <form className="panel mb-5 grid gap-3 md:grid-cols-[1fr_2fr_auto]" onSubmit={createDeck}>
          <input className="field" placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="field" placeholder="Descripción (opcional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit" className="btn btn-primary">Crear</button>
        </form>
      )}

      {decks.length === 0 ? (
        <Empty title="No hay mazos todavía" action={<button className="btn btn-primary" onClick={() => setShowNew(true)}>Nuevo mazo</button>}>
          Crea un mazo para empezar a añadir tarjetas.
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {decks.map((deck) => (
            <div key={deck.id} className="panel-white">
              {editing === deck.id ? (
                <div className="grid gap-2">
                  <input className="field" value={editValues.name} onChange={(e) => setEditValues((v) => ({ ...v, name: e.target.value }))} />
                  <input className="field" value={editValues.description} onChange={(e) => setEditValues((v) => ({ ...v, description: e.target.value }))} placeholder="Descripción" />
                  <div>
                    <label className="label">Tarjetas nuevas al día</label>
                    <input type="number" min="0" className="field" value={editValues.new_per_day} onChange={(e) => setEditValues((v) => ({ ...v, new_per_day: Number(e.target.value) }))} />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => saveEdit(deck.id)}>Guardar</button>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="text-[16px] font-semibold">{deck.name}</h2>
                      {deck.description && <p className="help mt-1">{deck.description}</p>}
                    </div>
                    <span className="chip chip-accent">{deck.due} pendientes</span>
                  </div>
                  <div className="help mt-3 grid grid-cols-4 gap-2 text-center">
                    <div><div className="num font-semibold" style={{ color: "var(--ink)" }}>{deck.cards}</div>tarjetas</div>
                    <div><div className="num font-semibold" style={{ color: "var(--ink)" }}>{deck.new}</div>nuevas</div>
                    <div><div className="num font-semibold" style={{ color: "var(--ink)" }}>{deck.review}</div>repaso</div>
                    <div><div className="num font-semibold" style={{ color: "var(--ink)" }}>{deck.suspended}</div>suspendidas</div>
                  </div>
                  <div className="help mt-2">Nuevas al día: <span className="num">{deck.new_per_day}</span></div>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className="btn btn-sm" onClick={() => startEdit(deck)}>Editar</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeDeck(deck)}>Eliminar</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
