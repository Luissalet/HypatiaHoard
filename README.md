# Hypatia's Hoard

Your own flashcards, scheduled on your PC with the classic SM-2 spaced-repetition algorithm. The app is the scheduler and the review UI; an assistant reaches the same cards through MCP, so it can fill them from what you just read or said, and quiz you in chat — showing only the front, waiting for your real answer, then grading it against the back.

Everything stays on the machine: SQLite for cards, decks and the review log, no accounts, no network.

Part of the Hoard family (see `faustus-plugin.json`).

## What it does

- **Decks** = named groups of cards, with a `new_per_day` limit each. A default deck "General" always exists; creating a deck by an existing name (accents/case ignored) returns it unchanged.
- **Cards** = front (question, markdown) / back (answer, markdown) / tags / source. Adding a card with a front that already exists in the deck (normalised: lower-case, accents stripped, collapsed whitespace) updates its back/tags/source instead of duplicating it.
- **Scheduling**: SM-2 — grades again/hard/good/easy; ease starts at 2.5 (floor 1.3); new cards graduate through "learning" (1 day, then 6 days) into "review" (interval × ease); a lapse from review moves a card to "lapsed" and it relearns from there; every review is logged (grade, interval before/after, ease after, elapsed time). Intervals are capped at 365 days.
- **Due queue**: lapsed/learning cards first, then review cards by due date, then new cards by creation order, capped by each deck's `new_per_day`. The browser review UI never receives the back before you reveal it; the assistant's `cards_due` tool does receive it, because it is the one grading your spoken answer.
- **Stats**: per deck or total — counts by state, due now, reviewed today, 30-day retention (good+easy over non-new reviews), a streak of consecutive days with at least one review, and a 7-day forecast.
- **Search**: FTS5 over front/back/tags/source, diacritics-insensitive, prefix match, filterable by deck/tag/state.
- **Import/export**: a deck accepts a JSON list `[{front, back, tags?, source?}]` or CSV (`front,back,tags,source`) and dedupes on import; export returns the deck's cards with their full scheduling state, so it can move between machines.
- **Suggest cards from what you heard, not only what you read**: a "Sugerir/Suggest" panel (and the `cards_suggest` tool) drafts cards with a local model from pasted text or a Scribe's Hoard session/time range — one fact per card, a filled `source` — as a proposal you review, edit and tick before anything is saved. See [Suggesting cards](#suggesting-cards-from-text-or-a-scribes-hoard-session).

## Requirements

- Windows 10/11 (also runs on Linux/macOS), Python 3.11+ (3.13 fine), Node 22 only to build the client.
- Python's `sqlite3` must have FTS5 (the official Windows builds do). The app fails loudly at startup otherwise.

## Install and run (Windows)

```bat
git clone <this repo> hypatia-hoard
cd hypatia-hoard
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Open http://127.0.0.1:5187, go to **Mazos** to create a deck, then **Tarjetas** to add cards (or let the assistant add them), and **Repasar** to study.

- `python scripts/launch.py` starts the app on a free port and opens the browser.
- `python scripts/dev.py` runs uvicorn `--reload` + the Vite dev server (proxying `/api`).

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `HYPATIA_PORT` / `PORT` | `5187` | Preferred port; `PORT_STRICT=1` pins it, otherwise the first free port from there. |
| `HYPATIA_DATA_DIR` | `<repo>/data` | Database (`hypatia-hoard.db`), `mcp-token`. |
| `HYPATIA_ALLOWED_HOSTS` | | Extra host names accepted behind a tunnel (see below). |
| `SCRIBE_URL` | (sibling's `data/url`, else `http://127.0.0.1:5185`) | Where Scribe's Hoard is, for `cards_suggest`'s `scribe` source. |
| `SCRIBE_TOKEN` | (sibling's `data/mcp-token`) | Bearer token for Scribe's Hoard's agent API. |
| `SCRIBE_DIR` / `SCRIBE_DATA_DIR` | (a sibling folder named `Scribe's Hoard`) | Override where Scribe's Hoard (or its `data/` folder) is found. |

### Access from your phone (behind a tunnel)

The server binds 127.0.0.1 and only answers requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`. To reach it from your phone through a tunnel that fronts the app, list the extra host names in `HYPATIA_ALLOWED_HOSTS`, comma-separated, exact names or `*.suffix`: `HYPATIA_ALLOWED_HOSTS=my-pc.example,*.ts.net`. Port and letter case are ignored, and the `Origin` of API calls must resolve to one of those hosts too (any scheme or port). Cross-site *fetches* are still refused; opening the app from another page (a link, a bookmarklet, the share sheet) is a normal navigation and works.

Once opened through the tunnel, the browser offers to install it (PWA).

## API

All JSON; errors are `{ "error": "..." }`.

- `GET /api/health` → `{ service: "hypatia-hoard", version, dataDirConfigured }`; `GET /api/status`
- `GET/POST /api/decks`, `GET/PATCH/DELETE /api/decks/{id}` (delete moves cards to General unless `?with_cards=1`)
- `POST /api/decks/{id}/import` (JSON list or CSV text), `GET /api/decks/{id}/export`
- `GET /api/cards?deck&tag&state&q&due&limit&offset`, `POST /api/cards` (one card or a JSON list), `GET/PATCH/DELETE /api/cards/{id}`, `POST /api/cards/{id}/suspend` / `unsuspend`
- `GET /api/review/queue?deck&limit` (front only, never the back), `POST /api/review/{card_id}` `{grade, elapsed_ms?}`
- `GET /api/stats?deck`
- `GET /api/search?q&deck&tag&state&limit`
- `POST /api/suggest` `{source, deck, max_cards?, language?}` → drafts (or `material` when no model backend is available), `GET /api/suggest/scribe/sessions?q&kind&since&until&limit` (proxies Scribe's Hoard, never fails: `{reachable: false, reason}` when it isn't running), `POST /api/suggest/accept` `{deck, drafts}` (same effect as `POST /api/cards`)
- `GET /api/agent/tools` (catalog + instructions), `POST /api/agent/call` (Bearer token from `data/mcp-token`)

## Suggesting cards from text or a Scribe's Hoard session

Besides writing cards by hand from what you *read*, the **Sugerir/Suggest** panel in **Tarjetas** (and the assistant's `cards_suggest` tool) drafts cards from what you *heard*, too: paste a passage, or point at a Scribe's Hoard session (by id, or a since/until range across several sessions). Drafting itself runs on a local model through [Hoard Link](https://github.com/Luissalet/HoardLink) (vendored at `hypatia/hoard_link/`, see its `VENDORED.txt`) — the same shared-backend resolution Faustus's other plugins use, so it reuses whatever `llm` server is already loaded instead of loading a second copy of a model. Nothing is saved automatically: drafting returns `drafts` (front/back/source) for you (or the assistant) to review, edit and tick, and only `cards_suggest_accept` / `POST /api/suggest/accept` (or a plain `cards_add`) writes them to a deck.

If no model backend can be resolved (or it replies with something that isn't the expected JSON), `cards_suggest` never fails silently: it comes back with `drafts: []`, the gathered `material` (the pasted text, or the rendered transcript), and a `note` explaining why, so the assistant can draft the cards itself from `material` instead.

`cards_suggest`'s `scribe` source talks to Scribe's Hoard exactly the way Faustus's plugins talk to each other: `GET /api/agent/tools` / `POST /api/agent/call` on Scribe's own port, authenticated with *Scribe's* token (read from its sibling `data/mcp-token`, or `SCRIBE_TOKEN`/`SCRIBE_URL` above). Hypatia's Hoard never opens Scribe's database and never writes to it.

## MCP tools

`mcp_server.py` is a stdio bridge: it fetches the tool list from the running app and proxies every call to `POST /api/agent/call` with the token from `<DATA_DIR>/mcp-token`. It never opens the database. Env: `HYPATIA_URL`, `HYPATIA_TOKEN_FILE` (or `HYPATIA_TOKEN`).

| Tool | What it does |
| --- | --- |
| `decks_list` | Decks with counts and how many are due now. |
| `deck_create` | Create a deck (write, idempotent by name). |
| `cards_add` | Add up to 100 cards to a deck, creating it if needed (write, idempotent per normalised front). |
| `cards_due` | The due queue with front AND back, for the assistant to quiz the user in chat. |
| `card_review` | Grade one card the user just answered (write): again/hard/good/easy — a blank or "I don't remember" is again. Takes the front that was shown (and optionally the id): the front decides which card is graded, so a wrong id never lands a grade on another card; a front that matches no card is refused. |
| `cards_search` | Full-text search over the user's cards. |
| `card_update` | Edit a card's fields (write). |
| `card_delete` | Delete a card (write, destructive). |
| `cards_stats` | Study statistics. |
| `cards_export` | Export a deck's cards as JSON. |
| `cards_suggest` | Draft flashcards (proposal, nothing saved) from pasted text or a Scribe's Hoard transcript. |
| `cards_suggest_accept` | Save the drafts the user accepted (write, same effect as `cards_add`). |

The shipped instructions tell the assistant: add cards only from material the user actually has, one fact per card with a source; when quizzing, show only the front, wait for the real answer, then grade with `card_review` and say what the back said; never reveal the back first, never grade without a real answer, never touch the database directly.

## Tests

```bat
venv\Scripts\python -m pytest -q
```

Covers the SM-2 scheduler (every grade path, caps, lapses, ease floor), store dedupe and normalisation, FTS search with accents, stats (retention, streak across midnight, forecast) with a fully injectable clock, import (JSON + CSV), the HTTP API, agent tools through `/api/agent/call`, the request guard, the PWA endpoints, `cards_suggest`/`cards_suggest_accept` (prompt building, JSON parsing, a fake Hoard Link, a fake Scribe's Hoard ASGI app, the fallback-to-`material` path, tool schema and the `/api/suggest*` HTTP API), and a subprocess end-to-end test through the MCP stdio bridge.

## License

MIT — Luissalet.
