# Hypatia's Hoard — Exam Coach 2, with Faustus

[Español](README.es.md)

Hypatia's Hoard is the second version of [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), built to run on your own PC and to be driven by an assistant. Exam Coach stays what it was: a public PWA that students used. Hypatia takes the whole of it and adds:

- **A local server** (Python, `hypatia/`) that serves the app at `http://127.0.0.1:5187`, keeps your study data in SQLite and syncs it with the app's IndexedDB.
- **Assistant control**: 28 MCP tools so Faustus (or any MCP client) can quiz you with spaced repetition, build mock exams on your weak topics, grade open answers, and add or suggest questions from your own material.
- **A notebook over your sources**: cited answers from your PDFs, study guides, briefing, FAQ, glossary, timeline, a mind map, a two-voice audio overview and a Socratic tutor.
- **Local models only**, through Hoard Link (vendored in `hypatia/hoard_link/`), the same shared backend the rest of the Hoard family uses. The podcast speaks through Prospero's Hoard. With no model running, every AI feature still returns the material so the assistant can do the work itself, and the app disables the buttons that need a model.

No course content lives in this repository. Subjects arrive as **password-protected packages** (`.examcoach.enc`) from the marketplace or from a file; their questions, PDFs and your progress stay in `data/` and `resources/` on your PC, both ignored by git.

## Everything Exam Coach did

Subjects, topics and four question types (test, open answer, fill-in, practical) with Markdown and LaTeX; practice sessions (random, failed, by topic, smart SM-2, timed exam); flashcards; read mode; listen mode (PDF to speech with Piper voices in the browser); PDF viewer and PDF tools; key concepts; curated exams; AI extraction of questions from documents; continuous-evaluation grades and deliverables; the subject marketplace with encrypted packages; contribution packs; Gist sync between devices; Anki import/export; statistics. See [FEATURES.md](FEATURES.md) for the full map.

What changes: the app is served by the local server (base `/`), its AI extraction can use your local model (provider "Hypatia"), and a **Cuaderno** (notebook) page appears in each subject.

## Run (Windows)

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Open http://127.0.0.1:5187. Python 3.11+ with FTS5 in SQLite (the official builds have it), Node 22 only to build the app. The server listens on 127.0.0.1 only; a request guard rejects foreign hosts and cross-site requests.

## Subjects (password-protected packages)

- From the app: **Marketplace**, install, type the package password. The app stores it, the next sync sends the subject to the server, and opening the Cuaderno uploads its PDFs for the notebook.
- From a file, straight into the server (it also copies the package's PDFs to `resources/<subject>/` for the notebook):

```bat
venv\Scripts\python -m hypatia import-package "C:\path\vision-artificial.examcoach.enc" --password "..."
venv\Scripts\python -m hypatia import-package "C:\path\vision-artificial.examcoach.enc" --passwords-file "C:\path\passwords.json"
```

`--passwords-file` is a JSON object `{"<package id>": "<password>"}`; `HYPATIA_PACKAGE_PASSWORD` also works. An unencrypted `.examcoach.zip` needs no password.

- From another Exam Coach install: in the app, **Ajustes → Sincronización (Gist)** and pull; or `python -m hypatia import-backup examcoach-backup.json`.

## Faustus

`faustus-plugin.json` is the manifest (`id: hypatia`, `HYPATIA_DIR` = this folder). The MCP bridge (`python mcp_server.py`) never opens the database: it proxies every call to `POST /api/agent/call` with the token in `data/mcp-token`, and starts the server when nothing answers.

Study tools: `subjects_list`, `topics_list`, `questions_search`, `question_get`, `questions_add`, `question_update`, `question_delete`, `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, `key_concepts`, `key_concept_add`, `questions_suggest`, `questions_suggest_accept`, `deliverables_upcoming`.
Notebook tools: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_list`, `tutor_turn`.
Aliases kept from Hypatia 1 (flashcards): `cards_add`, `decks_list`.

## How the app and the server stay in sync

The server stores every app table as JSON records with a global revision and tombstones for deletions. Each cycle the app pushes its full backup plus queued deletions, pulls what changed since its last revision, merges it with the same code the Gist sync uses, and applies the server's deletions. `hypatia/merge.py` is a port of `mergeBackup` (subjects by name, topics by subject and title, questions by content hash, local notes/starred/exam dates kept, SM-2 stats merged), and `hypatia/hashing.py` is proven identical to the TypeScript by a test that runs it under node.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HYPATIA_DATA_DIR` | `data/` | Database, token, `backend.json`, uploads, studio output, logs |
| `HYPATIA_RESOURCES_DIR` | `resources/` | Per-subject PDFs (`resources/<slug>/Temas/…`: from `import-package`, and every PDF you attach to a topic in the app) served at `/resources/` and indexed by the notebook |
| `HYPATIA_PORT` / `PORT`, `PORT_STRICT=1` | `5187` | Port; strict fails instead of moving |
| `HYPATIA_ALLOWED_HOSTS` | | Extra host names (a tunnel to your phone) |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Longest a model call may take |
| `HYPATIA_LLM_THINKING` | `0` | `1` lets reasoning models think before answering (slower) |
| `HYPATIA_PROSPERO_URL` | sibling `Prospero's Hoard/data/url`, else `http://127.0.0.1:8815` | Voice studio for the podcast |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | sibling Scribe's Hoard | Questions from recorded classes |
| Hoard Link (`data/backend.json`, `HOARD_*`) | | Model resolution; `backend.json` also takes `{"podcast": {"engine": "piper", "voices": ["es_ES-davefx-medium", "es_ES-sharvard-medium"]}}` |

## From Hypatia 1 (flashcards)

```bat
venv\Scripts\python -m hypatia migrate-hypatia "data\legacy-v1\hypatia-hoard.db"
```

Each old deck becomes a subject, each card an open-answer question in the topic "Tarjetas" with its SM-2 state. Safe to run twice.

## Tests

```bat
venv\Scripts\pip install pytest reportlab
venv\Scripts\python -m pytest -q tests
npx tsc --noEmit
```

No test reaches the network or a sibling app.

## License

MIT, Luis María Salete Cuartero.
