# API

The server is FastAPI (`hypatia/main.py`); routers live in `hypatia/api/`: the bank (`/api/bank/*`), study (`/api/study/*`), sync with the PWA (`/api/sync/*`), the notebook (`/api/notebook/*`), the teacher role (`/api/teacher/*`), the agent contract (`/api/agent/tools`, `/api/agent/call`) and `/api/health`.

## Faustus copilot routes

Mounted by `install_copilot(app, "hypatia", config.data_dir, app_name="Hypatia's Hoard")` (vendored `hypatia/hoard_link/copilot.py`) before the PWA catch-all, unless `HOARD_COPILOT=0`. A thin local relay: the panel, conversation, model and tools live in Faustus.

| Route | Purpose |
| --- | --- |
| `GET /api/copilot/info` | `{app_id, app_name, data_space_id, panel_url, server, tool_server_id, settings_url}`; `503` when Faustus is not reachable. `data_space_id` is stored in `data/copilot-space-id`. |
| `GET /api/copilot/panel.js` | The Faustus chat component, relayed from Faustus. |
| `POST /api/copilot/proxy` | Forwards `/api/hoard-copilot/*`, `/api/chat/*` and `/api/session(s)` calls (SSE unbuffered) to Faustus and forces `origin.app_id` / `data_space_id` into the context. Any other path is `400`. |
| `GET /api/copilot/launcher.js` | The floating button and panel host. The server adds its tag to every HTML page it serves, and the PWA adds it itself (`src/hoard-copilot.ts`) because its service worker answers navigations from the cached shell. |

The page answers the launcher with `window.hoardCopilot.context()`: `project` (the open subject), `active_objects` (`subject`, `topic`, `source`, `session`, `question`, `teacher_exam`, `grading_batch`) and `view` (`page`, `tab`, `subjects` on the dashboard, `editor` for unsaved input). `onTurnEnd` runs a sync cycle (`syncNow`, `teacherSyncNow`).
