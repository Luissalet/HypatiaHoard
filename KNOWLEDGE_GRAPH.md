# Exam Coach — KNOWLEDGE GRAPH (domain map)

Every entity the app reasons about, what it stores, how it relates to the others, and how identities and content equalities are computed.

Source of truth for all types: `src/domain/models.ts` (in places annotated below with `domain/models.ts` for clarity).

---

## 1. Entity catalog

### 1.1 Subject
`Subject` — `domain/models.ts`. Table `subjects`.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `name` | string | Human name — also the cross-system identity via `slugify(name)` |
| `color` | string? | Hex picked from a 10-color palette in `packageManager.ts#COLORS` |
| `icon` | string? | Optional emoji or URL |
| `examDate` | ISO YYYY-MM-DD? | **LOCAL ONLY** — never exported |
| `allowsNotes` | boolean? | Allowed cheat-sheet at exam. Overrides `extra_info.json`. |
| `createdAt` | ISO ts | |
| `updatedAt` | ISO ts | |

### 1.2 Topic
`Topic`. Table `topics`.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `subjectId` | uuid → Subject.id | |
| `title` | string | Cross-system identity: `slugify(subjectName)::slugify(title)` |
| `order` | number | Order inside the subject (0-indexed) |
| `tags` | string[]? | |
| `pdfFilename` | string? | Points to `resources/[slug]/Temas/[filename].pdf` |
| `createdAt` / `updatedAt` | ISO ts | |

### 1.3 Question
`Question`. Table `questions`.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `subjectId` | uuid → Subject.id | |
| `topicId` | uuid → Topic.id | The primary topic |
| `topicIds` | uuid[]? | All topics if the question spans more than one (includes `topicId`) |
| `type` | `'TEST' \| 'DESARROLLO' \| 'COMPLETAR' \| 'PRACTICO'` | |
| `prompt` | string (Markdown + LaTeX) | The text shown to the student |
| `explanation` | string? | Markdown+LaTeX after-the-fact explanation |
| `difficulty` | 1..5? | |
| `tags` | string[]? | |
| `origin` | `'test' \| 'examen_anterior' \| 'clase' \| 'alumno'`? | How the question was sourced |
| `options` | `QuestionOption[]?` | TEST only |
| `correctOptionIds` | string[]? | TEST only — IDs from `options` |
| `modelAnswer` | string? | DESARROLLO / PRACTICO |
| `keywords` | string[]? | DESARROLLO / PRACTICO — highlights in free text |
| `numericAnswer` | string? | PRACTICO |
| `clozeText` | string? | COMPLETAR — text with `{{blankId}}` markers |
| `blanks` | `ClozeBlank[]?` | COMPLETAR — `{id, accepted: string[]}` |
| `pdfAnchorId` | uuid → PdfAnchor.id? | "Open at page X" link |
| `imageDataUrls` | string[]? | **DEPRECATED** — pre-IDB inline images. New images go via `question-images/uuid.ext` in Markdown |
| `createdBy` | string? | Alias of author |
| `sourcePackId` | string? | Contribution pack origin (cleared by "Commit & clean") |
| `contentHash` | string | SHA-256 — see §3 |
| `notes` | string? | **LOCAL ONLY** — personal annotation |
| `starred` | boolean? | **LOCAL ONLY** — "difficult" flag |
| `stats` | `QuestionStats` | See §1.4 |
| `createdAt` / `updatedAt` | ISO ts | |

### 1.4 QuestionStats (embedded in Question)
Tracks SM-2 spaced-repetition state plus aggregate counters.

```ts
{
  seen, correct, wrong,
  lastSeenAt?, lastResult?,
  easeFactor?, interval?, nextReviewAt?, repetitions?
}
```
Updated by `questionRepo.updateStats(id, 'CORRECT'|'WRONG')` which calls `calcNextReview` (SM-2 with initial `easeFactor = 2.5`, minimum `1.3`, schedule `1 → 6 → round(prev * EF)` days).

### 1.5 QuestionOption / ClozeBlank
Plain shapes embedded in `Question`:
```ts
QuestionOption = { id: string; text: string }
ClozeBlank    = { id: string; accepted: string[] }
```

### 1.6 QuestionImageRecord
Table `questionImages`. Stores the inline images referenced as `question-images/uuid.ext` in any Markdown field.

```ts
{ id: uuid, filename: 'uuid.ext', blob: Blob, mimeType, createdAt }
```

### 1.7 PracticeSession
Table `sessions`.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `subjectId` | uuid → Subject.id | Primary subject (for indexing) |
| `subjectIds` | uuid[]? | Set when the session spans multiple subjects |
| `mode` | `SessionMode` | `'random' \| 'all' \| 'failed' \| 'topic' \| 'smart' \| 'exam'` |
| `topicId` | uuid? | When `mode === 'topic'` |
| `questionIds` | uuid[] | Ordered |
| `answers` | `UserAnswer[]` | Embedded |
| `createdAt` | ISO ts | |
| `finishedAt` | ISO ts? | Empty → "incomplete" → shown in `ActiveSessionsSidebar` |

### 1.8 UserAnswer (embedded)
```ts
{
  questionId,
  selectedOptionIds?,        // TEST
  freeText?,                 // DESARROLLO / PRACTICO
  blankAnswers?,             // COMPLETAR
  manualResult?,             // DESARROLLO override after grading
  result?,                   // 'CORRECT' | 'WRONG' | null (null = unscored DESARROLLO)
  answeredAt,
}
```

### 1.9 KeyConcept
Table `keyConcepts`. Three categories: `'formula' | 'definition' | 'remark'`.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `subjectId` | uuid → Subject.id | |
| `topicId` | uuid → Topic.id? | Optional link |
| `category` | enum | as above |
| `title` | string | |
| `content` | string (Markdown + LaTeX) | |
| `tags` | string[]? | |
| `order` | number | Order within category for that subject |
| `createdBy`, `sourcePackId`, `contentHash` | | Same semantics as Question |
| `createdAt` / `updatedAt` | | |

### 1.10 Exam (curated set)
Table `exams`.

```ts
{ id, subjectId, name, description?, questionIds: string[], createdAt, updatedAt }
```

### 1.11 PdfResource
Table `pdfResources` — fallback PDF / DOCX / XLSX / IPYNB blobs that aren't on disk.

```ts
{ id, subjectId, filename, mime, blob: Blob, createdAt }
```
`filename` may be `"Tema_1.pdf"` (Temas) or `"Examenes/foo.pdf"` (categorized resources).

### 1.12 PdfAnchor
Table `pdfAnchors`. Lets a question pin to a precise PDF page.

```ts
{ id, subjectId, pdfId, page, bbox?: { x, y, w, h }, label? }
```

### 1.13 Deliverable & SubjectGradingConfig (continuous evaluation)
Tables `deliverables` and `gradingConfigs`.

```ts
Deliverable = {
  id, subjectId, name,
  type: 'activity' | 'test' | 'exam' | 'otro',
  startDate?, dueDate?, dueTime?,
  status: 'pending' | 'in_progress' | 'done' | 'submitted',
  grade?,                       // 0-10 (activities, optionally tests)
  continuousPoints: number,     // raw weight this deliverable contributes
  createdAt, updatedAt,
}

SubjectGradingConfig = {
  id: subjectId,                // ← same UUID as the Subject
  continuousWeight: number,     // e.g. 0.4
  maxContinuousPoints: number,  // e.g. 10
  testContinuousPoints: number, // default for new test deliverables
  examGrade?: number,           // 0-10 when known
}
```
Grade math: `domain/grading.ts#calcGradeBreakdown` returns `{ rawContinuous, cappedContinuous, continuousContribution, examContribution, finalGrade, remainingPotential, bestCaseGrade }`.

### 1.14 SubjectExtraInfo / ExternalLink / GptLink
Live in static `resources/[slug]/extra_info.json`, fetched by `data/resourceLoader.ts`.

```ts
SubjectExtraInfo = {
  allowsNotes?, professor?, credits?, description?,
  pdfs?: string[],                          // legacy list of PDFs in Temas/
  externalLinks?: ExternalLink[],           // {name, url, icon?}
  gptLinks?: GptLink[],                     // {name, url, description?}
}
```

### 1.15 PackageManifest / SubjectBank / InstalledPackage / RegistryEntry
The marketplace world.

```ts
PackageManifest = {
  formatVersion: 1, id: slug, name, version,        // semver
  description?, authors?, university?, degree?, year?,
  credits?, professor?, allowsNotes?,
  createdAt, updatedAt,
  stats: { questions, topics, exams, keyConcepts },
  minAppVersion?, gptLinks?, externalLinks?,
}

SubjectBank = {                       // bank.json inside a .examcoach.zip
  formatVersion: 1, subject: slug,
  topics, questions, keyConcepts?, exams?, pdfAnchors?,
}

InstalledPackage = {                  // local tracking row
  id: slug, subjectId, version, name, installedAt, manifest,
}

RegistryEntry = {                     // GitHub Releases listing
  id: slug, manifest, downloadUrl, size?, publishedAt, encrypted?,
}
```

### 1.16 Pack formats (exports)

```ts
BankExport         = { version:1, kind:'bank',
                       subjects, topics, questions, pdfAnchors, keyConcepts? }

ExamExport         = { version:1, kind:'exams', exams, questions }   // questions is the union referenced by the exams

ContributionPack   = { version:1, kind:'contribution',
                       packId, createdBy, exportedAt,
                       targets: { subjectKey, subjectName, topics:[{topicKey, topicTitle}] }[],
                       questions: ContributionQuestion[],
                       questionImages?: Record<filename, base64> }

KeyConceptsPack    = { version:1, kind:'keyconcepts',
                       packId, createdBy, exportedAt,
                       subjectKey, subjectName,
                       topics?: { topicKey, topicTitle }[],
                       concepts: KeyConceptExport[] }

FullBackup         = (gistSync.ts, version: 2)  -- see MEMORY_MODEL.md §9
```

### 1.17 AppSettings, AISettings, ImportHistoryEntry
See MEMORY_MODEL.md §2.7.

---

## 2. Relationships (cardinalities)

```
                       Subject (1) ──────────────────────────────────────┐
                       │                                                  │
                       ├──< Topic (N) ────< Question (N) ──> PdfAnchor    │
                       │                       │                          │
                       │                       └─< QuestionImageRecord    │
                       │                                                  │
                       ├──< KeyConcept (N)                                │
                       ├──< Exam (N) ──── questionIds (string[])          │
                       ├──< PracticeSession (N) ── questionIds, answers   │
                       ├──< PdfResource (N)                               │
                       ├──< PdfAnchor (N)                                 │
                       ├──< Deliverable (N)                               │
                       └──< SubjectGradingConfig (1, id = subjectId)      │
                                                                          │
                                                                          ▼
                            InstalledPackage ── subjectId ────────────────┘
```

| From | To | Cardinality | Foreign key | Cascade on delete |
|---|---|---|---|---|
| Subject | Topic | 1 — N | `Topic.subjectId` | Yes (subjectRepo.delete) |
| Subject | Question | 1 — N | `Question.subjectId` | Yes |
| Subject | KeyConcept | 1 — N | `KeyConcept.subjectId` | Yes |
| Subject | Exam | 1 — N | `Exam.subjectId` | Yes (via uninstallPackage; subjectRepo doesn't cascade exams!) |
| Subject | PracticeSession | 1 — N | `PracticeSession.subjectId` (or member of `subjectIds`) | Yes |
| Subject | PdfResource | 1 — N | `PdfResource.subjectId` | Yes |
| Subject | PdfAnchor | 1 — N | `PdfAnchor.subjectId` | Yes |
| Subject | Deliverable | 1 — N | `Deliverable.subjectId` | Only via uninstallPackage |
| Subject | SubjectGradingConfig | 1 — 1 | `id = subjectId` | Only via uninstallPackage |
| Subject | InstalledPackage | 0..1 — 1 | `InstalledPackage.subjectId` | Manual (uninstallPackage) |
| Topic | Question | 1 — N | `Question.topicId` (and optional `Question.topicIds`) | Yes (topicRepo.delete) |
| Topic | KeyConcept | 0..1 — N | `KeyConcept.topicId?` | None |
| Question | PdfAnchor | N — 0..1 | `Question.pdfAnchorId?` | None |
| Question | QuestionImageRecord | N — 0..N | matched by Markdown ref `question-images/uuid.ext` (not FK) | Not enforced |
| Exam | Question | N — N | `Exam.questionIds[]` | Not enforced |
| PracticeSession | Question | N — N | `PracticeSession.questionIds[]` and `answers[].questionId` | sessions get pruned by `removeDuplicateQuestions` |
| PdfAnchor | PdfResource | N — 1 | `PdfAnchor.pdfId` (free-form string) | None |
| ContributionPack | Question | 1 — N | `ContributionPack.questions[]` materialised into `Question.sourcePackId` | Reversible via `undoContributionImport` |
| InstalledPackage | (every subject-scoped table) | 1 — N | indirect via `subjectId` | `uninstallPackage` cascades all |

> **Gotchas**
> - `Exam.questionIds` and `PracticeSession.questionIds[]` are **not** enforced foreign keys. They're free-form arrays. `importExams` matches them through `contentHash` to local question IDs; if a question disappears (e.g. dedup), `removeDuplicateQuestions` patches sessions but not exams.
> - `subjectRepo.delete` does **not** cascade exams or deliverables — those only get cleaned up via `uninstallPackage`. Repair logic exists in `repairOrphanRecords` for this case.

---

## 3. Identity vs content hash

The app distinguishes three kinds of equality:

1. **Identity by UUID** — `id` is the local primary key. Only meaningful within one device.
2. **Identity by slug** — used to merge entities across devices and packs. The slug is computed by `slugify(name)` (`domain/normalize.ts`): NFD-decompose → strip diacritics → lowercase → keep `[a-z0-9 -]` → trim → spaces / runs-of-`-` → single `-`.
3. **Identity by content hash** — used to deduplicate the actual semantic content.

### 3.1 Question content hash
`computeContentHash(q)` (`domain/hashing.ts`) returns `"sha256:" + hex(SHA-256(raw))` where `raw` joins, by `::`:
- `q.type`
- `normalizeText(q.prompt)` (`normalizeText` = trim + lowercase + collapse whitespace + strip diacritics)
- TEST: sorted normalised option texts joined `|`; sorted normalised texts of *correct* options joined `|`. **Order-independent.** **ID-scheme-independent.** Correctness is resolved through option *text*, not option *id*.
- DESARROLLO / PRACTICO: `normalizeText(modelAnswer ?? '')`.
- COMPLETAR: `normalizeText(clozeText ?? '')` + for each blank `accepted.map(normalize).sort().join(',')`, blanks joined `|`.

Notes:
- `topicKey` is **intentionally excluded** so the same question filed under slightly different topics still dedups.
- Old hashes (which included topicKey or raw IDs) are silently re-computed during global-bank sync, contribution import, Gist merge, and `removeDuplicateQuestions`.

### 3.2 KeyConcept content hash
`SHA-256` of `category + normalizeText(title) + normalizeText(content)` (separate function from Question hash, defined inside `repos.ts#computeConceptHash` and again in `keyConceptsImport.ts#computeConceptHashForImport`).

### 3.3 PdfAnchor identity
Not hashed. Composite key for dedup: `${subjectId}::${pdfId}::${page}::${label ?? ''}` (`globalBank.ts`, `packageManager.ts`).

### 3.4 Subject and Topic identity
- Subject identity for merges: `slugify(name)`.
- Topic identity for merges: `slugify(subjectName) + "::" + slugify(title)`.

---

## 4. Schema diagram (ASCII)

```
                          ┌────────────────────────┐
                          │       Subject          │
                          │  id  (uuid, PK)        │
                          │  name (slugify→key)    │
                          │  examDate  (LOCAL)     │
                          │  color, icon, allowsNotes
                          └──────────┬─────────────┘
                                     │ 1
            ┌────────────────────────┼─────────────────────────┐
            │ N                      │ N                       │ N
            ▼                        ▼                         ▼
  ┌─────────────────┐     ┌────────────────────┐    ┌────────────────────┐
  │     Topic       │     │     KeyConcept     │    │   PracticeSession  │
  │ id (uuid)       │     │ id, subjectId      │    │ id, subjectId      │
  │ subjectId  FK   │     │ topicId? FK        │    │ subjectIds? FK[]   │
  │ title (slug→key)│     │ category           │    │ mode               │
  │ order           │     │ contentHash        │    │ questionIds[]      │
  │ pdfFilename?    │     └────────────────────┘    │ answers[]          │
  └──────┬──────────┘                                └──────────┬─────────┘
         │ 1                                                   │ N
         │                                                     │ refers to
         │ N                                                   │
         ▼                                                     ▼
  ┌─────────────────────────────┐                  ┌──────────────────────┐
  │         Question            │◄─────  N  N  ───►│         Exam          │
  │ id, subjectId, topicId      │ via              │ id, subjectId         │
  │ topicIds[]?                 │ Exam.questionIds │ questionIds[]         │
  │ type, prompt, options, etc. │ /Session.questionIds              
  │ pdfAnchorId? ──┐            │                  └──────────────────────┘
  │ contentHash    │            │
  │ stats {SM-2}   │            │
  │ notes (LOCAL)  │            │
  │ starred(LOCAL) │            │
  │ sourcePackId?  │            │
  └────────┬───────┘            │
           │ 0..1               │
           ▼                    │
   ┌─────────────────┐          │
   │   PdfAnchor     │──N── pdfId ──►  PdfResource(filename) ── (also in FSA/OPFS folder)
   │ subjectId, page │
   │ bbox?, label?   │
   └─────────────────┘

   ┌────────────────────────┐       ┌────────────────────────┐
   │     Deliverable        │       │  SubjectGradingConfig  │
   │ id, subjectId          │       │  id  === subjectId     │
   │ type, status, grade?   │       │  continuousWeight,…    │
   │ continuousPoints       │       │  examGrade?            │
   └────────────────────────┘       └────────────────────────┘

   ┌────────────────────────┐
   │   InstalledPackage     │  ──── manages a Subject + bank.json contents
   │  id = slug             │       (cascades on uninstall)
   │  subjectId, version    │
   │  manifest              │
   └────────────────────────┘

   QuestionImageRecord ── matched by Markdown ref "question-images/uuid.ext"
                          in Question.{prompt,explanation,modelAnswer,clozeText}
                          and KeyConcept.content
```

---

## 5. Question-type matrix

| Type | Required fields | Auto-score | Manual-score | Hash inputs |
|---|---|---|---|---|
| `TEST` | `options`, `correctOptionIds` | `scoreTest` — set equality | n/a | type + prompt + sorted option texts + sorted correct-option texts |
| `COMPLETAR` | `clozeText` (with `{{blankId}}`), `blanks` | `scoreCompletar` — per-blank normalized-text match | optional override via `manualResult` | type + prompt + clozeText + per-blank `accepted.sort().join(',')` joined `|` |
| `DESARROLLO` | `modelAnswer?`, `keywords?` | none — returns `null` until user marks | `UserAnswer.manualResult` set in Results page | type + prompt + modelAnswer |
| `PRACTICO` | `modelAnswer?`, `numericAnswer?`, `keywords?` | none — same as DESARROLLO | same | type + prompt + modelAnswer |

`scoreAnswer(q, a)` is the single entry point (`domain/scoring.ts`). `keywordMatchCount(q, freeText)` is a UX hint that counts how many keywords appear (post-normalisation) in the answer.

---

## 6. SessionMode matrix

| Mode | Used by | Behaviour |
|---|---|---|
| `random` | SubjectView, GlobalPractice | Sample N from the subject(s) |
| `all` | SubjectView | Every question, original order |
| `failed` | SubjectView, GlobalPractice | `stats.lastResult === 'WRONG'` |
| `topic` | SubjectView | All questions in a topic |
| `smart` | SubjectView, GlobalPractice | `sortByPriority` from `domain/spacedRepetition.ts` — overdue first, then by `nextReviewAt` |
| `exam` | SubjectView ExamsTab | Timed simulation (`?examMode=true&duration=N`); uses an `Exam`'s `questionIds[]` |

---

## 7. Origin tag matrix

`origin?` on `Question` and `ContributionQuestion`:

| Value | Meaning |
|---|---|
| `test` | From a practice test |
| `examen_anterior` | From a real past exam |
| `clase` | Posed during class |
| `alumno` | Authored by a student / AI under "alumno" alias |

UI color mapping (`SubjectView.tsx`): `test → amber`, `examen_anterior → rose`, `clase → blue`, `alumno → sage`.

---

## 8. KeyConcept category matrix

| Category | Icon | UI badge color | Sidebar header |
|---|---|---|---|
| `formula` | 📐 | blue | Fórmulas |
| `definition` | 📚 | sage | Definiciones |
| `remark` | ⚠️ | amber | Observaciones |

Order is per-category-per-subject (`order` field) and shown grouped in `KeyConceptsTab` / `KeyConceptsSidebar`.

---

## 9. Cross-system slug rules (the contract)

These rules are **contractual** because they're how Exam Coach decides whether two records refer to "the same thing" across packages, devices and bundled banks:

1. `subjectKey = slugify(subject.name)`.
2. `topicKey = slugify(topic.title)`, namespaced inside its subject: `${subjectKey}::${topicKey}` for global identity.
3. Contribution packs **must** copy slugs literally — the contribution guide enforces this in plain Spanish at the top of every prompt.
4. Package manifest `id` is the `subjectKey`. So installing two different `.zip`s with the same subject slug overwrites the same `InstalledPackage` row.
5. Slugs are case-insensitive, accent-insensitive, hyphen-collapsing.

---

## 10. The "no-overwrite" rule (local data)

When merging anything (global-bank sync, Gist pull, contribution import, package install), these fields **never** get overwritten by remote data:

- `Subject.examDate`
- `Subject.allowsNotes`
- `Question.notes`
- `Question.starred`
- `Question.stats` (merged taking max of `seen/correct/wrong` and the most recent `lastSeenAt`; SRS fields take whoever has more repetitions)
- All `AppSettings.aiSettings.*Key`, `githubToken`, `syncGistId`, `lastSyncAt`, `orphanMigrationDone`

This is why the merge logic re-maps remote IDs to local ones rather than overwriting whole rows.

---

## 11. Worked example — installing a marketplace pack

Suppose the user installs `ingenieria-del-software.examcoach.zip` and they already have a hand-made subject "Ingeniería del Software" with 5 questions in IndexedDB.

1. `installPackage(zip)` opens the ZIP and parses `manifest.json` (`PackageManifest`) and `bank.json` (`SubjectBank`).
2. `allSubjects.find(s => slugify(s.name) === manifest.id)` finds the existing local subject by slug → its `id` is reused.
3. For each `Topic` in `bank.topics`: look up by `slugify(title)` in the local topics for that subject. If found, update `order` / `tags` / `pdfFilename`. Otherwise create a new local UUID. Build `topicIdMap: bankTopicId → localTopicId`.
4. For each `PdfAnchor`: composite-key dedup `(subjectId, pdfId, page, label)`; build `anchorIdMap`.
5. For each `Question`: re-compute `contentHash` with the current algorithm; if already present locally, skip; else insert with `subjectId = local`, `topicId = topicIdMap.get(...)`, `pdfAnchorId = anchorIdMap.get(...)`, `stats: {0,0,0}`.
6. For each `KeyConcept`: same pattern but dedup by `contentHash`.
7. For each `Exam`: dedup by `name`; note that `questionIds` aren't remapped at this point — see "Gotchas" in §2.
8. Resources (PDFs / DOCX / IPYNB / etc.): for `Temas/foo.pdf` save filename `foo.pdf`; for `Examenes/foo.pdf` save with the prefix.
9. `installedPackages.put({id: manifest.id, subjectId, version, ...})`.

The result: the local subject is augmented with the pack's content; the user's previous questions, stats, notes, exam dates and starred items survive untouched.

---

## 12. Worked example — content hash for a TEST question

Given:
```json
{
  "type": "TEST",
  "prompt": "  ¿Cuál es la CAPITAL de FRANCIA?  ",
  "options": [
    { "id": "x", "text": "Madrid" },
    { "id": "y", "text": "París " },
    { "id": "z", "text": "Roma" }
  ],
  "correctOptionIds": ["y"]
}
```

`computeContentHash`:
1. `q.type = "TEST"`.
2. `normalizeText(q.prompt)` → `"¿cual es la capital de francia?"` (lowercase + collapse whitespace + strip diacritics).
3. `optionTexts = ["madrid", "paris", "roma"].sort().join('|')` → `"madrid|paris|roma"`.
4. `correctTexts = ["paris"].sort().join('|')` → `"paris"`.
5. `raw = "TEST::¿cual es la capital de francia?::madrid|paris|roma::paris"`.
6. `SHA-256(raw)` → `"sha256:..."`.

So renaming the option ids (e.g. `a/b/c` instead of `x/y/z`) or shuffling the options keeps the same hash — perfect for dedup across packs that use different ID schemes.

---

## 13. Quick reference — where each thing is computed

| Concept | Module |
|---|---|
| `slugify` | `domain/normalize.ts` |
| `normalizeText` | `domain/normalize.ts` |
| `computeContentHash` (questions) | `domain/hashing.ts` |
| KeyConcept hash | `data/repos.ts#computeConceptHash` (live) + `data/keyConceptsImport.ts#computeConceptHashForImport` (import path) |
| SM-2 (`calcNextReview`, `sortByPriority`) | `domain/spacedRepetition.ts` |
| Auto-score | `domain/scoring.ts` |
| Grade breakdown | `domain/grading.ts` |
| Cascade deletes | `data/repos.ts#subjectRepo.delete`, `topicRepo.delete`, and `data/packageManager.ts#uninstallPackage` |
| Orphan repair | `data/packageManager.ts#repairOrphanRecords` |
| Merge (global bank) | `data/globalBank.ts#mergeGlobalBank` |
| Merge (Gist pull) | `data/gistSync.ts#mergeBackup` + helpers |

---

## 14. Invariants

These should always hold if the code is correct:

- Every `Question.topicId` points to an existing `Topic` under the same `subjectId`. (`repairOrphanRecords` heals violations.)
- Every entry in `Question.topicIds` belongs to the same subject as `Question.subjectId`.
- A `Question` has `contentHash` non-null after creation (set by `questionRepo.create`).
- `KeyConcept.contentHash` is recomputed any time `category` / `title` / `content` change (`keyConceptRepo.update`).
- For TEST questions, every `correctOptionIds` element exists inside `options[].id`.
- For COMPLETAR questions, every `{{blankId}}` in `clozeText` matches a `blanks[].id`.
- `Exam.questionIds` only references existing `Question.id`s (only enforced opportunistically by `removeDuplicateQuestions`).
- `SubjectGradingConfig.id === Subject.id`.
- For multi-subject sessions, `PracticeSession.subjectIds` contains `PracticeSession.subjectId`.
- `Topic.order` is unique within a subject (enforced by `getNextOrder`, not by Dexie).

