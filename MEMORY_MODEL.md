# Exam Coach — MEMORY model

What state exists in this app, where each piece lives, how it's read and written, what's persistent vs ephemeral, and what survives a reload / a device migration / a cache wipe.

This is a **client-only PWA**. Every byte of state is on the user's device or in their personal GitHub Gist. There is no server-side database for production users.

---

## 1. State surfaces overview

| Layer | Tech | Survives reload? | Survives cache clear? | Synced across devices? |
|---|---|---|---|---|
| React component state (`useState`, `useReducer`) | React | ❌ | ❌ | ❌ |
| Zustand store (`useStore`) | Zustand v5 | ❌ (rehydrated from Dexie on mount) | ❌ | ❌ |
| Theme provider | React Context + `localStorage` | ✓ | ❌ | ❌ |
| Dexie / IndexedDB (`StudyAppDB`) | Dexie v3 → IDB | ✓ | ❌ | ✓ via Gist |
| WAV cache (`audio-tts-wav-cache`) | Raw IDB store | ✓ | ❌ | ❌ (manifest only) |
| Piper model cache | Library-controlled IDB / OPFS | ✓ | ❌ | ❌ |
| File System Access folder | OS filesystem (handle in IDB) | ✓ | ✓ (files survive even if IDB cleared) | ❌ (re-pick on each device) |
| OPFS | Browser-private filesystem | ✓ | ❌ | ❌ |
| `localStorage` | Browser kv | ✓ | ❌ | partial (some keys flow through Gist) |
| `sessionStorage` | Browser kv | ❌ (cleared on tab close) | ❌ | ❌ |
| GitHub Gist | Remote | ✓ | ✓ (canonical remote) | ✓ |

---

## 2. The primary store — `StudyAppDB` (Dexie / IndexedDB)

**Class**: `StudyDB` in `src/data/db.ts`. Singleton export `db`. Database name: `StudyAppDB`.

The schema has gone through **8 versions** with one manual upgrade migration at v3 → v4 (renames `Deliverable.completed: boolean` → `Deliverable.status: DeliverableStatus`). The Dexie `version().stores()` declarations for v1 → v8 are kept in the file so old DBs upgrade in place.

### 2.1 Tables (current v8)

```ts
subjects:           id, name, examDate, createdAt
topics:             id, subjectId, order, createdAt
questions:          id, subjectId, topicId, type, difficulty, contentHash, createdAt
sessions:           id, subjectId, mode, createdAt
pdfResources:       id, subjectId, createdAt
pdfAnchors:         id, subjectId, pdfId
settings:           id
questionImages:     id, filename, createdAt
deliverables:       id, subjectId, type, dueDate, status, createdAt
gradingConfigs:     id
keyConcepts:        id, subjectId, category, order, contentHash, createdAt
exams:              id, subjectId, createdAt
fsaHandles:         key
installedPackages:  id, subjectId, installedAt
```

Indexed fields after each `id` are secondary indexes. The first item is the primary key.

### 2.2 What goes in each table

| Table | Row type | Notes |
|---|---|---|
| `subjects` | `Subject` (`domain/models.ts`) | `examDate` is local-only. `allowsNotes` overrides `extra_info.json`. |
| `topics` | `Topic` | `order` for ordering inside a subject. `pdfFilename` points at `resources/[slug]/Temas/*.pdf` for the official handout. |
| `questions` | `Question` | Includes `stats` blob for SM-2. `notes` and `starred` are local-only. Inline images live in `questionImages`; `imageDataUrls` is the deprecated base64 path. |
| `sessions` | `PracticeSession` | `subjectIds?` exists for multi-subject (global) sessions. `answers` is an in-row array. `finishedAt` undefined = "incomplete". |
| `pdfResources` | `PdfResource` | Stores PDF blobs inline (when FSA / OPFS isn't used). `filename` may be `"Tema_1.pdf"` (Temas, raw) or `"Examenes/foo.pdf"` (other categories, with prefix). |
| `pdfAnchors` | `PdfAnchor` | Page + optional bbox. Questions reference via `pdfAnchorId`. |
| `settings` | `AppSettings & { id: 'global' }` | Single row keyed `'global'`. |
| `questionImages` | `QuestionImageRecord` | `id = uuid` (no extension). `filename = uuid.ext`. Markdown references `question-images/uuid.ext`. |
| `deliverables` | `Deliverable` | Activities + tests + exams + "otro". |
| `gradingConfigs` | `SubjectGradingConfig` | `id === subjectId`. |
| `keyConcepts` | `KeyConcept` | Three categories. `contentHash` for dedup. `topicId?` optional. |
| `exams` | `Exam` | Ordered `questionIds`. |
| `fsaHandles` | `FsaHandleRecord` | Only one row, key `'pdf-root'`. Stores a structured-cloneable `FileSystemDirectoryHandle`. |
| `installedPackages` | `InstalledPackage` | Tracks installed marketplace packs and their version. |

### 2.3 Repositories (the **only** way the app reads/writes IDB)

| File | Repo | Notable behaviour |
|---|---|---|
| `data/repos.ts` | `subjectRepo` | `delete` cascades to topics, questions, sessions, pdfAnchors, pdfResources, keyConcepts. |
| | `topicRepo` | `delete` cascades to questions referencing the topic. `getNextOrder` for new-topic ordering. |
| | `questionRepo` | `create` computes `contentHash` via `topicKey = slugify(topicTitle)`. `updateStats` recalculates SM-2. `existsByHash` for dedup. |
| | `sessionRepo` | `finish` also updates the study streak in `settings`. `updateAnswer` patches one answer in place. |
| | `keyConceptRepo` | `create`/`update` compute a SHA-256 of `category + normalizeText(title) + normalizeText(content)` (separate hash from question hash). |
| | `examRepo` | Standard CRUD. `duplicate` appends "(copia)". |
| `data/deliverableRepo.ts` | `deliverableRepo` | `getAll` returns sorted by `dueDate`. |
| | `gradingConfigRepo` | `get` returns default config (not persisted) if no row exists yet. |
| `data/questionImageStorage.ts` | (functions, not a repo) | `saveQuestionImage`, `getQuestionImageBlobUrl`, `extractImageFilenames`, `buildImageMap`, `importImages`. |
| `data/pdfStorage.ts` | (functions) | `savePdfBlob`, `getPdfBlobUrl`, `listStoredPdfs`, `deleteStoredPdf`, `savePdfToServer`. Wraps `fsaStorage.ts`. |

### 2.4 Cascading deletes (do this if you ever delete by hand)

`subjectRepo.delete(id)`:
- `topics`, `questions`, `sessions`, `pdfAnchors`, `pdfResources`, `keyConcepts` where `subjectId === id`.

`topicRepo.delete(id)`:
- `questions` where `topicId === id`.

`uninstallPackage(packageId)` (`data/packageManager.ts`):
- All of the above plus `exams`, `deliverables`, `gradingConfigs` for the subject, and the `installedPackages` row.

### 2.5 In-place migrations

- **v3 → v4** (`Deliverable.completed` → `status`): Dexie `upgrade()` callback walks every row and translates `completed===true && grade!=null` → `submitted`, `completed===true` → `done`, else `pending`. The old `completed` field is `delete`-d.

The rest of the version bumps (v1 → v8) add new tables / indexes; no row rewrites needed.

### 2.6 Repair / migration utilities

These run from the Dashboard on mount (best-effort):
- `migrateOrphanSubjects` (`data/packageManager.ts`) — backfills `installedPackages` for pre-marketplace subjects.
- `assignMissingSubjectColors` — assigns a `pickColor(idx)` to subjects without `color`.
- `repairOrphanRecords` — re-points `deliverables` / `sessions` / `gradingConfigs` / `topics` / `questions` that reference a deleted `subjectId` (slug match → contentHash match → fallback to the only subject if there's just one).

### 2.7 Settings row

The `settings` table holds **one** row with `id: 'global'` and the shape `AppSettings` from `domain/models.ts`:

```ts
interface AppSettings {
  alias: string;                                  // for contribution createdBy
  importedPackIds: string[];                       // dedup contribution packs
  globalBankSyncedAt?: string;                     // ISO of last global-bank merge
  importHistory?: ImportHistoryEntry[];            // for undoContributionImport
  aiSettings?: AISettings;                         // provider + API keys + model
  githubToken?: string;                            // gist sync only
  marketplacePasswords?: Record<string, string>;   // packageId → password
  syncGistId?: string;                             // single Gist for sync
  lastSyncAt?: string;                             // for "git fetch"-style check
  studyStreak?: number;                            // consecutive-days counter
  lastStudyDate?: string;                          // YYYY-MM-DD
  subjectGoals?: Record<string, number>;           // subjectId → target %
  orphanMigrationDone?: boolean;                   // one-shot migration flag
}
```

**Always read with `getSettings()` and write with `saveSettings(partial)`**. `saveSettings` merges over the existing row inside a Dexie transaction so partial updates are safe.

---

## 3. WAV cache (separate IDB DB)

**Purpose**: Cache full pre-synthesized WAV files of topic / resource PDFs so re-opening a listen session is instant.

| Property | Value |
|---|---|
| DB name | `audio-tts-wav-cache` |
| Object store | `wavs` (single store, plain `put(value, key)` API) |
| Key | `cacheKey: string` — typically `${SHA-256 of all texts}:${voiceId}` |
| Value | `{ wav: Blob, blockBoundaries: number[], blockCount, voiceId, createdAt }` |

Both `utils/audioTtsEngine.ts` and `utils/backgroundSynthesis.ts` open this DB independently. They use compatible schemas.

Topic → cacheKey indirection lives in `localStorage` (`wav-topic-key:${topicId}:${voiceId}` → cacheKey), set by `storeTopicWavCacheKey` and read by `getTopicWavCacheKey`. Same pattern for `wav-resource-key:...`.

**Lifecycle**: written once per topic/PDF/voice combination. Not synced cross-device, but the manifest of entries is included in the Gist backup so the other device knows *which* ones it's missing and can regenerate them.

---

## 4. Piper model cache

Managed by the `@mintplex-labs/piper-tts-web` library. Spans ~27–90 MB per voice.

`utils/piperTts.ts` intercepts the library's `fetch()` during `TtsSession.create()` and serves model bytes from our own IndexedDB cache, then tries OPFS too. The result is that Brave Android (which blocks OPFS) still benefits from a cache.

---

## 5. File System Access / OPFS

| Mode | API used | Where files end up |
|---|---|---|
| FSA | `window.showDirectoryPicker` | A folder the user picks. Layout: `[picked]/[subjectId]/[filename].pdf`. |
| OPFS | `navigator.storage.getDirectory` | Browser-private folder (invisible to OS). |

Both produce a `FileSystemDirectoryHandle` which is **structured-cloneable**, so Dexie can store it in `fsaHandles`. We persist:

```ts
interface FsaHandleRecord {
  key: 'pdf-root';
  handle: FileSystemDirectoryHandle;
  name: string;       // shown in Settings
  savedAt: string;
  type?: 'fsa' | 'opfs';
}
```

**Permissions**: FSA permissions are revoked when the browser closes. `verifyPermission(handle, 'readwrite')` is called every time we need to read/write — if granted, no UI is shown; if not, a permission prompt appears.

`pdfStorage.ts` reads in priority **FSA → IDB**, writes "FSA-or-IDB" (FSA preferred), and `deleteStoredPdf` deletes from both to avoid orphans. `migrateAllPdfsToFolder` moves everything from `pdfResources` to disk and frees IDB quota.

---

## 6. `localStorage` keys

Used outside Dexie for things that don't need indexing or are device-local.

| Key | Owner | Purpose |
|---|---|---|
| `ec-theme` | `ui/context/ThemeContext.tsx` | `'dark' \| 'light'` |
| `pwa-install-dismissed` | `PwaInstallBanner.tsx` | `'1'` = user opted out of install prompt |
| `storage-warning-dismissed` | `StorageWarningBanner.tsx` | session-scoped dismissal (also uses `sessionStorage`) |
| `examcoach-registry-cache` | `data/packageRegistry.ts` | `{ entries, fetchedAt }` — 5-min cache of GitHub Releases listing |
| `examcoach-device-id` | `data/gistSync.ts` | UUID identifying this device in the Gist |
| `wav-topic-key:${topicId}:${voiceId}` | `data/backgroundSynthesis.ts` | maps topic to WAV cache key |
| `wav-resource-key:${resourceFile}:${voiceId}` | same | maps resource PDF to WAV cache key |

---

## 7. Zustand store — `useStore`

Defined in `src/ui/store/index.ts`. Single store, no slices. Holds **a working copy of Dexie data** plus loading flags.

### 7.1 Shape

```ts
interface AppStore {
  // Cached data (subset of IDB)
  subjects: Subject[];
  topics: Topic[];               // for the *currently viewed* subject
  questions: Question[];         // for the currently viewed subject
  currentSession: PracticeSession | null;
  keyConcepts: KeyConcept[];
  exams: Exam[];
  settings: AppSettings;

  // Flags
  loading: boolean;
  error: string | null;
  syncing: boolean;
  lastSyncResult: GlobalBankSyncResult | null;

  // Background TTS progress (jobId → SynthesisProgress)
  synthesisJobs: Record<string, SynthesisProgress>;

  // Actions
  loadSubjects, createSubject, updateSubject, deleteSubject
  loadTopics, createTopic, updateTopic, deleteTopic
  loadQuestions, createQuestion, updateQuestion, deleteQuestion, duplicateQuestion
  loadKeyConcepts, createKeyConcept, updateKeyConcept, deleteKeyConcept
  loadExams, createExam, updateExam, deleteExam, duplicateExam
  setCurrentSession, loadSession
  loadSettings, updateSettings
  syncGlobalBank
  setSynthesisProgress
}
```

### 7.2 Lifecycle

- The store is created at import-time but **empty** — initial `subjects: []`, etc.
- Pages call the matching `loadX(subjectId)` in their `useEffect`. The action goes to the repo, awaits Dexie, then `set(...)`.
- On unmount, the store keeps the last-loaded state. The next page swaps it when its load action runs.
- `syncGlobalBank(force?)` is idempotent and self-throttles: it skips if `syncing` is already true or if it has already run and `force` is not set.

### 7.3 Reactivity

The store is wired to side-effects at boot:
- `src/main.tsx` calls `useStore.getState().setSynthesisProgress(jobId, progress)` from inside `setProgressUpdater(...)` so that the background TTS singleton can talk to the store **without** importing React.

---

## 8. React component state

Local component state covers everything that doesn't need persistence:
- Form field buffers (`QuestionForm`, `Settings`, modals).
- Per-question selection state inside `PracticeSession` (`selectedOptions`, `freeText`, `blankAnswers`, `focusedOptionIdx`).
- UI toggles (modal open, sidebar collapsed, "creating subject" mode, etc.).
- Computed visualizations (Stats arrays, calendar grids).

There's no Redux, no react-query, no global event bus. The pattern is: read once from Zustand or directly from a repo in `useEffect`, then operate on local copies. Mutations call store actions which round-trip through Dexie and refresh the cached arrays.

---

## 9. GitHub Gist as cross-device truth (`data/gistSync.ts`)

### 9.1 Payload — `FullBackup` (version 2)

```ts
interface FullBackup {
  version: 2;
  kind: 'full-backup';
  exportedAt: string;
  deviceId: string;
  subjects, topics, questions, sessions, pdfAnchors,
  keyConcepts, exams, deliverables, gradingConfigs,
  syncedSettings: SyncedSettings;     // see below
  questionImages: Record<filename, { base64, mimeType }>;
  pdfManifest?: PdfManifestEntry[];   // PDFs go as separate gist files
  pregenManifest?: PregenManifestEntry[]; // WAV cache index (regenerate-only)
  installedPackages?: InstalledPackage[];
}
```

`SyncedSettings` is a **subset** of `AppSettings`:

```ts
{
  alias, importedPackIds, importHistory?, globalBankSyncedAt?,
  studyStreak?, lastStudyDate?, subjectGoals?,
  marketplacePasswords?,
}
```

**Not synced**: `aiSettings.openaiApiKey`, `aiSettings.anthropicApiKey`, `githubToken` itself, `syncGistId`, `lastSyncAt`, `orphanMigrationDone`, `fsaHandles`, the WAV cache, the Piper model cache.

### 9.2 PDF chunking

If the gzipped backup blob fits in one Gist file (<9 MB after JSON.stringify), it goes as `examcoach-backup.json`. Otherwise it's split into `examcoach-backup-000.json`, `examcoach-backup-001.json`, …, with an `examcoach-manifest.json` listing the chunks.

PDFs are exported as base64 in separate files. PDFs smaller than `PDF_CHUNK_LIMIT = 5 MB` are one file (`{key}.b64`); larger PDFs are split into 10-page parts with `pdf-lib` and reassembled on pull.

### 9.3 Merge strategy (pull)

`mergeBackup(backup)` performs **smart merge** with these identity keys:

| Entity | Identity for dedup | Conflict policy |
|---|---|---|
| Subject | `slugify(name)` | LWW (`updatedAt`) on non-local fields; `examDate` and `allowsNotes` always kept local |
| Topic | `slugify(subjectName)::slugify(title)` | LWW |
| Question | `contentHash` (re-computed remotely) | LWW on non-local fields; `notes`/`starred` preserved; `stats` merged taking max of `seen/correct/wrong` and most-recent `lastSeenAt` |
| KeyConcept | `contentHash` | LWW |
| Session | `id` | replace if remote has more answers or finished date |
| PdfAnchor | `id` (only remap subjectId) | additive |
| Exam | `id` | LWW |
| Deliverable | `id` | LWW |
| GradingConfig | `subjectId` | additive (only fill `examGrade` if local missing) |
| QuestionImage | `id` | additive |
| InstalledPackage | `id` | additive |
| Settings | partial-merge per field | union for arrays, max for streak, latest for dates |

ID-remap maps (`remoteId → localId`) flow through every step so foreign keys stay consistent. The map is exposed as `result._subjectIdMap` and reused by the PDF importer.

### 9.4 Auto-sync engine

`startAutoSync()` (called from `main.tsx`):
- Runs `autoSyncTick` immediately + every 5 minutes.
- On `visibilitychange === 'hidden'` it kicks `autoSyncPush`.
- Push hash short-circuit: it builds a quick `${qCount}-${sCount}-${dCount}-${kCount}-${lastStudyDate}` fingerprint and skips push if unchanged from the last successful push.
- Errors are swallowed silently — auto-sync never crashes the app.

---

## 10. Remote feed (static `global-bank.json` and GitHub Releases)

| Source | Where | Updated when |
|---|---|---|
| `src/data/global-bank.json` | bundled into the JS bundle (imported as a JSON module) | the developer commits a new snapshot |
| `https://api.github.com/repos/Mlgpigeon/SubjectPacks/releases` | network call from `packageRegistry.ts` | maintainer publishes a release; 5-min cache in `localStorage` |
| `https://examcoach-proxy.examcoach.workers.dev/{assetId}` | Cloudflare Worker reverse-proxy for downloads | CORS-only purpose |

`syncWithGlobalBank()` does an idempotent merge into IDB using `slugify`-based identity (same as the Gist merger). `installPackage` does a similar dedup but also imports the resources (`Temas/...`, `Examenes/...`, etc.) into `pdfResources`.

---

## 11. Caches and ephemeral memory

| Cache | Where | TTL |
|---|---|---|
| `extraInfoCache` | module-scoped `Map` in `resourceLoader.ts` | session lifetime |
| `pdfListCache` / `pdfMappingCache` | same | session lifetime |
| `cachedEngine` (WebLLM) | module scope in `webllmProvider.ts` | session lifetime |
| Service worker `precache` / `runtime` | vite-plugin-pwa | until a new SW activates |
| Vite dev server timestamped `vite.config.ts.timestamp*` | filesystem | cleared by the `clean` npm script before every dev/build |

---

## 12. What is NOT persisted

- WebLLM compiled engine (re-initialized per session, model itself is cached by the library).
- Speech-synthesis state of the Web Speech API (`window.speechSynthesis`) — it's ephemeral and re-played from the cached block list.
- The transient `dueToday` / `incompleteSessions` / `extraInfo` / `pendingCorrectionCount` maps computed on Dashboard.
- Anything inside React component state.
- `lastPushHash` in `gistSync.ts` (lives only in the module).

---

## 13. What you'd back up vs lose

If a user clears site data and has no Gist set up, they lose: every subject, question, session, key concept, exam, anchor, deliverable, the inline images, all settings, the FSA folder handle (PDF files on disk survive but the app no longer knows the folder).

If they have Gist sync configured: they lose nothing except `aiSettings.*Key`, `githubToken`, the WAV cache, and the Piper model — all of which are re-enterable / re-downloadable.

If they have an FSA folder configured: the actual PDF blobs are safe on disk regardless of browser-storage state. After re-pointing the app at the folder, they can be re-attached.

---

## 14. State transitions worth remembering

- **Creating a question** → `questionRepo.create` → adds to `db.questions` + Zustand `questions[]` → next render shows it. `contentHash` is computed at create time.
- **Answering a question** → `scoreAnswer` (sync) → `sessionRepo.addAnswer` (Dexie) → `questionRepo.updateStats` (Dexie + SM-2 recompute). `Zustand.currentSession` updates only when `setCurrentSession` is explicitly called by the page.
- **Finishing a session** → `sessionRepo.finish` sets `finishedAt`, updates `settings.studyStreak` and `lastStudyDate`.
- **Editing settings** → `useStore.updateSettings(partial)` → `saveSettings(partial)` (Dexie merge) → store re-set with merged value.
- **First load of `Dashboard`** → triggers `loadSubjects` + `loadSettings` + `migrateOrphanSubjects` + `assignMissingSubjectColors` + `repairOrphanRecords` + `syncGlobalBank()` (only if never run).
- **Auto-sync tick (5 min)** → `pullFromGist` (only if remote `updated_at > lastSyncAt`) → `pushToGist` (only if local data fingerprint changed).

---

## 15. ID space rules

- Every internal entity uses a **UUIDv4** generated with `uuid`.
- Cross-system identity is **always by slug** of the human-readable name:
  - subjects: `slugify(subject.name)`
  - topics: `slugify(subject.name)::slugify(topic.title)`
- Cross-system content identity is by **SHA-256**:
  - questions: `computeContentHash` of `type + normalized prompt + (options-and-correct OR modelAnswer OR clozeText+blanks)`. Order-independent for TEST options.
  - key concepts: SHA-256 of `category + normalizeText(title) + normalizeText(content)`.
- Marketplace package id: `slugify(name)` — e.g. `"ingenieria-del-software"`.
- Question images: `id = uuid (no extension)`, `filename = uuid.ext`. Markdown refs use the filename.
- WAV cache key: `${SHA-256(blockTexts)}:${voiceId}` (computed in `audioTtsEngine.hashBlockTexts`).

---

## 16. Hand-drawn picture

```
        ┌─────────────────────────────────────────────────────────────────┐
        │                       Browser tab                                │
        │                                                                 │
        │   React tree ◄──Zustand store──┐                                │
        │                                │                                 │
        │                      ┌─────────┴──────────┐                     │
        │                      │ repos (data/*.ts)  │                     │
        │                      └─────────┬──────────┘                     │
        │                                │                                 │
        │              ┌─────────────────┼─────────────────────┐          │
        │              ▼                 ▼                     ▼          │
        │      ┌──────────────┐  ┌──────────────┐    ┌──────────────────┐│
        │      │ IndexedDB    │  │ FSA / OPFS   │    │ localStorage     ││
        │      │ StudyAppDB   │  │ (PDF files)  │    │ (theme, caches)  ││
        │      │ audio-tts-…  │  │              │    │                  ││
        │      │ piper-cache  │  │              │    │                  ││
        │      └──────────────┘  └──────────────┘    └──────────────────┘│
        │                                                                 │
        └─────────────────────────────────────────────────────────────────┘
                              ▲                          ▲
                              │ gistSync (push/pull)     │ packageRegistry
                              ▼                          ▼
                       ┌──────────────┐           ┌──────────────────┐
                       │ GitHub Gist  │           │ GitHub Releases  │
                       │ (private)    │           │ (SubjectPacks)   │
                       └──────────────┘           └──────────────────┘
```

