# Hypatia's Hoard — Exam Coach 2, with Faustus

[Español](README.es.md)

Hypatia's Hoard is the second version of [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), built to run on your own PC and to be driven by an assistant. Exam Coach stays what it was: a public PWA that students used. Hypatia takes the whole of it and adds:

- **A local server** (Python, `hypatia/`) that serves the app at `http://127.0.0.1:5187`, keeps your study data in SQLite and syncs it with the app's IndexedDB.
- **Assistant control**: 67 MCP tools so Faustus (or any MCP client) can quiz you with spaced repetition, build mock exams on your weak topics, grade open answers, calculate exact math, add or suggest questions from your own material, and run the teacher role.
- **A teacher role** (Profesor): classes, exams generated from your bank and your own material with citations, versions A/B, rubrics, batch correction with model proposals you confirm, grades and class analysis. Student data stays on your PC.
- **A notebook over your sources**: cited answers from your PDFs, study guides, briefing, FAQ, glossary, timeline, a mind map, a two-voice audio overview and a Socratic tutor.
- **Local models only**, through Hoard Link (vendored in `hypatia/hoard_link/`), the same shared backend the rest of the Hoard family uses. The podcast speaks through Prospero's Hoard, the notebook's embeddings come from Borges's Hoard and scanned PDFs are read by Kafka's Hoard, all through the family hub (see *In the family*). With no model running, every AI feature still returns the material so the assistant can do the work itself, and the app disables the buttons that need a model.

No course content lives in this repository. Subjects arrive as **password-protected packages** (`.examcoach.enc`) from the marketplace or from a file; their questions, PDFs and your progress stay in `data/` and `resources/` on your PC, both ignored by git.

**Congruence systems:** Home → Sistema de congruencias, new
`math_congruence_system` and `POST /api/math/congruence-system` combine a nonempty
`constraints` list of signed decimal string `residue`/`modulus` pairs. They handle
noncoprime moduli and normalize negative moduli; zero is invalid. The complete
family for2mod6 and5mod9 is `x=14+k*18`, with k any integer. Incompatible systems
return `no_solution` with the first conflicting condition, prior residue class,
gcd and nonzero compatibility remainder. A solved result includes normalized
conditions, canonical nonnegative residue, positive lcm period and exact checks;
period1 means all integers. Values remain strings beyond JavaScript precision,
subject to runtime conversion limits. The panel adds/removes conditions, copies
the result/check, retains invalid input and ignores late responses after editing
or closing. No residue enumeration, model, new dependency or study-bank change.
This combines residue conditions, while the individual tool below still solves
`a*x=b` modulo m. Mathematical reference:
[SymPy's generalized congruence contract](https://docs.sympy.org/latest/modules/ntheory.html#sympy.ntheory.modular.solve_congruence).
The implementation merges classes with the existing native linear solver;
combined MCP catalog67 =49Study+18Teacher.

**Linear congruences:** Home → Congruencias lineales, `math_linear_congruence`
and `POST /api/math/linear-congruence` solve `a*x ≡ b (mod m)` using the same
native exact-integer function. Supply signed decimal strings `a`, `b`, `modulus`;
nonzero negative moduli are normalized to their absolute value. For `35,14,28`,
the complete family is `x=2+k*4`, with seven distinct residues modulo28.
Returns gcd, Bézout identity and compatibility remainder; an incompatible target
returns `no_solution`. Period1 means every integer solves it. Use b=1 for a
modular inverse when it exists. Inputs/results remain strings beyond JavaScript
precision, subject to runtime integer conversion limits. The native panel copies
the solution/check and retains erroneous inputs for correction. No enormous
residue list, new dependency or study-bank write. This individual operation does
not combine conditions; use the separate system tool above. Mathematical
reference: [MIT18.781 lecture5](https://ocw.mit.edu/courses/18-781-theory-of-numbers-spring-2012/7b36e2ada32c5ed0638783d4e66af60c_MIT18_781S12_lec5.pdf).

**Exact integer pairs:** Home → MCD, MCM y Bézout, `math_integer_pair` and
`POST /api/math/integer-pair` accept two signed decimal integer strings `a`/`b`.
They return nonnegative gcd/lcm, integer coefficients `x`/`y`, the checked
identity `a*x+b*y=gcd`, and Euclidean divisions of the absolute values. Inputs
and integer results stay strings, preserving digits beyond JavaScript precision;
normal runtime integer conversion limits apply. Coefficients are not unique.
With either input zero, lcm is zero; for `(0,0)`, gcd/lcm and both coefficients
are zero by convention. The panel keeps invalid input for correction and copies
the exact result and divisions. It neither factors primes nor changes study data.
The mathematical contract follows [SageMath's xgcd documentation](https://doc.sagemath.org/html/en/reference/rings_standard/sage/arith/misc.html#sage.arith.misc.xgcd);
the native Euclidean implementation needs no additional dependency.

## Everything Exam Coach did

Subjects, topics and four question types (test, open answer, fill-in, practical) with Markdown and LaTeX; practice sessions (random, failed, by topic, smart SM-2, timed exam); spaced repetition with SM-2 or FSRS-5 (Ajustes → Repaso espaciado, with a desired retention from 70 % to 97 %; cards keep their SM-2 history and the assistant grades with the same scheduler); flashcards; page cards (an HTML lesson, sanitized, that enters the same SM-2/FSRS schedule and is reviewed whole; created from pasted HTML, an imported .html file, a notebook study guide or the assistant); read mode; listen mode (PDF to speech with Piper voices in the browser); PDF viewer and PDF tools; key concepts; curated exams; AI extraction of questions from documents; continuous-evaluation grades and deliverables; the subject marketplace with encrypted packages; contribution packs; Gist sync between devices; Anki import/export; statistics. See [FEATURES.md](FEATURES.md) for the full map.

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

Study tools: `subjects_list`, `topics_list`, `questions_search`, `question_get`, `questions_add`, `question_update`, `question_delete`, `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, `key_concepts`, `key_concept_add`, `questions_suggest`, `questions_suggest_accept`, `deliverables_upcoming`, `page_card_add`, `pages_list`, `lesson_from_document`, `lesson_get`, `concept_mastery`, `lesson_delete`. Page cards (an HTML lesson, sanitized) show up in `cards_due` with `kind: "page"` and `pageHtml` and are graded with `card_review` like any card. Lessons from a document: `lesson_from_document` splits pasted text or a file (PDF, DOCX, EPUB...) into sections, extracts the key concepts of each with the local model (deterministic rules if none answers), and stores one question per concept in the bank; `lesson_get` gives the flow (read a section, then its questions) and `concept_mastery` the mastery per concept, computed from the review history (REST: `/api/study/lessons*`). In the app: Cuaderno → Lecciones, or the *Enséñame un documento* button of a subject (hoard build).
Exact math: `math_compute` evaluates arithmetic, solves polynomial equations up to degree 4 and differentiates formulas locally. Use `**` for powers. It returns exact, approximate (when numeric) and LaTeX forms without reading or changing study data.

The dashboard's **Tabla de valores** evaluates an expression in `x`, `y` or `t` at ordered points, including repeats. Editable examples cover fractions, undefined points and complex values. `POST /api/math/values` and MCP `math_values` share `{expression, variable, points: ["-1", "0", "1/3", "pi"]}`. Each row reports the written/exact point, exact value, approximation and `evaluated`, `complex`, `undefined`, `invalid_point` or `unevaluated` status. Points must be finite real constant expressions; variables are rejected even when they cancel (`x/x`, `x-x`). The original arithmetic tree is evaluated with the point bound before simplification, so `x/x` and `0*(1/x)` at zero remain undefined. This is evaluation, not a limit or a complete domain analysis; complex values use SymPy's principal branches (`I` is the imaginary unit). Copy includes the query, statuses and exact values. Edits invalidate pending results, failures retain drafts, and the open panel supplies the current draft/result to Faustus. No study data is read or changed. This reuses the existing exact parser and [SymPy calculation semantics](https://docs.sympy.org/latest/tutorials/intro-tutorial/basic_operations.html#substitution), without evaluating text as Python or adding a model/service.

`math_linear_system` solves `A*x=b` with up to 12 equations and 8 named variables, including rectangular systems. Send coefficients and constants as strings (`"1/3"`, `"0.1"`), with variables in column order. It returns `unique`, `infinite` or `inconsistent`, exact named solutions, original free-variable names, coefficient/augmented ranks, augmented RREF and substitution residuals. For example, `{"coefficients":[["1/3","1/2"],["1","-1"]],"constants":["1","0"],"variables":["x","y"]}` gives `x=y=6/5` and two zero residuals. It does not access the study bank. Number strings are finite integer/decimal/fraction literals of up to 100 characters; decimal exponents are between -100 and 100. Names label unknowns, not constants.

Decimal literals in `math_compute` preserve the written digits, including scientific notation with exponent -100 through 100. Exact results use fractions; approximate output is separately rounded. The linear-system capability follows [SymPy's documented exact matrix operations](https://docs.sympy.org/latest/modules/matrices/matrices.html); it uses the existing dependency and adds no model or service.

The dashboard's **Calculadora exacta** uses the same engine as `math_compute` through `POST /api/math/compute`. It evaluates arithmetic, solves polynomial equations, differentiates, integrates and calculates limits without reading or changing your study bank. Examples load into the editable form; calculation is explicit.

It also offers **Desarrollar un polinomio** (`operation: "expand"`) and
**Factorizar un polinomio** (`operation: "factor"`). Both use exact rational
coefficients in `x`, `y` or `t`, including written decimals and fractions.
`(x+2)*(x-3)` expands to `x**2-x-6`; `x**3-x**2+x-1` factors to
`(x-1)*(x**2+1)`. Factoring is over the rationals, so `x**2-2` stays unchanged.
Denominators must be constant and variable powers nonnegative integers. Variable
denominators, inverse variable powers and functions of the variable are rejected
before cancellation, instead of turning them into apparently valid polynomials.
The result shows the submitted expression/variable and can be copied with that
context. Editing the form clears the previous result. Same native API/MCP engine,
existing [SymPy polynomial transformations](https://docs.sympy.org/latest/tutorials/intro-tutorial/simplification.html#polynomial-rational-function-simplification),
no model, new dependency or study-bank writes. These are transformations, not
step-by-step proofs or an equation-solving mode.

Next to it, **Sistemas lineales exactos** edits the augmented matrix `[A | b]`,
equation/unknown counts and variable names. Hidden entries survive shrinking and
expanding dimensions; folding the editor retains the draft. Three editable
examples cover unique, infinite and inconsistent systems. Resolving explicitly
shows the native classification, exact solutions/separate approximations, free
variables, ranks, substitution verification and an expandable RREF; results can
be copied. Editing an input clears the previous result. Wide matrices scroll
inside their editor. `POST /api/math/linear-system` takes the same
`MathLinearSystemArgs` as MCP `math_linear_system` and calls the same existing
engine. No new solver, proof steps, stored study records or runtime dependency.

- `operation: "integrate"`: omit `lower`/`upper` for a primitive (the returned `integration_constant: "C"` is arbitrary), or supply both as strings for a definite integral. Bounds accept exact real constants, fractions, `pi`, `E`, `oo` and `-oo`. For example, `exp(-x)` from `0` to `oo` returns exactly `1`.
- `operation: "limit"`: supply `point` and optionally `side: "both" | "left" | "right"`. Both is the default: the two sides are compared at a finite point; at infinity there is a single approach. `sin(x)/x` at `0` is `1`; `1/x` at `0` is `nonexistent` with both actual lateral results.
- Results include exact and LaTeX forms, a separate approximation when applicable, and an explicit `status` (`evaluated`, `infinite`, `divergent`, `nonexistent` or `unevaluated`). Oscillation is not reported as a numeric answer; divergent integrals are not Cauchy principal values. Symbolic calculus runs in a separate process and stops after 15 seconds with an error that asks you to simplify the expression. This is a calculator, not a step-by-step proof or a complete computer algebra system.

The calculus capability follows [SymPy 1.14's calculus documentation](https://docs.sympy.org/1.14.0/tutorials/intro-tutorial/calculus.html), using the existing BSD-licensed dependency. No model, GPU, new service or new dependency is needed.

**Exact descriptive statistics:** the home calculator's Estadística exacta panel
and `math_statistics` / `POST /api/math/statistics` describe a list of integer,
decimal or fraction strings. Order and repeats are retained. Results include
count, sum, mean, median, minimum/maximum/range, sum of squared deviations and
population/sample variance and standard deviation, with exact radicals and
separate numerical approximations. Population variance divides by N; sample
variance divides by N−1. With one observation population dispersion is zero and
the sample result is null, explicitly undefined. The UI takes one number per
line (blank lines are ignored), provides editable examples, copies inputs and
exact results, and exposes the draft to Faustus. Invalid observations identify
their position without discarding the input. No weights, missing-value inference,
quantiles, predictions or study records are involved. The definitions follow the
[Python statistics documentation](https://docs.python.org/3/library/statistics.html);
the implementation uses the existing exact rational SymPy engine, with no new
dependency, model or service.

**Study calendar:** in the local Hoard app, Actividades y entregas → Llevar
fechas al calendario previews and downloads an ICS snapshot of saved deliverables
(including exams). Choose a date range, the selected/all subjects, and whether to
include completed items. Showing the calendar runs the existing local sync first;
any sync error is shown and the snapshot still describes the server's study bank.
The downloaded text is the same snapshot as the preview. Date-only deadlines are
all-day events; saved times remain floating local times with no invented timezone
or duration. Stable UIDs follow the record. Missing/invalid dates or times are
listed separately. No teacher records, grades, legacy subject exam dates, alarms
or inferred study sessions are included. Importing an ICS does not establish live
sync with Hypatia.

`study_calendar_export` and `POST /api/study/calendar/export` share one native
read-only calculation: required `date_from`/`date_to` (`YYYY-MM-DD`), optional
`subject` (id/name; omit for all), and `include_completed` (default false).
Returns events, excluded items/reasons, filter counts, filename, generated_at and
ICS text. It uses the existing vendored [RFC5545 iCalendar](https://datatracker.ietf.org/doc/html/rfc5545)
builder without a new dependency, model, service or change to the study bank.
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

## Native record edits

Read full study records with MCP `record_get` or GET `/api/bank/records/{kind}/{id}`. Apply only changed fields with `record_patch` or PATCH on the same route: omitted fields retain their latest values, including concurrent edits. Null clears optional fields; hashes, search and sync revisions update together. Unknown or deleted ids never create records. See [Record API](docs/API.md).

## Faustus copilot

The local Hoard shows the shared Faustus panel on every main view. Faustus owns the active conversations, drafts, model and tool turns. Hypatia provides the current view, its real study/teacher object ids, selection and visible unsaved editor fields; `new` and missing ids provide no invented object. The panel follows the app language and theme and uses the global Faustus model configuration.

The server exposes `/api/copilot/info`, `/api/copilot/panel.js` and `/api/copilot/proxy` using the canonical HoardLink transport. The persistent `copilot-space-id` identifies this data directory; endpoint credentials stay on the server. There is no additional agent loop in the panel. Tool changes refresh study and teacher lists without remounting open editors. Changed-field saves use the native atomic record API; arrays and nested objects remain whole-field replacements.

Notebook source Q&A and the Socratic tutor retain their cited, pedagogical workflows; Continue in Faustus opens the shared assistant. Existing local notebook conversations remain readable with their citations; Continue imports the selected conversation through the shared idempotent import API with original message ids, dates and citation metadata. General assistant turns run in Faustus, with separate sessions and drafts for each subject. Source Q&A and Tutor retain their native UI turns, citations, passages and weakness feedback. The native source/tutor tools and educational state remain available, and the original notebook data are retained. To use this UI, start the configured Faustus service and rebuild the local PWA with `npm run build`. The public offline PWA retains its existing behaviour.

### Exact interpolation

**Interpolación de puntos** takes one abscissa/value pair per line, separated by a semicolon. Integers, finite decimals and integer fractions retain their exact rational values. POST /api/math/interpolate and MCP math_interpolate share {points: [['0','1'],['1/2','5/4'],['1','2']], variable: 'x'}. The result includes the expanded polynomial, LaTeX, degree, descending coefficients, original/exact coordinates and substitution residuals. Equivalent abscissas are rejected with row numbers; one point gives a constant, and the zero polynomial has null degree. Editable examples, recoverable errors and full query/result copy are available in the dashboard; input edits retire pending results. The open draft is available to Faustus. No study data is read or changed. This is exact interpolation over rational input, unique among polynomials of degree less than the point count, not regression or prediction. It uses the existing [SymPy interpolate](https://docs.sympy.org/latest/modules/polys/reference.html#sympy.polys.polyfuncs.interpolate); no added model, dependency or service.

### Exact integer base conversion

**Conversión de bases** converts signed integer strings between bases2–36 and shows binary, octal, decimal and hexadecimal equivalents. POST /api/math/base-convert and MCP math_base_convert share {number: 'FF', source_base:16, target_base:2}. Results are strings throughout, including values above2^53; input normalization removes leading zeros and prefixes without rounding. Standard Python int syntax accepts signs, case-insensitive letters, digit separators and matching2/8/16 prefixes; output digits are uppercase. Existing runtime integer-conversion limits still apply. The UI keeps editable examples, retires results after edits and copies the complete query/result/equivalents. No bank or model is used. This is not fractional conversion, fixed-width encoding or two's complement. Primary semantics: https://docs.python.org/3/library/functions.html#int .

### Exact matrices

**Matrices exactas** computes determinants, inverses and reduced row echelon forms from rational entries. One row per line, semicolon-separated, with editable inverse/fraction/singular/rectangular examples. POST /api/math/matrix and MCP math_matrix share {matrix:[['1','2'],['3','4']], operation:'inverse'}; operations are determinant, inverse (default) or rref. Results retain written and exact matrix entries. Inverses include the determinant and exact A*inverse-I residuals; singular matrices return status singular, inverse null and verified null. RREF reports rank and one-based pivot-column indices, including rank0/no pivots. Determinant/inverse need square matrices; RREF supports rectangular matrices. Integers, finite decimals and integer fractions reuse the existing exact literal parser. Results are exact fractions, not floating-point approximations or a step-by-step proof. Tables scroll by keyboard on narrow screens; copy includes input, output and residuals. Edits retire pending results, errors retain input and open drafts are available to Faustus. No study data/model/dependency changes. Primary engine semantics: https://docs.sympy.org/latest/tutorials/intro-tutorial/matrices.html .

## Finite continued fractions

The exact calculator now expands rational literals into finite continued fractions
and lists every convergent. `math_continued_fraction` and
`POST /api/math/continued-fraction` share the same calculation. For `355/113`,
the coefficients are `[3; 7, 16]` and the convergents are `3`, `22/7`, `355/113`.
Inputs and results stay exact strings, including negatives and large integers.
The final convergent reconstructs the normalized input; no study data changes.
The inline panel includes an example, a term/convergent table and text copy.
Only integers, finite decimals and integer fractions are accepted by the existing
numeric parser; this does not expand irrational periods or prove approximation
optimality. The catalog contains 67 tools (49 Study + 18 Teacher).
