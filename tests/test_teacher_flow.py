"""The teacher flow through the assistant tools (same path as MCP): classes, exam from
the bank with versions, rubric, batch, answers, model proposals with verified quotes,
confirmation, grades, analysis and reinforcement. Invented subject and students."""

import json

import pytest

from fakes import FakeLink
from hypatia.agent_tools import call_tool
from hypatia.notebook import init_schema
from hypatia.notebook import worker as nb_worker
from hypatia.teacher import core
from hypatia.teacher.store import teacher_store

STUDENTS = "Nombre;Apellidos;Correo\nAna;Ficticia;ana@example.invalid\nBruno;Inventado;\nCarla;Supuesta;\n"


def call(services, tool_name, **args):
    return call_tool(services, tool_name, args)


@pytest.fixture
def tsvc(services):
    with services.db.lock:
        init_schema(services.db.conn)
    yield services
    nb_worker.stop_worker()


@pytest.fixture
def bank(tsvc):
    now = tsvc.now_iso()
    tsvc.store.put("subject", {"id": "s1", "name": "Ciencias Inventadas", "createdAt": now, "updatedAt": now})
    for i, title in enumerate(["Astros ficticios", "Plantas imaginarias", "Tema tres"]):
        tsvc.store.put("topic", {"id": f"t{i + 1}", "subjectId": "s1", "title": title, "order": i,
                                 "createdAt": now, "updatedAt": now})
    qs = []
    for i in range(6):
        qs.append({"type": "TEST", "prompt": f"Pregunta test {i} del astro",
                   "options": [{"id": "a", "text": "Uno"}, {"id": "b", "text": "Dos"}, {"id": "c", "text": "Tres"}],
                   "correctOptionIds": ["a"], "difficulty": 1 + i % 5})
    call(tsvc, "questions_add", subject="s1", topic="1", questions=qs)
    call(tsvc, "questions_add", subject="s1", topic="2", questions=[
        {"type": "DESARROLLO", "prompt": "Explica la fotosíntesis imaginaria.", "modelAnswer": "Luz del sol y agua.",
         "keywords": ["luz", "agua"]},
        {"type": "COMPLETAR", "prompt": "Completa", "clozeText": "La {{b1}} brilla", "blanks": [{"id": "b1", "accepted": ["estrella"]}]}])
    call(tsvc, "key_concept_add", subject="s1", topic="2", category="definition", title="Fotosíntesis imaginaria",
         content="Proceso inventado.")
    return tsvc


def grading_reply(messages, **kwargs):
    system = " ".join(str(m["content"]) for m in messages if m["role"] == "system")
    if "rúbrica" in system and "corrige" in system:
        return json.dumps({"criteria": [
            {"criterionId": "c1", "levelId": "c1l2", "justification": "Menciona la luz.",
             "quotes": ["la luz del sol", "una cita que el alumno nunca escribió"]},
            {"criterionId": "c2", "levelId": "c2l1", "justification": "Se entiende.", "quotes": []}],
            "confidence": 0.8, "comment": "Bien, completa con el agua."})
    if "rúbricas" in system:
        return json.dumps({"criteria": [
            {"name": "Idea principal", "weight": 70, "levels": [{"descriptor": "No la da", "points": 0},
                                                               {"descriptor": "La da", "points": 2}]},
            {"name": "Ejemplo", "weight": 30, "levels": [{"descriptor": "Sin ejemplo", "points": 0},
                                                         {"descriptor": "Con ejemplo", "points": 1}]}]})
    return "{}"


RUBRIC = [{"name": "Contenido", "weight": 60, "levels": [{"descriptor": "Nada", "points": 0},
                                                        {"descriptor": "Algo", "points": 1},
                                                        {"descriptor": "Todo", "points": 2}]},
          {"name": "Claridad", "weight": 40, "levels": [{"descriptor": "Confusa", "points": 0},
                                                       {"descriptor": "Clara", "points": 1}]}]


def test_full_teacher_flow(bank):
    fake = FakeLink(chat_handler=grading_reply)
    bank.link = lambda: fake
    klass = call(bank, "teacher_class_create", name="2º B", course="2º Ciclo inventado", year="2026-2027",
                 subjects=["Ciencias"])["class"]
    assert klass["subjects"] == ["Ciencias Inventadas"]
    again = call(bank, "teacher_class_create", name="2º B", year="2026-2027")
    assert again["existing"] is True
    added = call(bank, "teacher_students_add", **{"class": "2B", "roster": STUDENTS, "students": ["Ana Ficticia"]})
    assert added["added"] == ["Ana Ficticia", "Bruno Inventado", "Carla Supuesta"] and added["skipped"] == ["Ana Ficticia"]
    roster = call(bank, "teacher_classes", **{"class": "2ºB"})["class"]["roster"]
    assert roster[0]["email"] == "ana@example.invalid"

    gen = call(bank, "exam_generate", subject="ciencias", topics=["1", "2"], counts={"TEST": 3, "DESARROLLO": 1, "COMPLETAR": 1},
               source="bank", versions=2, title="Parcial inventado", header={"centre": "IES Ficticio", "duration_min": 50},
               **{"class": "2B"})
    exam = gen["exam"]
    assert gen["job"] is None and len(exam["items"]) == 5 and exam["maxPoints"] == 6.0
    assert [v["label"] for v in exam["versions"]] == ["A", "B"] and set(exam["answerKeys"]) == {"A", "B"}
    assert exam["practiceExamId"] and bank.store.get("exam", exam["practiceExamId"])["name"] == "Parcial inventado"
    open_q = next(i for i in exam["items"] if i["type"] == "DESARROLLO")

    proposal = call(bank, "rubric_propose", exam="Parcial", question=open_q["questionId"])
    assert proposal["status"] == "ok" and proposal["rubric"]["criteria"][0]["name"] == "Idea principal"
    saved = call(bank, "rubric_set", exam="Parcial", question=str(open_q["position"]), criteria=RUBRIC)["rubric"]
    assert [c["id"] for c in saved["criteria"]] == ["c1", "c2"] and saved["criteria"][0]["levels"][2]["id"] == "c1l2"

    batch = call(bank, "grading_batch_create", exam="Parcial inventado", **{"class": "2B"})
    assert batch["submissions"] == 3
    store = teacher_store(bank)
    full = store.get("teacherExam", exam["id"])
    questions = {q["id"]: q for q in (bank.store.get("question", i["questionId"]) for i in full["items"])}
    rows = []
    for name, version in (("Ana Ficticia", "A"), ("Bruno Inventado", "B"), ("Carla Supuesta", "A")):
        key = {r["position"]: r for r in core.answer_key(full, questions, version)}
        cells = []
        for pos in range(1, 6):
            r = key[pos]
            if r["type"] == "TEST":
                cells.append(r["letters"][0] if name != "Carla Supuesta" else ("b" if r["letters"][0] != "b" else "c"))
            elif r["type"] == "COMPLETAR":
                cells.append("estrella" if name == "Ana Ficticia" else "luna")
            else:
                cells.append("")
        rows.append(";".join([name, version] + cells))
    grid = "alumno;version;1;2;3;4;5\n" + "\n".join(rows) + "\nDesconocido;A;a\n"
    imported = call(bank, "grading_submit_answers", batch="Parcial inventado", grid=grid)
    assert len(imported["updated"]) == 3 and imported["unmatched"] == ["Desconocido"]
    open_pos = {v: core.find_version(full, v)["questionOrder"].index(open_q["questionId"]) + 1 for v in ("A", "B")}
    call(bank, "grading_submit_answers", batch="Parcial inventado", student="Ana",
         answers={str(open_pos["A"]): "Usa la luz   del Sol para crecer."})
    call(bank, "grading_submit_answers", batch="Parcial inventado", student="Bruno",
         answers={str(open_pos["B"]): "Ni idea, pero la luz del sol importa."})

    run = call(bank, "grading_run", batch="Parcial inventado", wait_s=20)
    assert run["job"]["status"] == "done" and run["job"]["result"]["graded"] == 3
    review = call(bank, "grading_review", batch="Parcial inventado", student="Ana")["students"][0]
    item = next(i for i in review["items"] if i["questionId"] == open_q["questionId"])
    prop = item["proposal"]
    assert prop["status"] == "ok" and prop["points"] == 2.0 and prop["droppedQuotes"] == 1
    assert prop["criteria"][0]["quotes"] == ["la luz del Sol"] and prop["criteria"][0]["name"] == "Contenido"
    assert item["decision"] is None and review["confirmed"] is False  # nothing final yet
    carla = call(bank, "grading_review", batch="Parcial inventado", student="Carla")["students"][0]
    blank = next(i for i in carla["items"] if i["questionId"] == open_q["questionId"])
    assert blank["proposal"]["status"] == "empty" and blank["proposal"]["points"] == 0

    ana = call(bank, "grading_confirm", batch="Parcial inventado", student="Ana")
    assert ana["confirmed"] and ana["result"]["grade"] == 10.0 and ana["result"]["band"] == "Sobresaliente"
    bruno = call(bank, "grading_confirm", batch="Parcial inventado", student="Bruno",
                 overrides={str(open_pos["B"]): {"levels": {"c1": "c1l1", "c2": "c2l0"}, "comment": "Incompleta"}})
    assert bruno["confirmed"] and bruno["result"]["points"] == 3.6  # 3 TEST + 0 cloze + 0.6 rubric
    carla_res = call(bank, "grading_confirm", batch="Parcial inventado", student="Carla", accept_proposals=False)
    assert not carla_res["confirmed"] and carla_res["pending"] == [open_q["questionId"]]
    carla_res = call(bank, "grading_confirm", batch="Parcial inventado", student="Carla", overrides={str(open_pos["A"]): 0})
    assert carla_res["confirmed"] and carla_res["result"]["grade"] == 0.0
    assert carla_res["feedback"]["review"] and carla_res["feedback"]["mistakes"]

    report = call(bank, "grades_report", batch="Parcial inventado", save_csv=True)
    assert report["csv"].splitlines()[0].startswith("Alumno;Versión;Puntos")
    assert "Ana Ficticia;A;6;6;10;Sobresaliente;sí" in report["csv"]
    assert report["path"].endswith(".csv")

    analysis = call(bank, "class_analysis", **{"class": "2º B"})
    assert analysis["exams"][0]["graded"] == 3
    assert analysis["worstTopic"]["topic"] in ("Plantas imaginarias", "Astros ficticios")
    reinforce = call(bank, "class_reinforce", **{"class": "2B", "student": "Carla"})
    practice = bank.store.get("exam", reinforce["exam"]["id"])
    assert practice and "Carla" not in practice["name"] and practice["name"].startswith("Refuerzo · individual")


def test_grading_without_model_reports_no_model(bank):
    call(bank, "teacher_class_create", name="1º A")
    call(bank, "teacher_students_add", **{"class": "1A", "students": ["Dana Ficticia"]})
    exam = call(bank, "exam_generate", subject="s1", counts={"DESARROLLO": 1}, source="bank")["exam"]
    call(bank, "rubric_set", exam=exam["id"], criteria=RUBRIC)
    call(bank, "grading_batch_create", exam=exam["id"], **{"class": "1A"})
    call(bank, "grading_submit_answers", batch=exam["id"], student="Dana", answers={"1": "Algo escribí."})
    run = call(bank, "grading_run", batch=exam["id"], wait_s=20)
    assert run["job"]["status"] == "no_model" and "No hay modelo" in run["job"]["note"]
    review = call(bank, "grading_review", batch=exam["id"])
    assert "proposal" not in review["students"][0]["items"][0]  # no grade was invented


def test_rubric_propose_without_model_gives_template_and_export_pdf(bank):
    exam = call(bank, "exam_generate", subject="s1", counts={"DESARROLLO": 1, "TEST": 2}, source="bank", versions=2,
                header={"centre": "Centro Ficticio", "instructions": "Responde con calma."})["exam"]
    open_q = next(i for i in exam["items"] if i["type"] == "DESARROLLO")
    res = call(bank, "rubric_propose", exam=exam["id"], question=open_q["questionId"], save=True)
    assert res["status"] == "no_model" and res["rubric"]["origin"] == "template" and res["saved"]["origin"] == "template"
    out = call(bank, "exam_export_pdf", exam=exam["id"])
    from pypdf import PdfReader

    reader = PdfReader(out["path"])
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "Centro Ficticio" in text and "Versión B" in text and "Solucionario" in text and "Rúbricas" in text
    assert "Contenido y conceptos clave" in text and len(reader.pages) >= 5


def test_exam_generate_needs_a_subject_when_ambiguous(bank):
    now = bank.now_iso()
    bank.store.put("subject", {"id": "s2", "name": "Otra Inventada", "createdAt": now, "updatedAt": now})
    with pytest.raises(ValueError, match="Say which subject"):
        call(bank, "exam_generate", n=3)
    out = call(bank, "exam_generate", subject="Ciencias", n=6, source="bank")
    counts = {}
    for item in out["exam"]["items"]:
        counts[item["type"]] = counts.get(item["type"], 0) + 1
    assert counts == {"TEST": 4, "DESARROLLO": 1} and out["shortfall"] == {"DESARROLLO": 1}
    assert any("Faltan preguntas" in n for n in out["notes"])
