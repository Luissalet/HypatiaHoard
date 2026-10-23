"""Exact interpolation, including decimal identity and zero-polynomial degree."""

import pytest

from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import interpolate


def test_polynomial_reconstructs_rational_data_without_rounding():
    result = interpolate([["-1", "2"], ["1", "2"], ["2", "5"]])
    assert result["exact"] == "x**2 + 1"
    assert result["degree"] == 2 and result["coefficients_exact"] == ["1", "0", "1"]
    assert result["verified"] and [r["residual_exact"] for r in result["rows"]] == ["0"] * 3
    precise = "0.1234567890123456789"
    result = interpolate([["0", "0"], [precise, precise]], "t")
    assert result["exact"] == "t"
    assert result["rows"][1]["x_exact"] == "1234567890123456789/10000000000000000000"
    assert interpolate([["1/2", "5/4"], ["0", "1"], ["1", "2"]])["exact"] == "x**2 + 1"
    constant = interpolate([["1", "7/3"]])
    assert constant["degree"] == 0 and constant["exact"] == "7/3"
    zero = interpolate([["0", "0"], ["2", "0"]])
    assert zero["is_zero"] and zero["degree"] is None and zero["coefficients_exact"] == ["0"]
    with pytest.raises(ValueError, match="Row 2.*repeats row 1"):
        interpolate([["0.5", "1"], ["1/2", "2"]])
    for pairs in ([], [["1"]], [["1/0", "2"]], [["pi", "2"]]):
        with pytest.raises(ValueError):
            interpolate(pairs)


def test_interpolation_ui_agent_contract_preserves_study_bank(client):
    client.services.store.put("subject", {"id": "qa-interpolation", "name": "Synthetic interpolation"})
    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(row) for row in client.services.db.conn.execute("SELECT * FROM " + name)]
                    for name in ("records", "reviews", "tombstones", "kv")}
    before = snapshot()
    arguments = {"points": [["-1", "2"], ["1", "2"], ["2", "5"]], "variable": "y"}
    ui = client.post("/api/math/interpolate", json=arguments)
    agent = client.post("/api/agent/call", headers={"Authorization": "Bearer " + client.services.token},
                        json={"name": "math_interpolate", "arguments": arguments})
    assert ui.status_code == agent.status_code == 200
    assert ui.json() == agent.json() == call_tool(client.services, "math_interpolate", arguments)
    assert snapshot() == before
    catalog = {item["name"]: item for item in tool_catalog()}
    assert catalog["math_interpolate"]["annotations"]["readOnlyHint"] is True
    assert len(catalog) == 60
    assert client.post("/api/math/interpolate", json={"points": [[".5", "1"], ["1/2", "2"]]}).status_code == 400
