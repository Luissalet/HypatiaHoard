"""src/domain/teacherCore.ts must compute exactly what hypatia/teacher/core.py does:
the same grade, versions, scores, feedback and analysis whether the teacher works in
the app or asks Faustus. Runs the real TypeScript with node (esbuild bundle)."""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from hypatia.teacher import core

ROOT = Path(__file__).resolve().parent.parent

NODE_SCRIPT = """
import * as c from '%s';
const input = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf-8'));
const out = {};
out.hash = input.strings.map((s) => c.hash32(s));
out.shuffle = input.strings.map((s) => c.seededShuffle(input.list, s));
out.grades = input.grades.map(([p, m, scale]) => [c.gradeFromPoints(p, m, scale), c.bandOf(c.gradeFromPoints(p, m, scale), scale)]);
out.versions = c.buildVersions(input.exam.id, input.exam.items.map((i) => i.questionId), input.questions, 3);
const exam = { ...input.exam, versions: out.versions };
out.keys = ['A', 'B', 'C'].map((l) => c.answerKey(exam, input.questions, l));
out.letters = input.letters.map(([raw, order]) => c.lettersToOptionIds(raw, order));
out.items = input.submissions.map((s) => c.itemPoints(exam, input.questions, s));
out.results = input.submissions.map((s) => c.submissionResult(exam, input.questions, s, input.scale));
out.feedback = input.submissions.map((s) => c.feedback(exam, input.questions, input.topics, input.concepts, s, input.rubrics));
out.rubric = input.selections.map((sel) => c.rubricBreakdown(input.rubrics.r1, sel, 2.5));
out.analysis = c.analyze(exam, input.questions, input.topics, input.submissions, input.rubrics, input.scale);
out.combined = c.combineTopics([out.analysis, out.analysis]);
out.roster = input.rosters.map((t) => c.parseRoster(t));
out.grid = input.grids.map((t) => c.parseAnswerGrid(t));
out.gridAnswers = c.gridAnswers(exam, input.questions, 'B', { 1: 'b', 2: 'x; y', 4: 'texto libre' });
out.csv = c.gradesCsv(input.csvRows);
console.log(JSON.stringify(out));
"""

QUESTIONS = {
    "q1": {"id": "q1", "type": "TEST", "topicId": "t1", "prompt": "Uno",
           "options": [{"id": "a", "text": "A"}, {"id": "b", "text": "B"}, {"id": "c", "text": "C"}, {"id": "d", "text": "D"}],
           "correctOptionIds": ["c"]},
    "q2": {"id": "q2", "type": "TEST", "topicId": "t1", "prompt": "Dos, varias",
           "options": [{"id": "x1", "text": "X"}, {"id": "x2", "text": "Y"}, {"id": "x3", "text": "Z"}],
           "correctOptionIds": ["x1", "x3"]},
    "q3": {"id": "q3", "type": "COMPLETAR", "topicId": "t2", "prompt": "Tres", "clozeText": "{{b1}} y {{b2}}",
           "blanks": [{"id": "b1", "accepted": ["Árbol", "arbol"]}, {"id": "b2", "accepted": ["río"]}]},
    "q4": {"id": "q4", "type": "DESARROLLO", "topicId": "t2", "prompt": "Cuatro " * 30, "modelAnswer": "Modelo"},
    "q5": {"id": "q5", "type": "PRACTICO", "topicId": "t3", "prompt": "Cinco", "numericAnswer": "42"},
}
RUBRICS = {"r1": {"id": "r1", "criteria": [
    {"id": "c1", "name": "Idea", "weight": 50, "levels": [{"id": "l0", "points": 0, "descriptor": "-"},
                                                         {"id": "l1", "points": 1.5, "descriptor": "-"},
                                                         {"id": "l2", "points": 3, "descriptor": "-"}]},
    {"id": "c2", "name": "Forma", "weight": 0, "levels": [{"id": "m0", "points": 0, "descriptor": "-"},
                                                         {"id": "m1", "points": 2, "descriptor": "-"}]},
    {"id": "c3", "name": "Cálculo", "weight": 30, "levels": [{"id": "n0", "points": 0, "descriptor": "-"},
                                                            {"id": "n1", "points": 1, "descriptor": "-"}]}]}}
EXAM = {"id": "exam-parity", "spec": {"testPenalty": 0.33},
        "items": [{"questionId": q, "points": p} for q, p in (("q1", 1), ("q2", 1.5), ("q3", 1), ("q4", 2.5), ("q5", 2))]}


def submissions():
    out = []
    answers = [({"q1": {"letters": "c"}, "q2": {"letters": "a,c"}, "q3": {"text": "arbol; RÍO"}}, "A"),
               ({"q1": {"letters": "b"}, "q2": {"letters": "a"}, "q3": {"blankAnswers": {"b1": "rama", "b2": "río"}}}, "B"),
               ({"q1": {"letters": ""}, "q2": {"letters": "zz"}, "q3": {"text": ""}}, "C"),
               ({"q1": {"letters": "1"}, "q2": {"selectedOptionIds": ["x1", "x3"]}}, "A")]
    for i, (ans, version) in enumerate(answers):
        decisions = {"q4": {"points": [2.5, 0.4, 1.0, 2.0][i], "rubricId": "r1", "comment": "Bien" if i == 3 else None,
                            "criteria": [{"criterionId": "c1", "points": [1.5, 0.2, 0.6, 1.4][i], "maxPoints": 1.56},
                                         {"criterionId": "c3", "points": 0.1, "maxPoints": 0.94}]}}
        if i != 2:
            decisions["q5"] = {"points": [2, 0, 1.25, 0.5][i]}
        out.append({"id": f"sub{i}", "version": version, "answers": ans, "decisions": decisions, "confirmed": i != 3})
    return out


def py_side(inp: dict) -> dict:
    out = {"hash": [core.hash32(s) for s in inp["strings"]],
           "shuffle": [core.seeded_shuffle(inp["list"], s) for s in inp["strings"]],
           "grades": [[core.grade_from_points(p, m, sc), core.band_of(core.grade_from_points(p, m, sc), sc)]
                      for p, m, sc in inp["grades"]]}
    exam = {**inp["exam"]}
    out["versions"] = core.build_versions(exam["id"], [i["questionId"] for i in exam["items"]], inp["questions"], 3)
    exam["versions"] = out["versions"]
    out["keys"] = [core.answer_key(exam, inp["questions"], label) for label in "ABC"]
    out["letters"] = [core.letters_to_option_ids(raw, order) for raw, order in inp["letters"]]
    out["items"] = [core.item_points(exam, inp["questions"], s) for s in inp["submissions"]]
    out["results"] = [core.submission_result(exam, inp["questions"], s, inp["scale"]) for s in inp["submissions"]]
    out["feedback"] = [core.feedback(exam, inp["questions"], inp["topics"], inp["concepts"], s, inp["rubrics"])
                       for s in inp["submissions"]]
    out["rubric"] = [core.rubric_breakdown(inp["rubrics"]["r1"], sel, 2.5) for sel in inp["selections"]]
    out["analysis"] = core.analyze(exam, inp["questions"], inp["topics"], inp["submissions"], inp["rubrics"], inp["scale"])
    out["analysis"].pop("examId")
    out["combined"] = core.combine_topics([out["analysis"], out["analysis"]])
    out["roster"] = [core.parse_roster(t) for t in inp["rosters"]]
    out["grid"] = [core.parse_answer_grid(t) for t in inp["grids"]]
    out["gridAnswers"] = core.grid_answers(exam, inp["questions"], "B", {1: "b", 2: "x; y", 4: "texto libre"})
    from hypatia.teacher.assess import grades_csv

    out["csv"] = grades_csv(inp["csvRows"])
    return out


def clean(value):
    """JSON round trip without null members (TS omits undefined, Python writes None)."""
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def test_typescript_twin_matches_python():
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "esbuild").is_dir():
        pytest.skip("node or esbuild missing")
    inp = {
        "strings": ["", "a", "exam-1:B:order", "ñandú 🎓", "Ελληνικά"],
        "list": list(range(12)),
        "grades": [[6.95, 10, None], [4.949, 10, None], [3, 4, None], [7.25, 9, None], [0, 0, None], [12, 10, None],
                   [5.555, 10, {"max": 10, "decimals": 2, "bands": [{"min": 0, "label": "No apto"}, {"min": 6, "label": "Apto"}]}],
                   [17, 20, {"max": 20, "decimals": 0, "bands": []}]],
        "exam": EXAM, "questions": QUESTIONS, "rubrics": RUBRICS, "submissions": submissions(),
        "letters": [["b", ["x", "y", "z"]], ["A, c", ["x", "y", "z"]], ["ca", ["x", "y", "z"]], ["3", ["x", "y", "z"]],
                    ["q", ["x", "y"]], [["a", "b"], ["x", "y"]], ["", ["x"]], ["a.) b)", ["x", "y"]]],
        "scale": None,
        "topics": {"t1": "Tema Uno", "t2": "Tema Dos", "t3": "Tema Tres"},
        "concepts": [{"id": "k2", "topicId": "t2", "title": "Beta", "category": "remark", "order": 0},
                     {"id": "k1", "topicId": "t2", "title": "Alfa", "category": "definition", "order": 3},
                     {"id": "k3", "topicId": "t3", "title": "Gamma", "category": "formula", "order": 1}],
        "selections": [{"c1": "l2", "c2": "m1", "c3": "n1"}, {"c1": "l1", "c2": "m0", "c3": "n0"}, {"c1": "l1"}, {}],
        "rosters": ["Alumna Uno\nAlumno Dos\nalumna uno", "Pérez Inventado, Ana\nGómez, Luis",
                    "Nombre;Apellidos;Correo\nAna;Ficticia;ana@example.invalid\n;;\nBea;Inventada;",
                    "alias\temail\nEstrella\testrella@example.invalid", "\n\n"],
        "grids": ["Alumno;Versión;1;2;3\nAna;b;c;a,c;x\n;A;b\nBea;;a", "Ana\tb\ta\n", "nombre,P1,P3\nAna,a,c"],
        "csvRows": [{"student": "Ana; con punto", "version": "A", "points": 7.25, "maxPoints": 10, "grade": 7.3,
                     "band": "Notable", "confirmed": True},
                    {"student": 'Bea "B"', "version": "B", "points": None, "maxPoints": 10, "grade": None, "band": None,
                     "confirmed": False}],
    }
    expected = py_side(json.loads(json.dumps(inp)))
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        entry = work / "entry.ts"
        entry.write_text(NODE_SCRIPT % (ROOT / "src" / "domain" / "teacherCore.ts").as_posix().replace("'", "\\'"), encoding="utf-8")
        (work / "input.json").write_text(json.dumps(inp, ensure_ascii=False), encoding="utf-8")
        bundle = work / "entry.cjs"
        build = ("require('esbuild').buildSync({entryPoints: [process.argv[1]], bundle: true, platform: 'node', "
                 "format: 'cjs', outfile: process.argv[2], logLevel: 'error'})")
        subprocess.run([node, "-e", build, str(entry), str(bundle)], check=True, cwd=ROOT)
        done = subprocess.run([node, str(bundle), str(work / "input.json")], check=True, capture_output=True, text=True,
                              encoding="utf-8")
    got = json.loads(done.stdout)
    got["analysis"].pop("examId", None)
    expected = clean(json.loads(json.dumps(expected)))
    got = clean(got)
    for key in expected:
        assert got[key] == expected[key], key
