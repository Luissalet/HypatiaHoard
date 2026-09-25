# Exam Coach — FEATURES inventory

Feature-by-feature map: what each one does, where it lives in code, the user flow, and current status.

> **Conventions**
> - Code paths are relative to `src/` unless noted.
> - "Local data" = stays in this device's IndexedDB and **never** leaves to the global bank or contribution packs (`notes`, `starred`, `examDate`, `stats`, API keys, GitHub token, `marketplacePasswords`, `subjectGoals`).
> - The app is offline-first. Every feature that isn't explicitly network-bound works without internet.

---

## 1. Subjects, topics and questions (the core)

### 1.1 Subjects
- **What**: Create / rename / recolor / delete a subject. Optional `examDate` (local-only) and `allowsNotes` flag (cheat-sheet allowed at the exam). Cascade-deletes topics, questions, sessions, anchors, key concepts, PDFs.
- **Where**: `domain/models.ts` (`Subject`), `data/repos.ts` (`subjectRepo`), `ui/pages/Dashboard.tsx`, `ui/store/index.ts`.
- **Flow**: Dashboard → "Nueva asignatura" → modal → save → tile appears with progress.

### 1.2 Topics
- **What**: Ordered list per subject (`order` field). Each topic can link to a single `pdfFilename` (the official PDF in `resources/[slug]/Temas/`).
- **Where**: `domain/models.ts` (`Topic`), `data/repos.ts` (`topicRepo`), `ui/pages/SubjectView.tsx` (Topics tab).
- **Flow**: SubjectView → tab "Temas" → add/rename/reorder.

### 1.3 Questions
- **What**: Four types — `TEST`, `DESARROLLO`, `COMPLETAR`, `PRACTICO`. Markdown + LaTeX in every text field. Optional difficulty 1-5, origin tag (`test` / `examen_anterior` / `clase` / `alumno`), free-form tags, multi-topic via `topicIds`, optional `pdfAnchorId` to jump to a specific PDF page, inline images via `question-images/uuid.ext` references.
- **Where**:
  - Types: `domain/models.ts` (`Question`, `QuestionOption`, `ClozeBlank`, `QuestionStats`).
  - CRUD: `data/repos.ts` (`questionRepo`).
  - Editor: `ui/components/QuestionForm.tsx`.
  - Display: `ui/components/MdContent.tsx` + `utils/renderMd.ts` (marked + marked-katex).
  - Images: `data/questionImageStorage.ts` (save / get / build pack / import).
- **Flow**: SubjectView → Preguntas → "+ Nueva" → QuestionForm → save. The repo computes `contentHash` via `domain/hashing.ts` so duplicates are detected.

### 1.4 Local-only flags on a question
- **What**: `notes` (free-text personal annotation) and `starred` ("difficult — review more"). Both excluded from every export and from `contentHash`.
- **Where**: declared in `Question` (`domain/models.ts`), stripped by `exportGlobalBank` and `exportPackage`, preserved by `gistSync.mergeQuestions`.

---

## 2. Practice sessions

### 2.1 Session modes
- **What**: `random`, `all`, `failed`, `topic`, `smart` (SM-2 priority), `exam` (timed simulation). Multi-subject sessions add `subjectIds` to the session record.
- **Where**: `SessionMode` in `domain/models.ts`, session creation in `SubjectView.tsx` / `GlobalPracticePage.tsx`, scheduler in `domain/spacedRepetition.ts#sortByPriority`.

### 2.2 Session player
- **What**: Renders one question at a time, supports keyboard navigation, computes pass/fail with `domain/scoring.ts` (`scoreTest`, `scoreCompletar`, `scoreAnswer`), shows the `KeyConceptsSidebar` for quick formula lookup, supports exam mode (`?examMode=true&duration=60`).
- **Where**: `ui/pages/PracticeSession.tsx`, `ui/components/KeyConceptsSidebar.tsx`.
- **Flow**: Start session → loop questions → submit → `questionRepo.updateStats()` recalculates SM-2 → `sessionRepo.addAnswer()` → after finish → navigate to Results.

### 2.3 SM-2 spaced repetition
- **What**: Standard SM-2: easeFactor, interval, repetitions, `nextReviewAt` per question; correct/wrong streak adapts the interval. Used by mode `smart` and by `LeitnerBoxes`.
- **Where**: `domain/spacedRepetition.ts` (`calcNextReview`, `sortByPriority`), invoked from `questionRepo.updateStats`.

### 2.4 Auto-scoring
- **What**:
  - TEST: set-equality on `correctOptionIds`.
  - COMPLETAR: per-blank, normalized text vs `accepted[]`.
  - DESARROLLO / PRACTICO: returns `null` → manual correction in Results page.
- **Where**: `domain/scoring.ts`.

### 2.5 Manual correction
- **What**: For DESARROLLO answers, Results page exposes a "correct / wrong" toggle that sets `UserAnswer.manualResult`. `keywordMatchCount` highlights how many `keywords` appeared in the free-text answer.
- **Where**: `domain/scoring.ts#keywordMatchCount`, `ui/pages/Results.tsx`.

### 2.6 Resume incomplete sessions
- **What**: Sessions without `finishedAt` show up in `<ActiveSessionsSidebar>`. Practice page resumes at the first unanswered question.
- **Where**: `ui/components/ActiveSessionsSidebar.tsx`, resume logic in `PracticeSession.tsx`.

### 2.7 Study streak
- **What**: `studyStreak` and `lastStudyDate` updated when a session finishes (`sessionRepo.finish`). Reset to 1 if more than one day gap.
- **Where**: `data/repos.ts#sessionRepo.finish`, displayed on Dashboard and `GlobalStats.tsx`.

---

## 3. Exams (curated sets)

- **What**: An `Exam` is an ordered subset of question IDs for a subject — used to build mock exams or curated flashcard decks.
- **Where**: type in `domain/models.ts` (`Exam`), repo `data/repos.ts#examRepo`, UI `ui/components/ExamsTab.tsx`.
- **Export / import**: `data/exportImport.ts` (`exportExams`, `importExams`) — bundles exams + their referenced questions in an `ExamExport`. On import, questions are matched by `contentHash` against the local bank; missing ones are skipped with a warning.

---

## 4. Key concepts (formulas / definitions / remarks)

- **What**: Per-subject reference cards. Three categories: `formula`, `definition`, `remark`. Markdown + LaTeX content, optional topic link, `order` per category.
- **Where**: type `domain/models.ts#KeyConcept`, repo `data/repos.ts#keyConceptRepo`, tabs `ui/components/KeyConceptsTab.tsx`, in-session lookup `ui/components/KeyConceptsSidebar.tsx`.
- **Export / import**: `data/keyConceptsImport.ts` produces a `KeyConceptsPack` JSON, deduped on import by SHA-256 of `category + title + content`.
- **PDF export**: `utils/pdfExport.ts#generateKeyConceptsPDF` (jsPDF + html2canvas, KaTeX-aware).

---

## 5. Flashcard mode

- **What**: A flip-card practice surface. URL params control filter and count. Does NOT touch `stats`.
- **Where**: `ui/pages/Flashcard.tsx`. Re-renders `clozeText` with the first accepted answer highlighted.
- **Flow**: SubjectView → "Flashcards" → opens `/flashcard/:subjectId?topic=&types=&mode=&count=`.

---

## 6. Read mode

- **What**: A vertical read-only view of every question for a topic, expand for answers, keyboard nav (j/k/arrows, l to expand).
- **Where**: `ui/pages/ReadMode.tsx`.

---

## 7. Listen mode (PDF → TTS)

This is the most engineering-heavy feature.

### 7.1 Two TTS engines
- **`ttsEngine.ts`** 🔊 — wraps `window.speechSynthesis`. Picks the best Spanish voice (Google / MS neural priority). Adds background-resume polling to defeat Chrome Android suspending speechSynthesis.
- **`audioTtsEngine.ts`** 🔊 — pre-synthesizes every block with **Piper VITS** in the browser, concatenates them into a single WAV, plays it through one `<audio>` element. This is the only way to keep playing in the background on aggressive Android 16 builds.

### 7.2 Piper neural TTS
- **What**: `@mintplex-labs/piper-tts-web` runs ONNX in WASM. Six Spanish voices (Carl x-low / Dave / Sharvard / Ald / Claude / mls_10246). First use downloads ~27–90 MB; cached in IndexedDB by `piperTts.ts` (Brave-OPFS-safe).
- **Where**: `utils/piperTts.ts`.

### 7.3 PDF text extraction for TTS
- **What**: Uses `pdfjs-dist` to read fonts, sizes, columns; classifies blocks into `paragraph / heading / math / list / table / callout`; strips headers/footers; merges paragraphs across lines.
- **Where**: `utils/pdfTextExtractor.ts`.

### 7.4 Math-to-speech
- **What**: Converts Unicode math (α, ∫, ∇, ≈, ⊆, …) and KaTeX-ish patterns into Spanish text before TTS.
- **Where**: `utils/mathSymbolSpeech.ts`.

### 7.5 Background-survival audio
- **What**:
  - Real-WAV keep-alive `<audio>` (150 Hz at -70 dBFS) in DOM loop so Android doesn't kill the tab.
  - AudioContext oscillator as backup.
  - Screen Wake Lock.
- **Where**: `utils/audioKeepalive.ts`.

### 7.6 Media Session API
- **What**: Lock-screen / notification controls with title (PDF or topic) and play/pause/next/prev/stop/seek.
- **Where**: `utils/mediaSessionController.ts`.

### 7.7 Background WAV pre-synthesis
- **What**: Singleton manager `BackgroundSynthesisManager` that keeps generating block WAVs even after the user navigates away from `PdfListenMode`. Reports progress to the Zustand store (`synthesisJobs`). Cached in IndexedDB DB `audio-tts-wav-cache`.
- **Where**: `utils/backgroundSynthesis.ts`. Wired in `main.tsx` via `setProgressUpdater`.

### 7.8 UI
- **Where**: `ui/pages/PdfListenMode.tsx` and `ui/components/TtsControls.tsx`. Two URL shapes:
  - `/subject/:subjectId/listen/:topicId` — topic PDF.
  - `/subject/:subjectId/listen-resource?file=Resumenes/foo.pdf` — any other resource.

---

## 8. PDF support

### 8.1 Viewer
- **Where**: `ui/components/PdfViewer.tsx` — pdfjs-dist viewer with `goToPage(n)` exposed via `forwardRef` so question buttons "Abrir en página X" can jump there.

### 8.2 PDF storage (three-tier)
1. **File System Access API** (Chrome / Edge 86+) — picks a real folder on disk. Handle is stored in Dexie table `fsaHandles`. Files: `[chosen folder]/[subjectId]/[filename].pdf`.
2. **OPFS** (`navigator.storage.getDirectory()`) — Android Chrome / iOS Safari 15.2+. No picker, no quota dialog.
3. **IndexedDB** (`pdfResources` table) — universal fallback.
- **Where**: `data/fsaStorage.ts`, `data/pdfStorage.ts`. Quota check `checkStorageQuota`. One-shot migration `migrateAllPdfsToFolder`.

### 8.3 Dev-server PDF upload
- **What**: When `npm run dev` is running, `POST /api/upload-pdf` writes the PDF into `resources/[slug]/Temas/` and updates `index.json`. Lets the maintainer commit PDFs to git.
- **Where**: `data/pdfStorage.ts#savePdfToServer`.

### 8.4 PDF tools page
- **What**: 100 % client-side using `pdf-lib`. Merge, split (by ranges / size / every-N), extract pages, rotate (90/180/270), images→PDF, watermark, read/edit metadata.
- **Where**: `services/pdfTools/*` + `ui/pages/PdfToolsPage.tsx`.

### 8.5 PDF export of questions / concepts / exams
- **What**: Renders Markdown + KaTeX into HTML, screenshots with html2canvas, drops into jsPDF page-by-page.
- **Where**: `utils/pdfExport.ts` (`generateQuestionsPDF`, `generateKeyConceptsPDF`, `generateExamsPDF`). Selector modal: `ui/components/PdfExportModal.tsx`.

---

## 9. AI question extraction / generation

### 9.1 Providers
- **`OpenAIProvider`** — `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`. Direct fetch to `api.openai.com`.
- **`AnthropicProvider`** — `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-5`. Uses `anthropic-dangerous-direct-browser-access` header.
- **`WebLLMProvider`** — Local Llama 3.1 / 3.2 via WebGPU. First load downloads ~4 GB model. Singleton engine cache.
- **Where**: `services/providers/openaiProvider.ts`, `anthropicProvider.ts`, `webllmProvider.ts`. Selected by `services/aiEngine.ts#getActiveProvider`.

### 9.2 Modes
- `generate` — produce N new questions from any uploaded text.
- `extract` — pull questions that already exist in the document.

### 9.3 File ingestion
- **What**: PDF (via `pdfTextExtractor`), DOCX (via `mammoth`), TXT / MD, and images (sent to vision API as base64).
- **Where**: `services/aiEngine.ts#extractFileContent`.

### 9.4 Subject-aware prompts
- **What**: Builds a slim "Anexo de topicKeys exactos" tailored to the current subject so the model uses real slugs.
- **Where**: `services/generateSubjectGuide.ts`. Optionally a full guide from `data/generateContributionGuide.ts`.

### 9.5 Review modal
- **What**: Accept / reject / edit each extracted question, override topic, then bulk-create through `questionRepo.create`.
- **Where**: `ui/components/AIReviewModal.tsx`. Triggered by `ui/components/AIExtractionTab.tsx`.

### 9.6 Single-question explanation generator
- **What**: For any TEST question, generates a short Spanish explanation via the active provider.
- **Where**: `services/aiEngine.ts#generateExplanation`, called from `ui/components/QuestionPreview.tsx`.

---

## 10. Continuous evaluation (grades & deliverables)

### 10.1 Deliverables tracker
- **What**: Activities (graded 0–10), tests (binary completion), exams (the final exam), and "otro". Each has a status cycle `pending → in_progress → done → submitted`, a due date / time, and a `continuousPoints` weight.
- **Where**: type `domain/models.ts#Deliverable`, repo `data/deliverableRepo.ts`, UI `ui/pages/Deliverables.tsx`. Calendar feed `ui/components/CalendarWidget.tsx`.

### 10.2 Grading config
- **What**: Per-subject `SubjectGradingConfig` (continuous weight, cap, default test points, exam grade).
- **Where**: `domain/models.ts#SubjectGradingConfig`, repo `data/deliverableRepo.ts#gradingConfigRepo`. Defaults in `domain/grading.ts#DEFAULT_GRADING_CONFIG`.

### 10.3 Grade math
- **What**: `calcContinuousRaw`, `calcGradeBreakdown` (raw, capped, contribution, exam contribution, final, remaining potential, best case).
- **Where**: `domain/grading.ts`. Worked-example in the file header.

---

## 11. Marketplace (subject packages)

### 11.1 Package format
- A `.examcoach.zip` containing:
  - `manifest.json` (`PackageManifest`)
  - `bank.json` (`SubjectBank`: topics, questions, keyConcepts, exams, pdfAnchors)
  - `Temas/`, `Examenes/`, `Resumenes/`, `Practica/` folders with PDFs and other resources
- Paid / private packs are AES-256-GCM encrypted into `.examcoach.enc` (PBKDF2-SHA256, 100 k iterations).

### 11.2 Registry (GitHub Releases)
- **What**: `packageRegistry.ts` lists releases of `Mlgpigeon/SubjectPacks`. Manifest is read from a ```json``` code block in the release body. Downloads go through a Cloudflare Worker proxy (`https://examcoach-proxy.examcoach.workers.dev`) for CORS.
- **Where**: `data/packageRegistry.ts`. 5-minute localStorage cache (`examcoach-registry-cache`). Stale cache returned on rate-limit / offline.

### 11.3 Install / uninstall / export
- **Where**: `data/packageManager.ts` (`installPackage`, `uninstallPackage`, `exportPackage`).
- Deduplicates topics by slug, questions by `contentHash`, key concepts by `contentHash`, exams by name. Existing local subject (same slug) is reused; otherwise a new one is created with a picked color.
- Resources are imported into `pdfResources` with category prefixes (`Examenes/`, `Resumenes/…`).

### 11.4 Encryption
- **Where**: `data/packageCrypto.ts` (AES-256-GCM). UI prompts for password; stored per-pack in `settings.marketplacePasswords` so re-decryption is silent.

### 11.5 Orphan migration & repair
- **What**: `migrateOrphanSubjects` — for old subjects imported before the marketplace existed, build a synthetic `InstalledPackage` so they show up as "installed". `repairOrphanRecords` — find deliverables / sessions / grading configs / topics / questions that point to a now-deleted subject and reassign them by slug or by `contentHash` matching.
- **Where**: `data/packageManager.ts`. Triggered from `Dashboard` on mount.

### 11.6 UI
- **Where**: `ui/pages/Marketplace.tsx`. Search, install progress, update detection (`checkForUpdates` via semver compare).

---

## 12. Global bank (bundled seed)

- **What**: `src/data/global-bank.json` ships with the app. On first load (or forced from Settings), `syncWithGlobalBank` merges into IndexedDB. Identity is by `slugify(name)` for subjects, composite slug for topics, and `contentHash` for questions / key concepts. `examDate` is never written; `stats` start at 0.
- **Where**: `data/globalBank.ts`. Triggered from `useStore.syncGlobalBank` on first run. Validated by Zod (`BankExportSchema`).

---

## 13. Contribution packs (community-authored questions)

### 13.1 Format
- `ContributionPack` — version 1, kind "contribution". Each question has `subjectKey`, `topicKey`, optional `topicKeys[]` for multi-topic, optional `pdfAnchor`, optional inline images.

### 13.2 Authoring guide
- **What**: `generateContributionGuide.ts` produces a personalized `GUIA_CONTRIBUTION_PACKS.md` from the user's actual subjects/topics so ChatGPT prompts get exact slugs.
- **Where**: `data/generateContributionGuide.ts`.

### 13.3 Preview / import / undo
- **What**: `previewContributionPack` shows per-subject/topic new-vs-duplicate counts. `importContributionPack` dedups by `contentHash`, can map unmatched topics manually (`TopicMappings`), guards against re-entry. `undoContributionImport` deletes everything that came from a given `sourcePackId` and removes the entry from `importHistory`.
- **Where**: `data/contributionImport.ts`. UI: `ui/pages/Settings.tsx`.

### 13.4 Export
- **Where**: `exportContributionPack` (whole subject or topic) and `exportContributionPackByIds` (selective). Inline-image map is built from any `question-images/` reference in the prompts.

### 13.5 Commit & clean (maintainer)
- **What**: `commitAndCleanContributions` writes the current global bank to `src/data/global-bank.json` via `POST /api/write-global-bank` (dev server only), then clears `sourcePackId` from all questions / key concepts so they become part of the bank.
- **Where**: `data/exportImport.ts`. Used from Dashboard's "Commit" button.

### 13.6 Remove duplicates
- **What**: Re-hash every question with the current algorithm, group by hash, keep the most-seen + most-recent, delete the rest, and prune broken refs from sessions.
- **Where**: `data/exportImport.ts#removeDuplicateQuestions`. Used from Dashboard.

---

## 14. Resources (PDFs / DOCX / notebooks per subject)

- **What**: Each subject can have `Temas/`, `Examenes/`, `Resumenes/[autor]/`, `Practica/[actividad]/` of any document type.
- **Static path**: `public/resources/[slug]/...` shipped with the build (`data/resourceLoader.ts` resolves URLs via `import.meta.env.BASE_URL`).
- **DB path**: imported via ZIP using `data/resourceImporter.ts`; listed with `data/resourceFromDB.ts`. Combines both sources via `data/pdfStorage.ts#listStoredPdfs`.
- **Mapping**: A `Temas/index.json` describes `{ topicTitle, pdf }[]`; on import we try to auto-link PDFs to topics by title.

---

## 15. Sync across devices (GitHub Gist)

- **What**: Push the entire DB (subjects / topics / questions / sessions / pdfAnchors / keyConcepts / exams / deliverables / gradingConfigs / settings / inline images / installedPackages + a PDF manifest) into a private Gist. Pull merges in with the same dedup keys as the global bank. PDFs go as base64 files; large PDFs are split into 10-page parts with `pdf-lib`.
- **Where**: `data/gistSync.ts`. Auto-sync every 5 min + on `visibilitychange=hidden`. Wired in `main.tsx` via `startAutoSync`.
- **Not synced**: API keys, GitHub token itself, `fsaHandles`, the Piper WAV cache.

---

## 16. Anki interop

- **Export**: `utils/ankiExport.ts#exportToAnkiTsv` — Anki-compatible TSV `Front\tBack\tTags`.
- **Import**: `utils/ankiImport.ts#parseAnkiTsv` — creates DESARROLLO questions from Anki cards.

---

## 17. Stats and visualizations

- **Per-subject** (`Stats.tsx`): `LeitnerBoxes` (5 buckets from SM-2 fields), `KnowledgeMap` (topic-mastery grid), recent sessions, study-guide download.
- **Per-subject study guide**: `data/exportStudyGuide.ts#generateStudyGuide` — Markdown of weak (<70 %) or starred questions, with model answers/options and personal notes.
- **Global** (`GlobalStats.tsx`): performance curve, streak, 70 %-target reference line.
- **Search**: Global search bar on Dashboard, scoped to all questions across all subjects.

---

## 18. Theme & PWA

- **Theme**: `ui/context/ThemeContext.tsx` toggles `data-theme="light"|"dark"` on `<html>` and persists in `localStorage` (`ec-theme`). Matched by `index.css` CSS variables.
- **PWA**: `vite-plugin-pwa` `autoUpdate`. `PwaUpdateBanner` reloads on controller-change. `PwaInstallBanner` listens for `beforeinstallprompt` and includes an iOS hint. `StorageWarningBanner` polls quota every 5 min.

---

## 19. Settings & utilities

- **Where**: `ui/pages/Settings.tsx`. Exposes:
  - Alias (for contribution `createdBy`).
  - AI settings modal (`AISettingsPanel`).
  - GitHub token + Gist sync (push / pull / "fetch raw URL").
  - PDF folder setup (FSA picker or OPFS toggle) + one-click migrate.
  - Bank export (`exportBank` / `exportGlobalBank`), exam export/import, contribution preview/import/undo, compact export, image dev-server sync.
  - Import history display.

---

## Feature → file quick index

| Feature | Primary file |
|---|---|
| Questions CRUD | `data/repos.ts#questionRepo` |
| Auto-score | `domain/scoring.ts` |
| SM-2 | `domain/spacedRepetition.ts` |
| Continuous grade | `domain/grading.ts` |
| Content hashing | `domain/hashing.ts` |
| Slug / normalize | `domain/normalize.ts` |
| Persistence | `data/db.ts` |
| Big-PDF storage | `data/fsaStorage.ts` + `data/pdfStorage.ts` |
| Cross-device sync | `data/gistSync.ts` |
| Global bank | `data/globalBank.ts` |
| Contribution packs | `data/contributionImport.ts` |
| Marketplace | `data/packageManager.ts` + `data/packageRegistry.ts` |
| AES encrypt | `data/packageCrypto.ts` |
| Inline images | `data/questionImageStorage.ts` |
| AI orchestration | `services/aiEngine.ts` |
| TTS player | `utils/audioTtsEngine.ts` / `utils/ttsEngine.ts` |
| Piper voices | `utils/piperTts.ts` |
| Background TTS jobs | `utils/backgroundSynthesis.ts` |
| Markdown + LaTeX | `utils/renderMd.ts` |
| PDF tools | `services/pdfTools/*` |
| PDF export | `utils/pdfExport.ts` |
| State store | `ui/store/index.ts` |
| Routing | `ui/routes.tsx` |
| Bootstrap | `src/main.tsx` |

