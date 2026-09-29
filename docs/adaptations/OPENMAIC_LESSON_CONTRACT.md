# Tutor lesson contract v1 — 2026-09-29

The existing `tutor_turn` producer and notebook chat reader now expose a `lesson`
object. It contains `version: 1`, the chat ID, normalized tutor state and typed
actions. The SQLite message ledger remains the single source of truth: no second
copy of the lesson text is stored. Reopening a chat reconstructs the same IDs
without asking a model.

Each action has `id`, `kind`, `messageId`, `citationNumbers` and an optional
`targetId`. Kinds are `preguntar`, `responder`, `corregir`, `explicar`.
Answers reference the latest question, when one exists; corrections reference
the preceding student answer and carry its `assessment`. A message may both
explain and ask. Its text and source snapshots remain in `messages`, so consumers
resolve `messageId` there and citation numbers within that message only.

The producer already removes nonexistent numeric citations before persistence.
The reader validates citation numbers, source identities and duplicate message
IDs. It checks structural references, not the continued availability or truth of
the source: retained snippets still describe what was cited if a source changes.

Original unversioned `point`/`attempts` states migrate in memory to
`lessonVersion: 1`; the next successful tutor turn persists that version.
Unsupported versions and invalid state fail before model inference. Legacy
messages use the same stable projection, including existing assessment metadata.
The no-model path exposes the student's recorded action too.

## Scope and limits

This is a backend/API/MCP lesson contract integrated in existing flows. The PWA
continues to show the existing message transcript; it does not yet render an
editable action board. Questions are recognized by `?` in persisted assistant
text, and explanations by existing `explained` metadata. This does not claim
semantic detection of every pedagogical act, nor split one message into precise
text spans. No lesson import/export or arbitrary external actions are accepted.
The existing tutor still makes one inference normally and at most one additional
explanation call after repeated mistakes; the projection adds none.

## Reference and validation

Concept adapted independently from [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC):
separate versioned DSL contracts and deterministic reconstruction from a ledger.
Previously inspected upstream revision:
[`8f7d51e5`](https://github.com/THU-MAIC/OpenMAIC/tree/8f7d51e5ace35f0a23c1483447898791dedad2ba).
See its [whiteboard ledger](https://github.com/THU-MAIC/OpenMAIC/blob/8f7d51e5ace35f0a23c1483447898791dedad2ba/lib/orchestration/summarizers/whiteboard-ledger.ts).
No upstream code or dependencies were copied.

Regression coverage exercises a four-turn lesson, all four action types, stable
references after closing/reopening SQLite, legacy-state continuation, future
version rejection before inference and malformed source references on reopen.
