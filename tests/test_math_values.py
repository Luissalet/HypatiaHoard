"""Value tables share the exact calculator grammar without cancelling holes."""

import pytest

from hoardtest import EXPECTED_TOOL_COUNT
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import values


def test_original_tree_keeps_undefined_inner_operations():
    for expression in ("x/x", "0*(1/x)", "(1/x)**0", "0*log(x)"):
        result = values(expression, ["1", "0", "1", "-1"])
        assert [row["point"] for row in result["rows"]] == ["1", "0", "1", "-1"]
        assert result["rows"][1]["status"] == "undefined"
        assert "exact" not in result["rows"][1]
        assert result["rows"][0] == result["rows"][2]
    with pytest.raises(ValueError):
        values("x**x", ["2"])


def test_exact_points_complex_values_and_invalid_rows():
    table = values("t**2+1/3", ["1/3", "0.1234567890123456789", "pi", "t/t", "t-t", "oo", "sqrt(-1)"], "t")
    assert table["rows"][0]["exact"] == "4/9"
    assert table["rows"][1]["point_exact"] == "1234567890123456789/10000000000000000000"
    assert table["rows"][2]["exact"] == "1/3 + pi**2"
    assert [r["status"] for r in table["rows"][3:]] == ["invalid_point"] * 4
    logarithm = values("log(y)", ["-1", "0", "E"], "y")
    assert [r["status"] for r in logarithm["rows"]] == ["complex", "undefined", "evaluated"]
    assert logarithm["rows"][0]["exact"] == "I*pi"
    assert logarithm["rows"][2]["exact"] == "1"


def test_values_api_agent_parity_and_study_bank_unchanged(client):
    client.services.store.put("subject", {"id": "qa-values", "name": "Synthetic value table"})
    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(row) for row in client.services.db.conn.execute("SELECT * FROM " + name)]
                    for name in ("records", "reviews", "tombstones", "kv")}
    before = snapshot()
    arguments = {"expression": "x/x", "points": ["0", "1/3", "x-x", "1/3"]}
    ui = client.post("/api/math/values", json=arguments)
    agent = client.post("/api/agent/call", headers={"Authorization": "Bearer " + client.services.token},
                        json={"name": "math_values", "arguments": arguments})
    assert ui.status_code == agent.status_code == 200
    assert ui.json() == agent.json() == call_tool(client.services, "math_values", arguments)
    assert snapshot() == before
    catalog = {item["name"]: item for item in tool_catalog()}
    assert catalog["math_values"]["annotations"]["readOnlyHint"] is True
    assert len(catalog) == EXPECTED_TOOL_COUNT
    assert client.post("/api/math/values", json={"expression": "x**99", "points": ["0"]}).status_code == 400
