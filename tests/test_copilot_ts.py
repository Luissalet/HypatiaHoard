"""src/hoard-copilot-core.ts (run with node): the context the Faustus copilot gets from each view."""

import json

from test_teacher_ts import run_ts

SCRIPT = """
import { buildContext, emptyState, parseRoute, setEditor } from '@ROOT@/src/hoard-copilot-core';
const subjects = [{ id: 's1', name: 'Algebra', examDate: '2026-11-03' }, { id: 's2', name: 'Fisica' }];
const topics = [{ id: 't1', subjectId: 's1', title: 'Matrices' }, { id: 't2', subjectId: 's1', title: 'Grupos' }];
const deps = {
  subject: async (id) => subjects.find((s) => s.id === id),
  subjects: async () => subjects,
  topic: async (id) => topics.find((t) => t.id === id),
  topics: async (sid) => topics.filter((t) => t.subjectId === sid),
  questionCount: async (sid) => (sid === 's1' ? 12 : 0),
  question: async (id) => (id === 'q1' ? { id: 'q1', type: 'TEST', prompt: 'Cuanto es   2+2?' } : undefined),
  session: async (id) => (id === 'se1' ? { id: 'se1', subjectId: 's1', mode: 'random', questionIds: ['q1', 'q2'], answers: [{}] } : undefined),
  teacherExam: async (id) => (id === 'x1' ? { id: 'x1', title: 'Parcial', status: 'draft', items: [1, 2, 3], versions: [] } : undefined),
  batch: async (id) => (id === 'b1' ? { id: 'b1', examId: 'x1', title: 'Parcial 1A', status: 'open', students: ['secret'] } : undefined),
  sources: async (sid) => (sid === 'srv-s1' ? [{ id: 'src1', filename: 'tema1.pdf', status: 'ready', pages: 9 }] : []),
  serverId: async (kind, id) => (kind === 'subject' && id === 's1' ? 'srv-s1' : id),
};
const run = async (hash, state = emptyState()) => buildContext(parseRoute(hash), state, deps);
const failing = { ...deps, subject: async () => { throw new Error('db closed'); } };
const out = {
  routes: ['#/', '#/subject/s1', '#/subject/s1/notebook', '#/subject/s1/notebook?tab=studio', '#/subject/s1/read/t2', '#/practice/se1',
    '#/teacher?tab=entregas', '#/teacher/exam/x1', '#/teacher/batch/b1', '#/nonsense/1', ''].map((h) => parseRoute(h)),
  dashboard: await run('#/'),
  subject: await run('#/subject/s1'),
  subjectTab: await run('#/subject/s1', { ...emptyState(), subjectTab: 'questions', filterTopicId: 't2' }),
  notebook: await run('#/subject/s1/notebook?tab=studio'),
  read: await run('#/subject/s1/read/t1'),
  practice: await run('#/practice/se1', { ...emptyState(), questionId: 'q1', submitted: false }),
  exam: await run('#/teacher/exam/x1'),
  batch: await run('#/teacher/batch/b1'),
  missingSubject: await run('#/subject/nope'),
  missingSession: await run('#/practice/nope'),
  newView: await run('#/teacher/exam/new'),
  failing: await buildContext(parseRoute('#/subject/s1'), emptyState(), failing),
};
const st = emptyState();
setEditor(st, 'topic', { dirty: true, fields: { title: 'Nuevo' } });
setEditor(st, 'question', { dirty: true, fields: { prompt: 'p' } });
out.editor = await run('#/subject/s1', st);
setEditor(st, 'question', null);
out.editorAfterClose = await run('#/subject/s1', st);
console.log(JSON.stringify(out));
"""


def kinds(ctx):
    return [(o["kind"], o["object_id"]) for o in ctx["active_objects"]]


def test_each_view_returns_its_real_objects():
    out = run_ts(SCRIPT)
    assert [r["page"] for r in out["routes"]] == [
        "dashboard", "subject", "notebook", "notebook", "read", "practice", "teacher", "teacher-exam", "teacher-batch", "dashboard", "dashboard"]
    assert out["routes"][3]["tab"] == "studio" and out["routes"][2]["tab"] == "chat" and out["routes"][6]["tab"] == "entregas"

    dash = out["dashboard"]
    assert dash["active_objects"] == [] and "project" not in dash
    assert [s["id"] for s in dash["view"]["subjects"]] == ["srv-s1", "s2"]

    subject = out["subject"]
    assert subject["project"] == {"external_project_id": "srv-s1", "title": "Algebra", "kind": "subject"}
    assert subject["active_objects"][0] == {"kind": "subject", "object_id": "srv-s1", "title": "Algebra", "exam_date": "2026-11-03",
                                            "topics": 2, "questions": 12, "local_id": "s1"}

    tab = out["subjectTab"]
    assert kinds(tab) == [("subject", "srv-s1"), ("topic", "t2")] and tab["view"]["tab"] == "questions"

    assert kinds(out["notebook"]) == [("subject", "srv-s1"), ("source", "src1")] and out["notebook"]["view"]["tab"] == "studio"
    assert kinds(out["read"]) == [("subject", "srv-s1"), ("topic", "t1")]

    practice = out["practice"]
    assert kinds(practice) == [("subject", "srv-s1"), ("session", "se1"), ("question", "q1")]
    assert practice["active_objects"][2]["title"] == "Cuanto es 2+2?" and practice["active_objects"][1]["answered"] == 1
    assert practice["project"]["external_project_id"] == "srv-s1"

    assert kinds(out["exam"]) == [("teacher_exam", "x1")] and "project" not in out["exam"]
    batch = out["batch"]["active_objects"][0]
    assert batch["kind"] == "grading_batch" and "secret" not in json.dumps(out["batch"])


def test_unknown_ids_new_views_and_a_failing_read_give_no_object_and_never_throw():
    out = run_ts(SCRIPT)
    for key in ("missingSubject", "missingSession", "newView", "failing"):
        assert out[key]["active_objects"] == [], key
        assert "project" not in out[key], key


def test_unsaved_form_input_goes_to_view_editor_and_the_last_open_form_wins():
    out = run_ts(SCRIPT)
    assert out["editor"]["view"]["editor"] == {"kind": "question", "dirty": True, "fields": {"prompt": "p"}}
    assert out["editorAfterClose"]["view"]["editor"] == {"kind": "topic", "dirty": True, "fields": {"title": "Nuevo"}}
