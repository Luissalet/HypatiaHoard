# Exam Coach — FULL STRUCTURE map

Map of every source file under `src/`, plus the root configs that shape how the app builds and ships.

- **Project name (in `package.json`)**: `study-app`
- **Stack**: React 18 + TypeScript 5 + Vite 5 + Tailwind 3 + Zustand 5 + Dexie 3 (IndexedDB) + `react-router-dom` 6 (HashRouter)
- **Path alias**: `@/* → ./src/*` (tsconfig `baseUrl: "."` + `paths`)
- **PWA**: `vite-plugin-pwa` with autoUpdate + service worker + install banner
- **Bundle**: client-only SPA, no backend in production. Optional dev API at `/api/upload-pdf`, `/api/upload-question-image`, `/api/write-global-bank` when `npm run dev` is running.
- **Storage**: IndexedDB (Dexie v1→v8), File System Access API / OPFS for big PDFs, GitHub Gist for cross-device sync, GitHub Releases for package marketplace.
- **Working language**: Spanish (UI strings and most code comments).

Legend used throughout: 🧠 = domain logic, 💾 = persistence, 🔌 = external service / I-O, 🎨 = UI page, 🧱 = UI component, 🛠 = utility, 🤖 = AI provider, 🔊 = TTS / audio, 📄 = PDF tools, 🚦 = orchestration / entrypoint.

---

## Root configs and entrypoint files

| File | Purpose |
|---|---|
| `package.json` | Vite scripts (`dev`, `build`, `preview`, `lint`). Deps: dexie, react/react-dom, react-router-dom, zustand, zod, marked + marked-katex-extension, katex, jspdf, pdf-lib, pdfjs-dist, html-to-image, html2canvas, jszip, mammoth, mespeak, onnxruntime-web, @mintplex-labs/piper-tts-web, uuid. |
| `tsconfig.json` | Strict TS, ES2020 target, `jsx: react-jsx`, path alias `@/* → ./src/*`. |
| `tsconfig.node.json` | TS config for `vite.config.ts` runner. |
| `vite.config.ts` | Vite + `@vitejs/plugin-react` + `vite-plugin-pwa` (autoUpdate). |
| `tailwind.config.js` | Tailwind theme tokens (custom ink-/amber-/sage-/rose- scales used everywhere). |
| `postcss.config.js` | Tailwind + autoprefixer pipeline. |
| `index.html` | App shell. Mounts `<div id="root">` and loads `/src/main.tsx`. |
| `src/main.tsx` 🚦 | Entry: starts `startAutoSync()` (Gist), wires `BackgroundSynthesisManager → Zustand` via `setProgressUpdater`, mounts `<ThemeProvider><AppRouter /></ThemeProvider>` + the three global banners (`PwaUpdateBanner`, `PwaInstallBanner`, `StorageWarningBanner`). |
| `src/index.css` | Tailwind base + dark/light theme CSS variables (`[data-theme="light"]` overrides). |
| `src/vite-env.d.ts` | Vite `import.meta.env` typings. |

---

## Top-level layout under `src/`

```
src/
├── main.tsx                       Entry — boots router, sync, theme, banners
├── index.css                      Tailwind + theme tokens
├── vite-env.d.ts
│
├── domain/                        🧠 Pure logic, no storage / no UI
│   ├── models.ts                  All shared types and `isDeliverableCompleted()`
│   ├── normalize.ts               normalizeText() + slugify()
│   ├── hashing.ts                 contentHash for questions (SHA-256)
│   ├── scoring.ts                 Auto-score TEST / COMPLETAR / DESARROLLO / PRACTICO
│   ├── spacedRepetition.ts        SM-2 algorithm + sortByPriority
│   └── grading.ts                 Continuous-eval grade breakdown
│
├── data/                          💾 Persistence layer (Dexie + external sync)
│   ├── db.ts                      StudyDB Dexie class — 14 tables, versions 1-8
│   ├── repos.ts                   subjectRepo, topicRepo, questionRepo, sessionRepo,
│   │                              keyConceptRepo, examRepo
│   ├── deliverableRepo.ts         deliverableRepo + gradingConfigRepo
│   ├── pdfStorage.ts              FSA → IndexedDB → dev-server fallback for PDF blobs
│   ├── fsaStorage.ts              File System Access API + OPFS support, quota check, migration
│   ├── questionImageStorage.ts    Inline question images (uuid.ext) → IndexedDB
│   ├── resourceFromDB.ts          Load category/subcategory of resources from IDB
│   ├── resourceLoader.ts          Static repo assets: resources/[slug]/{Temas,extra_info.json}
│   ├── resourceImporter.ts        Import resources ZIP (Temas/Examenes/Practica/Resumenes)
│   ├── packageManager.ts          Install / uninstall / export .examcoach.zip packages
│   ├── packageRegistry.ts         GitHub Releases catalog + update detection
│   ├── packageCrypto.ts           AES-256-GCM encrypt/decrypt for paid packs (.enc)
│   ├── globalBank.ts              Sync with bundled /data/global-bank.json
│   ├── global-bank.json           Bundled seed question bank (asset)
│   ├── gistSync.ts                Push/pull/merge full backup via GitHub Gist
│   ├── exportImport.ts            BankExport / ExamExport import/export + dedup
│   ├── exportCompact.ts           ChatGPT-friendly minimal subject dump
│   ├── exportStudyGuide.ts        Markdown study guide of weak/starred questions
│   ├── contributionImport.ts      Contribution pack preview / import / undo / export
│   ├── generateContributionGuide  Generates GUIA_CONTRIBUTION_PACKS.md per user
│   └── keyConceptsImport.ts       KeyConcepts pack import/export
│
├── services/                      🔌 Higher-level services and providers
│   ├── aiEngine.ts                Provider factory, file→text extraction, explanation gen
│   ├── generateSubjectGuide.ts    Slim contribution guide for AI prompts
│   ├── providers/
│   │   ├── openaiProvider.ts      OpenAI chat-completions provider
│   │   ├── anthropicProvider.ts   Anthropic messages provider (browser CORS)
│   │   └── webllmProvider.ts      WebGPU-local Llama via @mlc-ai/web-llm
│   └── pdfTools/                  📄 Client-side PDF manipulation
│       ├── index.ts               Barrel export + downloadBlob/formatSize
│       ├── merge.ts               mergePdfs
│       ├── split.ts               splitPdf + parsePageRanges
│       ├── extract.ts             extractPages, getPdfPageCount
│       ├── rotate.ts              rotatePdf
│       ├── imagesToPdf.ts         imagesToPdf
│       ├── watermark.ts           addWatermark
│       └── metadata.ts            readMetadata / editMetadata
│
├── ui/                            🎨 React UI (pages + components + store)
│   ├── routes.tsx                 HashRouter + 16 routes (5 eager + 11 lazy) + redirect
│   ├── store/index.ts             Zustand store (single store, all data + actions)
│   ├── context/ThemeContext.tsx   dark / light theme switch (localStorage `ec-theme`)
│   ├── pages/                     One file per route — see "Pages" section below
│   └── components/                Shared components — see "Components" section below
│
├── utils/                         🛠 Pure utilities (TTS, PDF, anki, render)
│   ├── renderMd.ts                marked + marked-katex-extension wrapper
│   ├── pdfTextExtractor.ts        pdfjs-dist → structured blocks (heading/list/math/...)
│   ├── pdfExport.ts               jsPDF + html2canvas exporters
│   ├── ankiImport.ts              parseAnkiTsv
│   ├── ankiExport.ts              exportToAnkiTsv
│   ├── questionUtils.ts           questionBelongsToTopic helper
│   ├── mathSymbolSpeech.ts        Unicode-math → Spanish speech text
│   ├── ttsEngine.ts 🔊            Web Speech API wrapper with bg-resume
│   ├── audioTtsEngine.ts 🔊       Piper neural TTS, single-track WAV (Android-safe)
│   ├── piperTts.ts 🔊             Piper VITS loader + IndexedDB model cache
│   ├── localTts.ts 🔊             meSpeak fallback (deprecated path, kept)
│   ├── webTts.ts 🔊               DEPRECATED stub
│   ├── edgeTts.ts 🔊              DEPRECATED stub
│   ├── audioKeepalive.ts 🔊       <audio> + AudioContext + Wake Lock to survive backgrounding
│   ├── mediaSessionController.ts 🔊  Lock-screen / notification media controls
│   └── backgroundSynthesis.ts 🔊  Singleton TTS pre-synthesis with progress → Zustand
│
└── types/
    └── mespeak.d.ts               Ambient module decl for the meSpeak CommonJS lib
```

---

## Pages (`src/ui/pages/`)

Each file is a default-exported (named export, used by `routes.tsx`) React page component. Lazy-loaded entries are marked `lazy`.

| Route | File | Function |
|---|---|---|
| `/` | `Dashboard.tsx` 🎨 | Home grid. Subjects with progress, calendar widget, deliverables, study streak, sync banner, quick global search, links to global stats, marketplace, settings. Triggers orphan-subject migration, color-fix migration, record-repair, and `syncGlobalBank` on mount. |
| `/marketplace` (lazy) | `Marketplace.tsx` 🎨 | Fetches `packageRegistry`, installs `.examcoach.zip` (decrypts `.enc` if needed via `packageCrypto`). Shows installed list with update hints. |
| `/pdf-tools` (lazy) | `PdfToolsPage.tsx` 🎨 | UI for `services/pdfTools/*` — merge, split, extract, rotate, images→PDF, watermark, metadata. All client-side. |
| `/global-practice` (lazy) | `GlobalPracticePage.tsx` 🎨 | Cross-subject session builder. Picks subjects, topics, types, mode; persists `subjectIds` on the resulting `PracticeSession`. |
| `/subject/:subjectId` | `SubjectView.tsx` 🎨 | The fat one. Tabs: Topics / Questions / Practice / Exams / Resources / Concepts / Chatbots / IA. CRUD for topics, questions, exams. Uploads PDFs (FSA → IDB → dev server). Launches practice sessions, Read mode, Listen mode. Hosts `<AIExtractionTab>` and `<KeyConceptsTab>`. |
| `/subject/:subjectId/stats` (lazy) | `Stats.tsx` 🎨 | Per-subject stats: Leitner boxes, knowledge map, recent finished sessions, downloadable Markdown study guide. |
| `/subject/:subjectId/read/:topicId` (lazy) | `ReadMode.tsx` 🎨 | Read-only review of all questions for a topic with keyboard nav. |
| `/subject/:subjectId/listen/:topicId` (lazy) | `PdfListenMode.tsx` 🔊 | TTS playback of the topic PDF using `pdfTextExtractor` + `audioTtsEngine`/Piper, with media-session controls and background-survival audio keepalive. |
| `/subject/:subjectId/listen-resource` (lazy) | same component | Same page in "resource mode" (`?file=Resumenes/...`). |
| `/practice/:sessionId` | `PracticeSession.tsx` 🎨 | The session player. Question-by-question UI. Supports normal sessions + exam mode (`?examMode=true&duration=60`). Calls `scoreAnswer`, `questionRepo.updateStats` → SM-2 → IDB. Side `<KeyConceptsSidebar>`. |
| `/results/:sessionId` | `Results.tsx` 🎨 | Per-question result review with manual correction for DESARROLLO. |
| `/settings` | `Settings.tsx` 🎨 | Alias, AI keys (modal), GitHub token, sync controls, FSA folder setup, OPFS toggle, migrate-to-folder, export/import bank/exams/contributions, undo imports, sync images to dev server. |
| `/flashcard/:subjectId` (lazy) | `Flashcard.tsx` 🎨 | Visual flip-card review. URL params: `?topic`, `?types`, `?mode`, `?count`. Does not write stats. |
| `/deliverables` (lazy) | `Deliverables.tsx` 🎨 | Continuous-evaluation tracker — activities, tests, exams; status cycle pending → in_progress → done → submitted; uses `domain/grading.ts`. |
| `/sessions` (lazy) | `SessionHistory.tsx` 🎨 | Filter+list of finished `PracticeSession`s. |
| `/stats` (lazy) | `GlobalStats.tsx` 🎨 | Global performance curve, study streak, 70% target line. |
| `*` | redirects to `/` | catch-all. |

---

## Components (`src/ui/components/`)

| File | Function |
|---|---|
| `index.tsx` 🧱 | Design-system primitives: `Button`, `Input`, `Textarea`, `Select`, `Card`, `Modal`, `Tabs`, `Badge`, `TypeBadge`, `Difficulty`, `Countdown`, `Progress`, `EmptyState`, `StatsSummary`. Tailwind classes, dark/light aware. |
| `MdContent.tsx` 🧱 | Renders Markdown + KaTeX via `renderMd`. Rewrites `question-images/uuid.ext` → blob URL fallback through `getQuestionImageBlobUrl()` when the static asset 404s. |
| `QuestionForm.tsx` 🧱 | Editor for all four question types. Drag-and-drop image upload → `saveQuestionImage`. Inline MD preview. |
| `QuestionPreview.tsx` 🧱 | Resolved-answer preview, includes "generate explanation" call to `generateExplanation` (OpenAI/Anthropic). Also exports `renderClozePreview`. |
| `ExamsTab.tsx` 🧱 | UI for the Exams tab of a subject — pick questions, order them, export/import exam JSON. |
| `KeyConceptsTab.tsx` 🧱 | CRUD for formulas/definitions/remarks + KeyConcepts pack import/export + PDF export. |
| `KeyConceptsSidebar.tsx` 🧱 | Resizable side panel inside PracticeSession to look up formulas during practice. |
| `AIExtractionTab.tsx` 🤖 | "IA" tab of SubjectView. Pick file → `extractFileContent` → `getActiveProvider().extractQuestions` → opens `AIReviewModal`. |
| `AIReviewModal.tsx` 🤖 | Review extracted questions one-by-one with editable fields and topic override. |
| `AISettingsPanel.tsx` 🤖 | Modal to configure provider, API key, model. Tests connection. |
| `PdfViewer.tsx` 🧱 | pdfjs-dist viewer with `goToPage` ref handle + thumbnail/list selector. |
| `PdfExportModal.tsx` 🧱 | Generic selector for "export N items as PDF" with grouping/expand-collapse — reused by Questions, Concepts, Exams tabs. |
| `TtsControls.tsx` 🔊 | Mini-player UI for the TTS engines. Rate cycling (0.75–2.0). |
| `LeitnerBoxes.tsx` 🧱 | 5-bucket histogram derived from SM-2 stats; clicking a box starts a session of those questions. |
| `KnowledgeMap.tsx` 🧱 | Per-topic mastery grid (none/low/medium/high) computed from `stats.seen` and `stats.correct/seen`. |
| `CalendarWidget.tsx` 🧱 | Monthly dashboard calendar fed by `deliverableRepo.getAll()`. Diamond = exam, dot = other. |
| `ActiveSessionsSidebar.tsx` 🧱 | Lists unfinished `PracticeSession`s (incl. multi-subject) for resume/cancel. Mobile drawer below `lg`. |
| `PwaUpdateBanner.tsx` 🧱 | Listens to `controllerchange` → shows "reload to update" banner. |
| `PwaInstallBanner.tsx` 🧱 | Listens to `beforeinstallprompt` → install banner (dismissable, localStorage). |
| `StorageWarningBanner.tsx` 🧱 | Polls `checkStorageQuota()` every 5 min; warns at 80%. Hidden if FSA configured. |

---

## Build outputs (not source)

- `dist/` — Vite build artifacts (gitignored). Contains `index.html`, hashed JS/CSS bundles, PWA service worker.
- `node_modules/` — npm deps (gitignored).
- `.git/` — git metadata.

---

## Routes table (from `src/ui/routes.tsx`)

Critical routes are eager-loaded; the rest are lazy with a `<PageLoader>` Suspense fallback.

| Eager | Path | Component |
|---|---|---|
| ✓ | `/` | `Dashboard` |
| ✓ | `/subject/:subjectId` | `SubjectView` |
| ✓ | `/practice/:sessionId` | `PracticeSessionPage` |
| ✓ | `/results/:sessionId` | `ResultsPage` |
| ✓ | `/settings` | `SettingsPage` |
| Lazy | `/marketplace` | `MarketplacePage` |
| Lazy | `/pdf-tools` | `PdfToolsPage` |
| Lazy | `/global-practice` | `GlobalPracticePage` |
| Lazy | `/subject/:subjectId/stats` | `StatsPage` |
| Lazy | `/subject/:subjectId/read/:topicId` | `ReadModePage` |
| Lazy | `/subject/:subjectId/listen/:topicId` | `PdfListenMode` |
| Lazy | `/subject/:subjectId/listen-resource` | `PdfListenMode` (resource mode) |
| Lazy | `/flashcard/:subjectId` | `FlashcardPage` |
| Lazy | `/deliverables` | `DeliverablesPage` |
| Lazy | `/sessions` | `SessionHistoryPage` |
| Lazy | `/stats` | `GlobalStatsPage` |
| — | `*` | redirect → `/` |

`HashRouter` is used so the app works as a static site (GitHub Pages, plain hosting) — every URL is `index.html#/whatever`.

---

## Data-flow narrative (one paragraph)

User clicks something in a page → page calls a `useStore` action (Zustand) → action calls a repo (`subjectRepo`, `questionRepo`, …) → repo writes to `db.<table>` (Dexie / IndexedDB) and returns the updated record → action updates the Zustand state → page re-renders. Pure logic (scoring, SM-2 spaced repetition, content hash, slugify, grade breakdown) lives in `src/domain/*` and is reused on every read/write. External I-O sits in `src/data/*` (Gist, GitHub Releases, FSA / OPFS, dev-server endpoints) and `src/services/*` (OpenAI / Anthropic / WebLLM / Piper TTS). Long-running side-effects — Gist auto-sync, background TTS synthesis — are kicked off from `main.tsx` and live as singletons outside React.

---

## File counts (excluding `node_modules`, `dist`, `.git`)

Counted by listing every file under `src/`:

- `src/` source files: **98**
- `domain/`: **6** TS files (`models`, `normalize`, `hashing`, `scoring`, `spacedRepetition`, `grading`)
- `data/`: **20** TS files + **1** JSON (`global-bank.json`)
- `services/`: **2** root (`aiEngine`, `generateSubjectGuide`) + **3** in `providers/` + **8** in `pdfTools/`
- `ui/pages/`: **15** route components
- `ui/components/`: **20** components (including `index.tsx`, the design-system barrel)
- `ui/context/`: **1** (`ThemeContext`)
- `ui/store/`: **1** (`index.ts`)
- `ui/`: **1** (`routes.tsx`)
- `utils/`: **16** TS files (4 of which — `webTts`, `edgeTts` are DEPRECATED stubs, kept for module-resolution)
- `types/`: **1** (`mespeak.d.ts`)
- root entrypoints: `main.tsx`, `index.css`, `vite-env.d.ts`

