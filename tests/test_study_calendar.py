from hypatia.agent_tools import call_tool
from hypatia.hoard_link.ics import parse_ics


def seed(services):
    services.store.put("subject", {"id": "s1", "name": "Álgebra", "examDate": "2026-10-28"})
    services.store.put("subject", {"id": "s2", "name": "Física"})
    for uid, patch in [("day", {}), ("clock", {"dueTime": "00:00", "type": "exam"}),
                       ("done", {"status": "submitted"}), ("missing", {"dueDate": None}),
                       ("invalid", {"dueDate": "2026-02-30"}), ("bad-time", {"dueTime": "25:00"}),
                       ("other", {"subjectId": "s2"}), ("past", {"dueDate": "2026-09-01"})]:
        services.store.put("deliverable", {"id": uid, "subjectId": "s1", "name": "Álgebra, prueba;\n" + uid,
                                           "type": "activity", "status": "pending", "dueDate": "2026-10-28",
                                           "grade": "DO_NOT_EXPORT_GRADE", **patch})


def test_calendar_preserves_dates_times_uid_and_scoped_readonly_provenance(services):
    seed(services)
    before = services.db.conn.total_changes
    args = {"date_from": "2026-10-01", "date_to": "2026-10-28", "subject": "s1"}
    result = call_tool(services, "study_calendar_export", args)
    assert services.db.conn.total_changes == before
    assert [e["id"] for e in result["events"]] == ["day", "clock"]
    assert len(result["excluded"]) == 3 and result["completed_skipped"] == 1 and result["outside_range"] == 1
    assert "DTSTART;VALUE=DATE:20261028\r\nDTEND;VALUE=DATE:20261029" in result["ics"]
    assert "DTSTART:20261028T000000" in result["ics"] and "TZID" not in result["ics"]
    assert "VALARM" not in result["ics"] and "DO_NOT_EXPORT" not in str(result)
    parsed = parse_ics(result["ics"])
    assert len(parsed) == 2 and {e["uid"] for e in parsed} == {e["uid"] for e in result["events"]}
    assert all(len(line.encode()) <= 75 for line in result["ics"].split("\r\n"))
    again = call_tool(services, "study_calendar_export", {**args, "include_completed": True})
    assert len(again["events"]) == 3 and again["events"][0]["uid"] == result["events"][0]["uid"]
    assert services.db.conn.total_changes == before


def test_calendar_http_and_native_return_same_snapshot_and_empty_range(client):
    seed(client.services)
    body = {"date_from": "2026-10-01", "date_to": "2026-10-31", "include_completed": True}
    response = client.post("/api/study/calendar/export", json=body)
    assert response.status_code == 200
    assert response.json() == call_tool(client.services, "study_calendar_export", body)
    assert len(response.json()["events"]) == 4
    empty = client.post("/api/study/calendar/export", json={"date_from": "2027-01-01", "date_to": "2027-01-31"}).json()
    assert empty["events"] == [] and "BEGIN:VEVENT" not in empty["ics"]
    assert client.post("/api/study/calendar/export", json={"date_from": "2027-02-01", "date_to": "2027-01-31"}).status_code == 400
