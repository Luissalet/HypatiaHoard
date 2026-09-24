// Thin fetch wrapper: JSON in/out, `{ error }` bodies become exceptions.
async function request(method, path, { params, body, raw } = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: body !== undefined && !raw ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error((data && data.error) || `Error ${response.status}`);
  return data;
}

export const api = {
  health: () => request("GET", "/api/health"),
  status: () => request("GET", "/api/status"),

  decks: () => request("GET", "/api/decks"),
  addDeck: (body) => request("POST", "/api/decks", { body }),
  updateDeck: (id, patch) => request("PATCH", `/api/decks/${id}`, { body: patch }),
  removeDeck: (id, withCards = false) => request("DELETE", `/api/decks/${id}`, { params: { with_cards: withCards ? 1 : 0 } }),
  importDeck: (id, text) => request("POST", `/api/decks/${id}/import`, { body: text, raw: true }),
  exportUrl: (id) => `/api/decks/${id}/export`,

  cards: (params) => request("GET", "/api/cards", { params }),
  card: (id) => request("GET", `/api/cards/${id}`),
  addCard: (body) => request("POST", "/api/cards", { body }),
  updateCard: (id, patch) => request("PATCH", `/api/cards/${id}`, { body: patch }),
  removeCard: (id) => request("DELETE", `/api/cards/${id}`),
  suspendCard: (id) => request("POST", `/api/cards/${id}/suspend`),
  unsuspendCard: (id) => request("POST", `/api/cards/${id}/unsuspend`),

  queue: (params) => request("GET", "/api/review/queue", { params }),
  review: (id, grade, elapsedMs) => request("POST", `/api/review/${id}`, { body: { grade, elapsed_ms: elapsedMs } }),

  stats: (deck) => request("GET", "/api/stats", { params: { deck } }),
  search: (params) => request("GET", "/api/search", { params }),

  suggest: (body) => request("POST", "/api/suggest", { body }),
  suggestAccept: (body) => request("POST", "/api/suggest/accept", { body }),
  scribeSessions: (params) => request("GET", "/api/suggest/scribe/sessions", { params }),
};
