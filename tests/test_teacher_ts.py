"""TypeScript of the teacher role, run with node (esbuild bundle + fake-indexeddb):
the Dexie v8 -> v9 migration, the sync decisions, and that no export path of the app
(Gist backup, bank, global bank, exams, contribution pack, key concepts, compact
export) can carry student data, even with teacher tables full of it."""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def run_ts(script: str) -> dict:
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "esbuild").is_dir() or not (ROOT / "node_modules" / "fake-indexeddb").is_dir():
        pytest.skip("node, esbuild or fake-indexeddb missing")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        entry = work / "entry.ts"
        entry.write_text(script.replace("@ROOT@", ROOT.as_posix()), encoding="utf-8")
        bundle = work / "entry.mjs"
        build = (
            "require('esbuild').buildSync({entryPoints: [process.argv[1]], bundle: true, platform: 'node', format: 'esm', "
            "outfile: process.argv[2], logLevel: 'error', tsconfig: process.argv[3], nodePaths: [process.argv[4]], "
            "define: {'import.meta.env': JSON.stringify({BASE_URL: '/', VITE_HOARD: '0'})}, "
            "banner: {js: \"import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);\"}})"
        )
        subprocess.run([node, "-e", build, str(entry), str(bundle), str(ROOT / "tsconfig.json"),
                        str(ROOT / "node_modules")], check=True, cwd=ROOT)
        done = subprocess.run([node, str(bundle)], capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
        if done.returncode != 0:
            raise AssertionError(done.stderr[-3000:])
        return json.loads(done.stdout.strip().splitlines()[-1])


SHIMS = """
import 'fake-indexeddb/auto';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = globalThis.window || { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t) { this.type = t; } };
"""


def test_dexie_migration_v8_to_v9_keeps_data_and_seeds_the_scale():
    out = run_ts(SHIMS + """
import Dexie from 'dexie';
const old = new Dexie('StudyAppDB');
old.version(8).stores({
  subjects: 'id, name, examDate, createdAt', topics: 'id, subjectId, order, createdAt',
  questions: 'id, subjectId, topicId, type, difficulty, contentHash, createdAt', sessions: 'id, subjectId, mode, createdAt',
  pdfResources: 'id, subjectId, createdAt', pdfAnchors: 'id, subjectId, pdfId', settings: 'id',
  questionImages: 'id, filename, createdAt', deliverables: 'id, subjectId, type, dueDate, status, createdAt',
  gradingConfigs: 'id', keyConcepts: 'id, subjectId, category, order, contentHash, createdAt',
  exams: 'id, subjectId, createdAt', fsaHandles: 'key', installedPackages: 'id, subjectId, installedAt',
});
await old.subjects.put({ id: 's1', name: 'Ciencias Inventadas', createdAt: 'x', updatedAt: 'x' });
await old.exams.put({ id: 'e1', subjectId: 's1', name: 'Simulacro', questionIds: [], createdAt: 'x', updatedAt: 'x' });
old.close();
const { db } = await import('@ROOT@/src/data/db.ts');
await db.open();
const tables = db.tables.map((t) => t.name).sort();
const settings = await db.teacherSettings.get('default');
await db.teacherClasses.put({ id: 'c1', name: '2º B', subjectIds: ['s1'], createdAt: 'x', updatedAt: 'x' });
console.log(JSON.stringify({ verno: db.verno, tables, subject: (await db.subjects.get('s1')).name,
  exams: await db.exams.count(), scale: settings.scale, settingsAt: settings.updatedAt,
  classes: await db.teacherClasses.count() }));
""")
    assert out["verno"] == 9 and out["subject"] == "Ciencias Inventadas" and out["exams"] == 1
    for table in ("teacherClasses", "teacherStudents", "teacherExams", "rubrics", "gradingBatches", "submissions",
                  "gradingProposals", "teacherSettings"):
        assert table in out["tables"]
    assert [b["label"] for b in out["scale"]["bands"]] == ["Suspenso", "Aprobado", "Notable", "Sobresaliente"]
    assert out["settingsAt"] == "1970-01-01T00:00:00.000Z" and out["classes"] == 1


def test_no_export_carries_student_data():
    out = run_ts(SHIMS + """
const { db } = await import('@ROOT@/src/data/db.ts');
const { exportFullBackup } = await import('@ROOT@/src/data/gistSync.ts');
const { exportBank, exportGlobalBank, exportExams } = await import('@ROOT@/src/data/exportImport.ts');
const { exportContributionPack } = await import('@ROOT@/src/data/contributionImport.ts');
const { exportKeyConceptsPack } = await import('@ROOT@/src/data/keyConceptsImport.ts');
const { exportCompactSubject } = await import('@ROOT@/src/data/exportCompact.ts');
const { guardPublicExport, findStudentData, StudentDataLeak } = await import('@ROOT@/src/data/studentPrivacy.ts');
const { classRepo, studentRepo, batchRepo, submissionRepo } = await import('@ROOT@/src/data/teacherRepo.ts');
await db.subjects.put({ id: 's1', name: 'Ciencias Inventadas', createdAt: 'x', updatedAt: 'x' });
await db.topics.put({ id: 't1', subjectId: 's1', title: 'Tema', order: 0, createdAt: 'x', updatedAt: 'x' });
await db.questions.put({ id: 'q1', subjectId: 's1', topicId: 't1', type: 'TEST', prompt: '¿Uno?',
  options: [{ id: 'a', text: 'Sí' }, { id: 'b', text: 'No' }], correctOptionIds: ['a'], stats: { seen: 0, correct: 0, wrong: 0 },
  createdAt: 'x', updatedAt: 'x' });
await db.keyConcepts.put({ id: 'k1', subjectId: 's1', category: 'definition', title: 'Uno', content: 'x', order: 0, createdAt: 'x', updatedAt: 'x' });
await db.exams.put({ id: 'e1', subjectId: 's1', name: 'Parcial', questionIds: ['q1'], createdAt: 'x', updatedAt: 'x' });
const klass = await classRepo.create({ name: '4º D', course: 'Curso inventado', year: '2026-2027', subjectIds: ['s1'] });
await studentRepo.addMany(klass.id, [{ displayName: 'Zoe Inventadísima', email: 'zoe@example.invalid' }]);
const exam = { id: 'te1', subjectId: 's1', title: 'Parcial', status: 'draft', header: {}, spec: { subjectId: 's1', topicIds: [], counts: { TEST: 1 }, source: 'bank', versions: 1 },
  items: [{ questionId: 'q1', points: 1 }], versions: [], drafts: [], notes: [], createdAt: 'x', updatedAt: 'x' };
await db.teacherExams.put(exam);
const batch = await batchRepo.create(exam, klass);
const [sub] = await submissionRepo.byBatch(batch.id);
await submissionRepo.save({ ...sub, answers: { q1: { letters: 'a' } }, confirmed: true });
const payloads = {
  gist: await exportFullBackup(), bank: await exportBank(), global: await exportGlobalBank(), exams: await exportExams(['e1']),
  contribution: await exportContributionPack('Autor', 's1'), concepts: await exportKeyConceptsPack('s1'),
  compact: await exportCompactSubject('s1'),
};
const leaks = {};
for (const [k, v] of Object.entries(payloads)) {
  const text = JSON.stringify(v);
  leaks[k] = ['Zoe', 'Inventadísima', 'zoe@example', '4º D', 'studentId', 'teacherStudents', 'submissions'].filter((w) => text.includes(w));
}
let thrown = null;
try { guardPublicExport({ subjects: [], nested: { rows: [{ studentId: 'x' }] } }, 'prueba'); } catch (e) { thrown = e instanceof StudentDataLeak ? e.paths : String(e); }
const stripped = guardPublicExport({ subjects: [1], teacherStudents: [{ displayName: 'Zoe' }], submissions: [] }, 'prueba');
console.log(JSON.stringify({ leaks, thrown, stripped, sizes: Object.fromEntries(Object.entries(payloads).map(([k, v]) => [k, JSON.stringify(v).length])),
  found: findStudentData({ a: [{ b: { batchId: 1 } }] }) }));
""")
    assert all(v == [] for v in out["leaks"].values()), out["leaks"]
    assert all(size > 50 for size in out["sizes"].values())
    assert out["thrown"] == ["nested.rows[0].studentId"]
    assert out["stripped"] == {"subjects": [1]}
    assert out["found"] == ["a[0].b.batchId"]


def test_sync_rules():
    out = run_ts("""
import { decideRemote, remainingPending, parseDeletes, addDelete, parsePendingKey } from '@ROOT@/src/data/teacherSyncCore.ts';
const T1 = '2026-09-25T10:00:00.000Z', T2 = '2026-09-26T10:00:00.000Z';
console.log(JSON.stringify({
  newRemote: decideRemote(undefined, { updatedAt: T1, deleted: false }, false),
  newerRemote: decideRemote({ updatedAt: T1 }, { updatedAt: T2, deleted: false }, true),
  olderRemote: decideRemote({ updatedAt: T2 }, { updatedAt: T1, deleted: false }, false),
  pendingNewer: decideRemote({ updatedAt: T2 }, { updatedAt: T1, deleted: false }, true),
  sameTime: decideRemote({ updatedAt: T1 }, { updatedAt: T1, deleted: false }, false),
  remoteDelete: decideRemote({ updatedAt: T1 }, { updatedAt: T2, deleted: true }, false),
  deleteButLocalNewer: decideRemote({ updatedAt: T2 }, { updatedAt: T1, deleted: true }, true),
  deleteMissing: decideRemote(undefined, { updatedAt: T1, deleted: true }, false),
  remaining: remainingPending(['class:a', 'class:b', 'student:c', 'student:d'], { 'class:a': T1, 'class:b': T1, 'student:c': T1 },
    { 'class:a': T1, 'class:b': T2, 'student:c': T1, 'student:d': T1 }, [{ kind: 'student', id: 'c' }]),
  deletes: addDelete(parseDeletes('[{"kind":"class","id":"a","deletedAt":"x"},{"kind":"nope","id":"b"}]'), { kind: 'class', id: 'a', deletedAt: 'y' }),
  key: parsePendingKey('submission:abc::def'), bad: parsePendingKey('nope:1'),
}));
""")
    assert out["newRemote"] == "apply" and out["newerRemote"] == "apply" and out["olderRemote"] == "keep"
    assert out["pendingNewer"] == "keep" and out["sameTime"] == "apply" and out["remoteDelete"] == "delete"
    assert out["deleteButLocalNewer"] == "keep" and out["deleteMissing"] == "skip"
    assert out["remaining"] == ["class:b", "student:d"]
    assert out["deletes"] == [{"kind": "class", "id": "a", "deletedAt": "y"}]
    assert out["key"] == {"kind": "submission", "id": "abc::def"} and out["bad"] is None
