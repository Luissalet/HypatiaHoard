<img src="app-icon.png" width="96" alt="">

# Hypatia's Hoard

A local study app with spaced repetition, a notebook over your own sources, exact math and a teacher role, driven by an assistant through MCP. It is the second version of Exam Coach. [Español](README.es.md)

## What it is

Hypatia's Hoard takes the whole of Exam Coach, a PWA for students, and runs it on your own PC with a local Python server (`hypatia/`) at `http://127.0.0.1:5187`. The server keeps your study data in SQLite and syncs it with the app's IndexedDB. On top of the original app it adds assistant control over MCP, a teacher role (Profesor), a notebook over your sources and an exact-math engine.

All AI features use local models through Hoard Link (vendored in `hypatia/hoard_link/`). With no model running, every AI feature says so instead of inventing results. The podcast speaks through Prospero's Hoard, notebook embeddings come from Borges's Hoard and scanned PDFs are read by Kafka's Hoard, all through the family hub.

No course content lives in the repository. Subjects arrive as password-protected packages (`.examcoach.enc`) from the marketplace or from a file; their questions, PDFs and your progress stay in `data/` and `resources/` on your PC, both ignored by git.

## What it does

### Study (everything Exam Coach did)
- Subjects, topics and four question types (test, open answer, fill-in, practical) with Markdown and LaTeX.
- Practice sessions: random, failed, by topic, smart spaced repetition and timed exam; flashcards.
- Spaced repetition with SM-2 or FSRS-5 (desired retention 70-97 %); cards keep their SM-2 history and the assistant grades with the same scheduler.
- Statistics, weak topics, key concepts, activities and deliverables.
- Lessons from a document: pasted text or a file (PDF, DOCX, EPUB...) is split into sections, key concepts are extracted and one question per concept is stored, with a reading flow and mastery per concept.
- Page cards: sanitised HTML lessons graded like any card.
- Study calendar: preview and download an ICS snapshot of deliverables and exams.

### Oral review
- The due cards are asked aloud and answered by voice; the answer is transcribed and compared by meaning with the expected one, so paraphrases and synonyms count.
- Feedback is spoken, the grade is recorded in the schedule and the next card follows by itself. Keyboard and voice commands (repeat, next, stop, "I don't know") work without the mouse.
- Without a language model, test and fill-in cards are graded by rule and open cards ask you for the grade.

### Objection rehearsal
- A presentation from Cicero's Hoard becomes a subject with one topic per slide and one hard question per objection, each with the answer the slide must support and the verbatim evidence from its sources. The objections can be written by hand or drafted by the language model from the slides and their sources.
- Each slide's text and speaker notes are checked against its objections; the slides that do not hold go back to Cicero as defects, and checking again after the fix closes them there. When a source a slide cites changes (a new revision of the report or of its data), the next check writes that slide's objections again against the sources as they are now and says which ones it rewrote. If no model answers at that moment, only their quotes are checked and the objection stays pending: it is not judged against the old answer, its defect stays in Cicero as it was, and the next check writes it again even if the source does not change again. Undoing the check restores them. The same questions can be rehearsed aloud with the oral review.

### Study plan
- A day-by-day plan until the exam: scheduled reviews, new cards spread by topic, a weekly timed mock and one before the exam, weighted to weak topics, and a final review. Set the exam date, daily minutes, rest days and mock size; overloaded days are flagged. No model is involved.

### Notebook over your sources
- Cited answers from your PDFs, study guides, briefings, FAQs, glossaries, timelines, a mind map, a two-voice audio overview and a Socratic tutor. A finished FAQ can be promoted to the practice bank.

### Teacher role (Profesor)
- Switch it on in the header or in Settings; student mode stays as it is.
- Classes and students (alias, optional email, nothing else), pasted or CSV lists.
- Exam generation from your bank and your own material, with citations: questions per type, points, difficulty mix, versions A-D, header and PDF export; drafts are reviewed before use.
- Rubrics per question or per exam, proposed by the local model and always editable; grade scale 0-10.
- Submissions per exam and class: objective answers in a grid or CSV, open answers by text, PDF or recording; batch correction with model proposals you confirm.
- Class analysis: success per question and topic, common wrong options, weak criteria, grade distribution, and a "reinforce" practice exam built from the weak topics.
- Student data stays on your PC. Without a model, generation and grading end in an explicit `no_model` state.

### Exact math
- Calculator on the home page and `math_*` tools: exact arithmetic, polynomial equations up to degree 4, differentiation, integration (primitives and definite), limits, polynomial expand and factor, tables of values, exact descriptive statistics.
- Linear systems up to 12 equations and 8 unknowns with classification (unique, infinite, inconsistent), exact solutions, ranks and verification; matrix products, powers, transpose and nullspace.
- Number theory: linear congruences and congruence systems, gcd/lcm/Bézout, integer base conversion, finite continued fractions.
- Polynomial division and gcd, partial fractions, rational Taylor series, exact interpolation.
- Results come with exact, approximate and LaTeX forms. Nothing reads or changes study data.

## How to run it

Python 3.11+ with FTS5 in SQLite (the official builds have it); Node 22 only to build the app.

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Open http://127.0.0.1:5187. The server listens on 127.0.0.1 only; a request guard rejects foreign hosts and cross-site requests. Starting it a second time reports that it is already running.

Subjects:
- From the app: Marketplace, install, type the package password.
- From a file: `python -m hypatia import-package "<file>.examcoach.enc" --password "..."` (or `--passwords-file` with a JSON `{"<package id>": "<password>"}`, or `HYPATIA_PACKAGE_PASSWORD`). An unencrypted `.examcoach.zip` needs no password.
- From another Exam Coach install: Settings → Sync and pull, or `python -m hypatia import-backup examcoach-backup.json`.
- From the first Hypatia (flashcards): `python -m hypatia migrate-hypatia "data\legacy-v1\hypatia-hoard.db"`; each deck becomes a subject.

| Variable | Default | Meaning |
|---|---|---|
| `HYPATIA_DATA_DIR` | `data/` | Database, token, `backend.json`, uploads, studio output, logs |
| `HYPATIA_RESOURCES_DIR` | `resources/` | Per-subject PDFs, served at `/resources/` and indexed by the notebook |
| `HYPATIA_PORT` / `PORT`, `PORT_STRICT=1` | `5187` | Port; strict fails instead of moving |
| `HYPATIA_ALLOWED_HOSTS` | | Extra host names (a tunnel to your phone) |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Longest a model call may take |
| `HYPATIA_LLM_THINKING` / `HYPATIA_LLM_EFFORT` | `0` / unset | Reasoning level for model calls |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | Funes audio endpoint | Questions from recorded classes |
| Hoard Link (`data/backend.json`, `HOARD_*`) | | Model resolution and podcast voices |

The app and the server stay in sync: the server stores every app table as JSON records with a global revision and tombstones, and each cycle pushes the app's changes and pulls the server's.

## Connection with Faustus and Hoard Hub

Declares its oral-practice handoff with the requirement to register an objection as a question with a reference answer in a subject, and the objection rehearsal that takes an editable deck and returns slide defects to Cicero.

- `faustus-plugin.json` is the manifest (`id: hypatia`, `HYPATIA_DIR` = this folder). The MCP bridge (`python mcp_server.py`) proxies every call to `POST /api/agent/call` with the token in `data/mcp-token`, starts the server when nothing answers and never opens the database.
- Tools by group:
  - Study: subjects, topics, questions (search, get, add, update, delete, suggest), `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, key concepts, lessons (`lesson_from_document`, `lesson_get`, `concept_mastery`), pages, deliverables, `study_plan`, `study_calendar_export`, `record_get`, `record_patch`.
  - Oral review: `oral_card_next`, `oral_card_answer`, `oral_speak`.
  - Objection rehearsal: `rehearsal_prepare`, `rehearsal_check`, `rehearsal_get`, `rehearsal_undo`.
  - Notebook: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_to_questions`, `studio_list`, `tutor_turn`.
  - Teacher: classes, students, `exam_generate` (job), exam review and PDF export, rubrics, grading batches and submissions, class analysis.
  - Math: `math_compute`, `math_values`, `math_linear_system`, `math_statistics`, `math_matrix`, `math_polynomial_division`, `math_polynomial_gcd`, `math_partial_fractions`, `math_rational_taylor`, `math_continued_fraction`, `math_linear_congruence`, `math_congruence_system`, `math_integer_pair` and others.
  - Flashcard aliases for the first Hypatia: `cards_add`, `decks_list` (Links Hoard sends highlights here, in the deck "Lecturas").
- The shared Faustus panel is on every main view and receives the current view, real object ids, selection and unsaved editor fields. Notebook conversations can be continued in Faustus.
- Family services through the hub: Prospero's Hoard speaks, Funes's Hoard transcribes (with `faster_whisper` as a local fallback), Borges's Hoard embeds, Kafka's Hoard reads scans. `GET /api/family/agenda` serves exam dates and exam deadlines, and teacher jobs post job events on the family bus.
- The app carries skills from the family library for connected agents (`exam-study-plan`, `hoard-study-cards`, `notes-from-templates`), available through the skills tools and the Hub's Skills tab.
- Record API: [docs/API.md](docs/API.md).

## Project layout

| Path | Contents |
| --- | --- |
| `hypatia/` | Python server: API, bank, scheduling, grading, notebook, teacher, math, sync |
| `src/` | React/TypeScript app (Vite) |
| `mcp_server.py` | MCP stdio bridge |
| `faustus-plugin.json` | Faustus plugin manifest |
| `resources/` | Per-subject PDFs (ignored by git) |
| `data/` | Database and token (ignored by git) |
| `tests/` | Test suite |
| `docs/` | API reference |

## Development

```bat
venv\Scripts\pip install pytest reportlab
venv\Scripts\python -m pytest -q tests
npx tsc --noEmit
```

Tests never reach the network or a sibling app. Licence: MIT, Luis María Salete Cuartero.
