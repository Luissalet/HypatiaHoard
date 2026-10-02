"""Pure teacher logic: grade scale, seeded versions, objective scoring, rubrics,
parsers, feedback and class analysis (invented data only)."""

from hypatia.teacher import core

Q_TEST = {"id": "q1", "type": "TEST", "topicId": "t1", "prompt": "¿Color del cielo inventado?",
          "options": [{"id": "a", "text": "Verde"}, {"id": "b", "text": "Azul"}, {"id": "c", "text": "Rojo"},
                      {"id": "d", "text": "Gris"}], "correctOptionIds": ["b"]}
Q_MULTI = {"id": "q2", "type": "TEST", "topicId": "t2", "prompt": "Elige las pares",
           "options": [{"id": "a", "text": "2"}, {"id": "b", "text": "3"}, {"id": "c", "text": "4"}],
           "correctOptionIds": ["a", "c"]}
Q_CLOZE = {"id": "q3", "type": "COMPLETAR", "topicId": "t1", "prompt": "Completa", "clozeText": "El {{b1}} y la {{b2}}",
           "blanks": [{"id": "b1", "accepted": ["sol"]}, {"id": "b2", "accepted": ["luna", "lúnula"]}]}
Q_OPEN = {"id": "q4", "type": "DESARROLLO", "topicId": "t2", "prompt": "Explica la fotosíntesis inventada.",
          "modelAnswer": "Luz, agua y dióxido.", "keywords": ["luz", "agua"]}
QUESTIONS = {q["id"]: q for q in (Q_TEST, Q_MULTI, Q_CLOZE, Q_OPEN)}
RUBRIC = {"id": "r1", "criteria": [
    {"id": "c1", "name": "Contenido", "weight": 60, "levels": [{"id": "c1l0", "descriptor": "Nada", "points": 0},
                                                             {"id": "c1l1", "descriptor": "Algo", "points": 1},
                                                             {"id": "c1l2", "descriptor": "Todo", "points": 2}]},
    {"id": "c2", "name": "Claridad", "weight": 40, "levels": [{"id": "c2l0", "descriptor": "Confusa", "points": 0},
                                                            {"id": "c2l1", "descriptor": "Clara", "points": 1}]}]}


def exam(versions=2, penalty=0):
    ids = list(QUESTIONS)
    e = {"id": "exam-1", "subjectId": "s1", "spec": {"testPenalty": penalty},
         "items": [{"questionId": "q1", "points": 1}, {"questionId": "q2", "points": 1},
                   {"questionId": "q3", "points": 1}, {"questionId": "q4", "points": 2, "rubricId": "r1"}]}
    e["versions"] = core.build_versions(e["id"], ids, QUESTIONS, versions)
    return e


def test_scale_rounding_and_bands():
    assert core.grade_from_points(6.95, 10) == 7.0  # half up, one decimal
    assert core.grade_from_points(4.94, 10) == 4.9
    assert core.grade_from_points(3, 4) == 7.5
    assert core.grade_from_points(5, 0) is None
    assert [core.band_of(g) for g in (0, 4.9, 5, 6.9, 7, 8.9, 9, 10)] == [
        "Suspenso", "Suspenso", "Aprobado", "Aprobado", "Notable", "Notable", "Sobresaliente", "Sobresaliente"]
    custom = {"max": 10, "decimals": 2, "bands": [{"min": 0, "label": "No apto"}, {"min": 6, "label": "Apto"}]}
    assert core.grade_from_points(5.555, 10, custom) == 5.56 and core.band_of(5.99, custom) == "No apto"
    assert core.normalize_scale({"bands": []})["bands"][0]["label"] == "Suspenso"


def test_versions_are_seeded_permutations():
    e = exam()
    a, b = e["versions"]
    assert a["label"] == "A" and a["questionOrder"] == list(QUESTIONS)
    assert sorted(b["questionOrder"]) == sorted(QUESTIONS) and b["questionOrder"] != a["questionOrder"]
    assert sorted(b["optionOrder"]["q1"]) == ["a", "b", "c", "d"]
    assert core.build_versions("exam-1", list(QUESTIONS), QUESTIONS, 2) == e["versions"]  # deterministic
    assert core.build_versions("exam-2", list(QUESTIONS), QUESTIONS, 2)[1] != b  # seeded by exam id
    assert "q4" not in b["optionOrder"]


def test_answer_key_follows_the_version():
    e = exam()
    b = core.find_version(e, "B")
    key = {r["questionId"]: r for r in core.answer_key(e, QUESTIONS, "B")}
    printed = b["optionOrder"]["q1"].index("b")
    assert key["q1"]["letters"] == [core.LETTERS[printed]]
    assert key["q3"]["blanks"] == {"b1": ["sol"], "b2": ["luna", "lúnula"]}
    assert key["q4"]["modelAnswer"] == Q_OPEN["modelAnswer"]
    assert key["q1"]["position"] == b["questionOrder"].index("q1") + 1


def test_objective_scoring_maps_printed_letters():
    e = exam(penalty=0.25)
    b = core.find_version(e, "B")
    right = core.LETTERS[b["optionOrder"]["q1"].index("b")]
    wrong = core.LETTERS[b["optionOrder"]["q1"].index("a")]
    assert core.score_objective(Q_TEST, {"letters": right}, 1, b)["result"] == "CORRECT"
    bad = core.score_objective(Q_TEST, {"letters": wrong}, 1, b, penalty=0.25)
    assert bad["result"] == "WRONG" and bad["points"] == -0.25
    assert core.score_objective(Q_TEST, {"letters": ""}, 1, b)["result"] == "BLANK"
    assert core.score_objective(Q_TEST, {"letters": "z"}, 1, b)["result"] == "INVALID"
    a = core.find_version(e, "A")
    assert core.score_objective(Q_MULTI, {"letters": "a, c"}, 1, a)["result"] == "CORRECT"
    assert core.score_objective(Q_MULTI, {"letters": "ca"}, 1, a)["result"] == "CORRECT"
    assert core.score_objective(Q_MULTI, {"letters": "a"}, 1, a)["result"] == "WRONG"
    assert core.score_objective(Q_CLOZE, {"text": "Sol; LÚNULA"}, 1, a)["result"] == "CORRECT"
    assert core.score_objective(Q_CLOZE, {"blankAnswers": {"b1": "sol", "b2": "marte"}}, 1, a)["points"] == 0
    assert core.score_objective(Q_OPEN, {"text": "algo"}, 2, a) is None


def test_rubric_breakdown_and_validation():
    full = core.rubric_breakdown(RUBRIC, {"c1": "c1l2", "c2": "c2l1"}, 2)
    assert full["points"] == 2 and full["complete"]
    half = core.rubric_breakdown(RUBRIC, {"c1": "c1l1", "c2": "c2l0"}, 2)
    assert half["points"] == 0.6 and [c["maxPoints"] for c in half["criteria"]] == [1.2, 0.8]
    missing = core.rubric_breakdown(RUBRIC, {"c1": "c1l1"}, 2)
    assert not missing["complete"] and missing["criteria"][1]["points"] is None
    assert core.validate_rubric(RUBRIC) == []
    assert core.validate_rubric({"criteria": [{"id": "x", "name": "", "levels": [{"id": "l", "points": 0}]}]})


def test_submission_result_feedback_and_pending():
    e = exam()
    a = core.find_version(e, "A")
    sub = {"version": "A", "answers": {"q1": {"letters": "b"}, "q2": {"letters": "b"}, "q3": {"text": "sol; luna"},
                                       "q4": {"text": "La luz."}}, "decisions": {}}
    res = core.submission_result(e, QUESTIONS, sub)
    assert res["pending"] == ["q4"] and not res["complete"]
    sub["decisions"]["q4"] = {"points": 0.6, "rubricId": "r1", "criteria": [
        {"criterionId": "c1", "levelId": "c1l1", "points": 0.6, "maxPoints": 1.2},
        {"criterionId": "c2", "levelId": "c2l0", "points": 0, "maxPoints": 0.8}]}
    res = core.submission_result(e, QUESTIONS, sub)
    assert res == {"points": 2.6, "maxPoints": 5.0, "grade": 5.2, "band": "Aprobado", "pending": [], "complete": True}
    fb = core.feedback(e, QUESTIONS, {"t1": "Tema Uno", "t2": "Tema Dos"},
                       [{"id": "k1", "topicId": "t2", "title": "Concepto inventado", "category": "definition"}],
                       sub, {"r1": RUBRIC})
    assert {s["questionId"] for s in fb["strengths"]} == {"q1", "q3"}
    mistakes = {m["questionId"]: m for m in fb["mistakes"]}
    assert mistakes["q2"]["detail"] == "Marcó b; la correcta era a, c."
    assert mistakes["q4"]["detail"] == "Flojo en: Claridad."  # half of a criterion is not "flojo"
    assert fb["review"] == [{"topicId": "t2", "topic": "Tema Dos", "ratio": 0.15,
                             "keyConcepts": [{"id": "k1", "title": "Concepto inventado"}]}]
    assert fb["strongTopics"] == ["Tema Uno"]
    assert a["questionOrder"][0] == "q1"


def test_parse_roster_variants():
    plain = core.parse_roster("Alumna Uno\nAlumno Dos\n\nalumna uno\n")
    assert [s["displayName"] for s in plain["students"]] == ["Alumna Uno", "Alumno Dos"]
    assert plain["skipped"] == ["alumna uno"]
    swapped = core.parse_roster("Pérez Inventado, Ana\nGómez Ficticio, Luis")
    assert [s["displayName"] for s in swapped["students"]] == ["Ana Pérez Inventado", "Luis Gómez Ficticio"]
    csv = core.parse_roster("Nombre;Apellidos;Correo\nAna;Ficticia;ana@example.invalid\nBea;Inventada;\n")
    assert csv["students"] == [{"displayName": "Ana Ficticia", "email": "ana@example.invalid"},
                               {"displayName": "Bea Inventada"}]
    alias = core.parse_roster("alias\tcorreo\nEstrella\testrella@example.invalid")
    assert alias["students"] == [{"displayName": "Estrella", "email": "estrella@example.invalid"}]


def test_parse_answer_grid_and_mapping():
    e = exam()
    grid = core.parse_answer_grid("Alumno;Versión;1;2;3;4\nAna Ficticia;B;c;a,c;sol; luna\nBea;a;b;;;\n")
    assert grid["rows"][0]["version"] == "B" and grid["rows"][0]["cells"][1] == "c"
    assert grid["rows"][1] == {"student": "Bea", "version": "A", "cells": {1: "b"}}
    no_header = core.parse_answer_grid("Ana\tb\ta")
    assert no_header["rows"][0]["cells"] == {1: "b", 2: "a"}
    mapped = core.grid_answers(e, QUESTIONS, "B", {1: "a", 4: "texto"})
    b = core.find_version(e, "B")
    first = QUESTIONS[b["questionOrder"][0]]
    assert b["questionOrder"][0] in mapped and mapped[b["questionOrder"][0]]["source"] == "grid"
    if first["type"] == "TEST":
        assert mapped[first["id"]]["letters"] == "a"
    students = [{"id": "s1", "displayName": "Ana Ficticia"}, {"id": "s2", "displayName": "Bea Inventada"}]
    assert core.match_student("ana ficticia", students)["id"] == "s1"
    assert core.match_student("Bea", students)["id"] == "s2"
    assert core.match_student("Nadie", students) is None


def test_analysis_and_distribution():
    e = exam()
    def sub(name, q1, q2, q4_points, confirmed=True):
        return {"id": name, "version": "A", "confirmed": confirmed,
                "answers": {"q1": {"letters": q1}, "q2": {"letters": q2}, "q3": {"text": "sol; luna"}},
                "decisions": {"q4": {"points": q4_points, "rubricId": "r1", "criteria": [
                    {"criterionId": "c1", "points": q4_points / 2, "maxPoints": 1.2}]}}}
    subs = [sub("s1", "b", "ac", 2), sub("s2", "a", "b", 0.2), sub("s3", "a", "a", 0.4), sub("s4", "b", "ac", 2, False)]
    out = core.analyze(e, QUESTIONS, {"t1": "Tema Uno", "t2": "Tema Dos"}, subs, {"r1": RUBRIC})
    items = {i["questionId"]: i for i in out["items"]}
    assert out["submissions"] == 3 and out["graded"] == 3
    assert items["q1"]["success"] == 0.33 and items["q1"]["wrongOptions"] == [{"optionId": "a", "text": "Verde", "count": 2}]
    assert items["q2"]["wrongOptions"][0]["count"] == 1
    assert items["q4"]["weakCriteria"] == [{"criterionId": "c1", "name": "Contenido", "count": 2}]
    # Another rubric also has a "c1": names come from the decision's own rubric.
    other = {"id": "r0", "criteria": [{"id": "c1", "name": "Otro criterio", "weight": 1, "levels": []}]}
    again = core.analyze(e, QUESTIONS, {}, subs, {"r0": other, "r1": RUBRIC})
    assert {i["questionId"]: i for i in again["items"]}["q4"]["weakCriteria"][0]["name"] == "Contenido"
    assert out["worstTopic"]["topic"] == "Tema Dos"
    dist = out["distribution"]
    assert dist["count"] == 3 and sum(b["count"] for b in dist["bands"]) == 3 and sum(dist["histogram"]) == 3
    combined = core.combine_topics([out, out])
    assert combined[0]["topic"] == "Tema Dos" and combined[0]["exams"] == 2
    assert core.distribution([]) ["mean"] is None
