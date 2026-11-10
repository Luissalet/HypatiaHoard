"""Study plan until the exam: reviews, new cards spread before the last days, timed mocks, final review,
rest days, saved settings, the REST route, the MCP tool and the family agenda."""

from datetime import date, timedelta

import pytest

from hypatia import plan
from hypatia.agenda import agenda_items
from hypatia.agent_tools import call_tool

# FakeClock starts on Friday 2026-09-25.
TODAY = date(2026, 9, 25)


def day(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


def seed(services, n_seen=8, n_unseen=12, exam=None):
    now = services.now_iso()
    services.store.put("subject", {"id": "s1", "name": "Faros de Velmora", "createdAt": now, "updatedAt": now,
                                   **({"examDate": exam} if exam else {})})
    for i, title in enumerate(["Origen", "Funcionamiento"]):
        services.store.put("topic", {"id": f"t{i}", "subjectId": "s1", "title": title, "order": i, "createdAt": now, "updatedAt": now})
    for i in range(n_seen):
        wrong = i % 2  # every other card on «Funcionamiento» was failed
        stats = {"seen": 2, "correct": 2 - wrong, "wrong": wrong, "lastResult": "WRONG" if wrong else "CORRECT",
                 "nextReviewAt": day(0) if i < 3 else day(4), "interval": 2}
        services.store.put("question", {"id": f"s{i}", "subjectId": "s1", "topicId": f"t{wrong}", "type": "DESARROLLO",
                                        "prompt": f"vista {i}", "modelAnswer": "x", "stats": stats, "createdAt": now, "updatedAt": now})
    for i in range(n_unseen):
        services.store.put("question", {"id": f"n{i:02d}", "subjectId": "s1", "topicId": f"t{i % 2}", "type": "DESARROLLO",
                                        "prompt": f"nueva {i}", "modelAnswer": "x", "stats": {"seen": 0, "correct": 0, "wrong": 0},
                                        "createdAt": now, "updatedAt": now})
    return services.store.get("subject", "s1")


def test_plan_spreads_new_cards_and_schedules_mocks_final_review_and_exam(services):
    subject = seed(services)
    out = plan.build(services, subject, exam_date=day(20), minutes_per_day=60, save=True)
    days = out["days"]
    assert out["daysLeft"] == 20 and len(days) == 21 and days[0]["date"] == day(0)
    assert days[-1] == {**days[-1], "date": day(20), "kind": "exam"}
    assert days[-2]["kind"] == "final" and days[-2]["newCards"] == 0
    mocks = [d["date"] for d in days if d["kind"] == "mock"]
    assert day(17) in mocks and len(mocks) >= 2  # ~3 days before and a weekly one
    # every unseen card is studied, none in the last two days
    assert sum(d["newCards"] for d in days) == 12
    assert all(d["newCards"] == 0 for d in days if d["date"] > day(18))
    # the reviews already due today are on today's list, with today's new cards
    today = out["todayPlan"]
    assert set(today["reviewIds"]) == {"s0", "s1", "s2"} and today["newIds"] and today["questionIds"][:3] == today["reviewIds"]
    assert days[0]["reviews"] == 3 and days[0]["minutes"] == int(3 * plan.REVIEW_MIN + days[0]["newCards"] * plan.NEW_MIN + 0.999)
    assert out["weakTopics"][0]["topic"] == "Funcionamiento"
    assert any("Funcionamiento" in d["topics"] for d in days if d["kind"] == "study")
    assert out["feasible"] is True and out["warnings"] == []
    assert plan.settings_of(services, "s1")["examDate"] == day(20)


def test_rest_days_get_no_work_and_saved_settings_are_reused(services):
    subject = seed(services)
    plan.build(services, subject, exam_date=day(20), rest_days=[5, 6], minutes_per_day=90, save=True)
    again = plan.build(services, subject)  # settings come back from the saved plan
    assert again["settings"]["restDays"] == [5, 6] and again["settings"]["minutesPerDay"] == 90
    for d in again["days"][:-1]:
        weekday = date.fromisoformat(d["date"]).weekday()
        assert (d["kind"] == "rest") == (weekday >= 5)
        if d["kind"] == "rest":
            assert d["minutes"] == 0 and d["reviews"] == 0 and d["newCards"] == 0
    # reviews that fall on a weekend move to the next study day; none get lost before the exam
    assert again["studyDays"] == sum(1 for d in again["days"] if d["kind"] not in ("rest", "exam"))


def test_too_little_time_is_said_plainly(services):
    subject = seed(services, n_seen=0, n_unseen=80)
    out = plan.build(services, subject, exam_date=day(4), minutes_per_day=10)
    assert out["feasible"] is False and any("más de 10 min" in w for w in out["warnings"])
    assert any(d.get("overload") for d in out["days"])
    assert sum(d["newCards"] for d in out["days"]) == 80


@pytest.mark.parametrize("kwargs, message", [
    ({}, "fecha del examen"),
    ({"exam_date": day(-1)}, "ya ha pasado"),
    ({"exam_date": day(10), "rest_days": [0, 1, 2, 3, 4, 5, 6]}, "al menos un día"),
    ({"exam_date": day(10), "minutes_per_day": 5}, "entre 10 y 600"),
])
def test_invalid_settings(services, kwargs, message):
    subject = seed(services)
    with pytest.raises(ValueError, match=message):
        plan.build(services, subject, **kwargs)


def test_the_subject_exam_date_is_used_and_the_exam_day_itself_works(services):
    subject = seed(services, exam=day(0))
    out = plan.build(services, subject)
    assert [d["kind"] for d in out["days"]] == ["exam"] and out["todayPlan"]["questionIds"] == []
    assert "El examen es hoy" in out["warnings"][0]


def test_tool_route_and_clear(client):
    seed(client.services)
    out = call_tool(client.services, "study_plan", {"subject": "faros", "exam_date": day(12), "minutes_per_day": 45})
    assert out["settings"] == {"examDate": day(12), "minutesPerDay": 45, "restDays": [], "mockQuestions": 20, "mockMinutes": 30}
    r = client.post("/api/study/plan", json={"subject": "s1"})
    assert r.status_code == 200 and r.json()["settings"]["examDate"] == day(12)
    assert client.post("/api/study/plan", json={"subject": "s1", "exam_date": "2020-01-01"}).status_code == 400
    assert client.post("/api/study/plan/clear", json={"subject": "s1"}).json() == {"subject": "Faros de Velmora", "removed": True}
    assert client.post("/api/study/plan", json={"subject": "s1"}).status_code == 400  # no date anywhere now


def test_the_agenda_shows_the_plan_and_its_exam(services):
    subject = seed(services)
    plan.build(services, subject, exam_date=day(9), rest_days=[6], save=True)
    items = agenda_items(services, TODAY, TODAY + timedelta(days=10))
    by_id = {i["id"]: i for i in items}
    exam = by_id["hypatia:exam:s1"]
    assert exam["start"] == day(9) and exam["kind"] == "exam" and exam["title"] == "Examen: Faros de Velmora"
    plan_items = [i for i in items if i["id"].startswith("hypatia:plan:s1:")]
    assert plan_items and all(i["kind"] == "review" and i["all_day"] for i in plan_items)
    assert day(2) not in {i["start"] for i in plan_items}  # Sunday 27 is a rest day
    assert any("simulacro" in i["title"] for i in plan_items) and any("repaso final" in i["title"] for i in plan_items)
    assert "tab=plan" in plan_items[0]["url"] or plan_items[0]["url"] == ""


def test_the_next_exam_deliverable_gives_the_date_and_the_agenda_does_not_repeat_it(services):
    subject = seed(services)
    now = services.now_iso()
    services.store.put("deliverable", {"id": "d0", "subjectId": "s1", "name": "Parcial viejo", "type": "exam", "dueDate": day(-3),
                                       "status": "pending", "createdAt": now, "updatedAt": now})
    services.store.put("deliverable", {"id": "d1", "subjectId": "s1", "name": "Final", "type": "exam", "dueDate": day(8),
                                       "status": "pending", "createdAt": now, "updatedAt": now})
    out = plan.build(services, subject, save=True)
    assert out["settings"]["examDate"] == day(8)
    items = agenda_items(services, TODAY, TODAY + timedelta(days=10))
    exams = [i for i in items if i["kind"] == "exam"]
    assert [i["id"] for i in exams] == ["hypatia:deliverable:d1"]
