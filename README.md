# Hypatia's Hoard — Exam Coach 2, with Faustus

[Español](README.es.md)

Hypatia's Hoard is the second version of [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), built to run on your own PC and to be driven by an assistant. Exam Coach stays what it was: a public PWA that students used. Hypatia takes the whole of it and adds:

- **A local server** (Python, `hypatia/`) that serves the app at `http://127.0.0.1:5187`, keeps your study data in SQLite and syncs it with the app's IndexedDB.
- **Assistant control**: 49 MCP tools so Faustus (or any MCP client) can quiz you with spaced repetition, build mock exams on your weak topics, grade open answers, calculate exact math, add or suggest questions from your own material, and run the teacher role.
- **A teacher role** (Profesor): classes, exams generated from your bank and your own material with citations, versions A/B, rubrics, batch correction with model proposals you confirm, grades and class analysis. Student data stays on your PC.
- **A notebook over your sources**: cited answers from your PDFs, study guides, briefing, FAQ, glossary, timeline, a mind map, a two-voice audio overview and a Socratic tutor.
- **Local models only**, through Hoard Link (vendored in `hypatia/hoard_link/`), the same shared backend the rest of the Hoard family uses. The podcast speaks through Prospero's Hoard, the notebook's embeddings come from Borges's Hoard and scanned PDFs are read by Kafka's Hoard, all through the family hub (see *In the family*). With no model running, every AI feature still returns the material so the assistant can do the work itself, and the app disables the buttons that need a model.

No course content lives in this repository. Subjects arrive as **password-protected packages** (`.examcoach.enc`) from the marketplace or from a file; their questions, PDFs and your progress stay in `data/` and `resources/` on your PC, both ignored by git.

## Everything Exam Coach did

Subjects, topics and four question types (test, open answer, fill-in, practical) with Markdown and LaTeX; practice sessions (random, failed, by topic, smart SM-2, timed exam); spaced repetition with SM-2 or FSRS-5 (Ajustes → Repaso espaciado, with a desired retention from 70 % to 97 %; cards keep their SM-2 history and the assistant grades with the same scheduler); flashcards; read mode; listen mode (PDF to speech with Piper voices in the browser); PDF viewer and PDF tools; key concepts; curated exams; AI extraction of questions from documents; continuous-evaluation grades and deliverables; the subject marketplace with encrypted packages; contribution packs; Gist sync between devices; Anki import/export; statistics. See [FEATURES.md](FEATURES.md) for the full map.

What changes: the app is served by the local server (base `/`), its AI extraction can use your local model (provider "Hypatia"), and a **Cuaderno** (notebook) page appears in each subject.

## Run (Windows)

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Open http://127.0.0.1:5187. Python 3.11+ with FTS5 in SQLite (the official builds have it), Node 22 only to build the app. The server listens on 127.0.0.1 only; a request guard (the shared one, for HTTP and websockets) rejects foreign hosts and cross-site requests. Starting it a second time prints that it is already running and leaves the first instance alone.

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
Exact math: `math_compute` evaluates arithmetic, solves polynomial equations up to degree 4 and differentiates formulas locally. Use `**` for powers. It returns exact, approximate (when numeric) and LaTeX forms without reading or changing study data.

`math_linear_system` solves `A*x=b` with up to 12 equations and 8 named variables, including rectangular systems. Send coefficients and constants as strings (`"1/3"`, `"0.1"`), with variables in column order. It returns `unique`, `infinite` or `inconsistent`, exact named solutions, original free-variable names, coefficient/augmented ranks, augmented RREF and substitution residuals. For example, `{"coefficients":[["1/3","1/2"],["1","-1"]],"constants":["1","0"],"variables":["x","y"]}` gives `x=y=6/5` and two zero residuals. It does not access the study bank. Number strings are finite integer/decimal/fraction literals of up to 100 characters; decimal exponents are between -100 and 100. Names label unknowns, not constants.

Decimal literals in `math_compute` preserve the written digits, including scientific notation with exponent -100 through 100. Exact results use fractions; approximate output is separately rounded. The linear-system capability follows [SymPy's documented exact matrix operations](https://docs.sympy.org/latest/modules/matrices/matrices.html); it uses the existing dependency and adds no model or service.
Teacher tools: see [Teacher role](#teacher-role-profesor).
Notebook tools: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_to_questions`, `studio_list`, `tutor_turn`. `studio_to_questions` promotes a completed FAQ to the practice bank and skips duplicates on repeated calls.
Aliases kept from Hypatia 1 (flashcards): `cards_add`, `decks_list`. `cards_add` takes `{deck, cards: [{front, back, tags, source, source_ref}]}`; `source_ref` (for example `hoard://links/highlight/<id>`, sent by Links Hoard for a highlight) is stored with the card as `sourceRef`, is not part of the card's content hash (the same card from another place is still the same card; a duplicate that had no reference takes it), travels through sync and shows as an *Origen* chip in the question editor.

### In the family

- **Agenda.** `GET /api/family/agenda` (bearer token of this app; `?from=&to=&sphere=`) answers the family agenda contract: each subject's exam date (`exam`, high priority within a week), the date in the header of a teacher exam when it is a real date (`exam`), pending deliverables with their due date and time (`deadline`, or `exam` for tests), and, for today, one all-day `cards` item "N tarjetas para repasar hoy" when cards are due. Only subject names, exam titles and counts leave the app, never a student's name or answers. The manifest says `"x-family": {"agenda": true}`.
- **Shared services, through the hub.** The podcast voices come from Prospero's Hoard (`voice_tts`, no URL to configure); notebook embeddings come from Borges's Hoard (`embed_texts`, the model and its size are stored with each vector and a change of model re-embeds the sources in the next rescan), with Hypatia's own Hoard Link embedding backend as the fallback only when Borges is not there; a scanned PDF (half or more of its pages without a text layer) is read by Kafka's OCR (`doc_extract`). Vector search scores every stored vector (no cap). Without those apps the notebook still indexes text PDFs and answers from keywords.
- **Job events.** Teacher jobs (`exam_generate`, `grading_run`) post the canonical job events on the family bus: `hypatia.job.queued`, `started`, `progress` (at most every 3 seconds, with `eta_s` once there is progress), `done`, `failed` (`no_model`, `no_sources` and errors, with the reason in `error`) and `cancelled`, each with `{job_id, title, kind: "teacher", progress 0..1, gpu: false, eta_s, url, error}` (the url opens the exam or the batch). They replace `hypatia.teacher_job.*`, which the hub maps onto these, so the old names are no longer sent.

## Teacher role (Profesor)

A switch in the header (and in **Ajustes → Rol**) turns on the teacher screens. Student mode stays as it is: a teacher can still practise.

- **Clases**: groups (name, course, year, subjects) and students (display name or alias, optional email for your own reference, nothing else). Paste a list or a CSV (`Nombre;Apellidos;Correo`, or `Apellidos, Nombre` per line).
- **Generar examen**: subject, topics, number of questions per type (TEST, DESARROLLO, COMPLETAR, PRACTICO), points per type, difficulty mix, duration, versions A–D (question order and options shuffled, same content), header (centre, course, date, instructions) and a test penalty. Source: the bank, the local model drafting from the subject's indexed sources, or the bank first and the model for what is missing. Every generated question cites the passage it comes from (file, page or section) and is a **draft** until you approve it into the bank. Print a PDF with each version, the answer key per version and the rubrics; the exam is also saved as a practice exam of the subject.
- **Rúbricas**: per question or per exam, criteria with a weight and levels (descriptor + points). «Proponer rúbrica» asks the local model (without one: a fixed template); always editable. Grade scale 0–10 with one decimal and the usual bands (Suspenso < 5, Aprobado 5–6.9, Notable 7–8.9, Sobresaliente ≥ 9), configurable.
- **Entregas**: one batch per exam and class. Objective answers in a grid (students × printed question numbers of each version) or a pasted CSV (`alumno;version;1;2;…`), scored with the app's own scoring. Open answers by text, PDF (its text) or photo (only with a vision model; otherwise you type it). «Corregir con IA» runs in the background on the server and only **proposes**: level per criterion, points, justification, literal quotes checked against the answer (quotes that are not in the answer are dropped) and confidence. Review side by side (answer | rubric | proposal), accept or override, and confirm: only then the grade, band and feedback (strengths, mistakes, topics and key concepts to review) are stored. Class CSV of grades and feedback PDFs.
- **Análisis**: success per question and topic, most common wrong options, blanks and weak criteria, grade distribution; «Reforzar» creates a practice exam (practice sessions, flashcards, SM-2) from the weak topics for the class or one student.

Without the local server (public build) everything works except the model features, which say so. Without a model, generation and grading end in an explicit `no_model` state and nothing is invented.

**Where the data lives.** Teacher data is in IndexedDB (Dexie version 9: `teacherClasses`, `teacherStudents`, `teacherExams`, `rubrics`, `gradingBatches`, `submissions`, `gradingProposals`, `teacherSettings`) and in separate server tables (`teacher_records`, `teacher_jobs`), synced through `/api/teacher/sync/*` with last-write-wins per record. It does **not** go through the study sync, because that one pushes the same full backup the Gist uses; keeping teacher data on its own channel is what keeps student names, answers and grades out of the Gist, the global bank, contribution packs, packages and every other export. Every export function passes `src/data/studentPrivacy.ts#guardPublicExport`, which strips teacher tables and refuses any student field; tests check it on real exports. Practice sets created by «Reforzar» never carry a student's name.

Teacher tools (Faustus): `teacher_classes`, `teacher_class_create`, `teacher_students_add`, `exam_generate` (job), `exam_get`, `exam_drafts_review`, `exam_export_pdf`, `rubric_propose`, `rubric_set`, `grading_batch_create`, `grading_submit_answers`, `grading_run` (job), `grading_review`, `grading_confirm`, `grades_report`, `class_analysis`, `class_reinforce`, `teacher_job`. They answer things like «hazme un examen de 10 preguntas del tema 3 con dos versiones», «corrige las entregas del examen X con la rúbrica» or «¿qué tema ha ido peor en 2ºB?» (`class_analysis` → `worstTopic`). The server PDF of `exam_export_pdf` prints formulas as LaTeX source; the app's «Imprimir PDF» renders them.

## How the app and the server stay in sync

The server stores every app table as JSON records with a global revision and tombstones for deletions. Each cycle the app pushes its full backup plus queued deletions, pulls what changed since its last revision, merges it with the same code the Gist sync uses, and applies the server's deletions. `hypatia/merge.py` is a port of `mergeBackup` (subjects by name, topics by subject and title, questions by content hash, local notes/starred/exam dates kept, SM-2 stats merged), and `hypatia/hashing.py` is proven identical to the TypeScript by a test that runs it under node.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HYPATIA_DATA_DIR` | `data/` | Database, token, `backend.json`, uploads, studio output, logs |
| `HYPATIA_RESOURCES_DIR` | `resources/` | Per-subject PDFs (`resources/<slug>/Temas/…`: from `import-package`, and every PDF you attach to a topic in the app) served at `/resources/` and indexed by the notebook |
| `HYPATIA_PORT` / `PORT`, `PORT_STRICT=1` | `5187` | Port; strict fails instead of moving |
| `HYPATIA_ALLOWED_HOSTS` | | Extra host names (a tunnel to your phone); `name:port` accepts only that port |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Longest a model call may take |
| `HYPATIA_LLM_THINKING` | `0` | `1` lets every call think at `high` unless the call asks for its own level (slower) |
| `HYPATIA_LLM_EFFORT` | unset | `off`/`low`/`medium`/`high`/`max` forces one reasoning level on every call. Unset, each task picks its own: grading and notebook answers `medium`, question drafting `high`, study guides and briefings `max`, bulk note-taking `off` |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | Funes audio at `http://127.0.0.1:8813/audio`; optional endpoint/token overrides | Questions from recorded classes |
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

No test reaches the network or a sibling app (`tests/notebook/test_nb_family.py` covers Borges's embeddings, Kafka's OCR and the index version with a fake hub; `tests/test_family.py` covers `source_ref`, the job events and the agenda with a recorded event list and the TestClient). Some tests run the TypeScript with node (needs `npm install`): hashing and teacher-core parity, the Dexie 8→9 migration and the export guard (with `fake-indexeddb`).

## License

MIT, Luis María Salete Cuartero.
