"""The same exact calculator is exposed through the agent catalog and MCP bridge."""

import pytest

from hypatia.agent_tools import call_tool, tool_catalog


def test_exact_arithmetic_equations_and_derivatives(services):
    arithmetic = call_tool(services, "math_compute", {"operation": "evaluate", "expression": "1/3 + 1/6"})
    assert arithmetic["exact"] == "1/2"
    roots = call_tool(services, "math_compute", {"operation": "solve", "expression": "x**2 - 2 = 0"})
    assert {root["exact"] for root in roots["solutions"]} == {"-sqrt(2)", "sqrt(2)"}
    assert call_tool(services, "math_compute", {"operation": "solve", "expression": "x=x"})["all_values"] is True
    derivative = call_tool(services, "math_compute", {"operation": "differentiate", "expression": "sin(x) + x**3"})
    assert derivative["exact"] == "3*x**2 + cos(x)"
    assert derivative["approx"] is None
    catalog = {entry["name"]: entry for entry in tool_catalog()}
    assert catalog["math_compute"]["annotations"]["readOnlyHint"] is True


def test_math_rejects_unsupported_expressions(services):
    for expression in ("__import__('os').system('echo bad')", "x**99", "sin(x)=0"):
        with pytest.raises((ValueError, TypeError)):
            call_tool(services, "math_compute", {"operation": "solve", "expression": expression})
    with pytest.raises(ValueError, match="without the variable"):
        call_tool(services, "math_compute", {"operation": "evaluate", "expression": "x+1"})
    with pytest.raises(ValueError, match="undefined"):
        call_tool(services, "math_compute", {"operation": "evaluate", "expression": "1/0"})


def test_decimal_literals_keep_written_precision(services):
    value = call_tool(services, "math_compute", {"operation": "evaluate", "expression": "0.1234567890123456789"})
    assert value["exact"] == "1234567890123456789/10000000000000000000"
    assert call_tool(services, "math_compute", {"operation": "evaluate", "expression": "1_2.5e-1"})["exact"] == "5/4"
    assert call_tool(services, "math_compute", {"operation": "evaluate", "expression": ".125 + 1.e-2"})["exact"] == "27/200"
    with pytest.raises(ValueError, match="Decimal exponent"):
        call_tool(services, "math_compute", {"operation": "evaluate", "expression": "1e-1000000"})


def system(services, rows, rhs, variables=None):
    return call_tool(services, "math_linear_system", {"coefficients": rows, "constants": rhs,
        "variables": variables or ["x", "y"]})


def test_unique_rectangular_fraction_system_and_residuals(services):
    result = system(services, [["1/3", "1/2"], ["1", "-1"], ["4/3", "-1/2"]], ["1", "0", "1"])
    assert result["classification"] == "unique"
    assert result["rank"] == result["augmented_rank"] == 2
    assert {k: v["exact"] for k, v in result["solutions"].items()} == {"x": "6/5", "y": "6/5"}
    assert result["residuals_exact"] == ["0", "0", "0"]
    assert result["verified"] is True
    assert result["free_variables"] == []
    assert tool_catalog()[0]["name"] == "math_linear_system"
    assert tool_catalog()[0]["annotations"]["readOnlyHint"] is True


def test_infinite_and_inconsistent_systems(services):
    infinite = system(services, [["1", "2"], ["2", "4"]], ["3", "6"], ["a", "b"])
    assert infinite["classification"] == "infinite"
    assert infinite["rank"] == infinite["augmented_rank"] == 1
    assert infinite["free_variables"] == ["b"]
    assert infinite["solutions"]["a"]["exact"] == "3 - 2*b"
    assert infinite["solutions"]["b"]["exact"] == "b"
    assert infinite["verified"] is True
    assert infinite["solutions"]["a"]["approx"] is None
    inconsistent = system(services, [["1", "2"], ["2", "4"]], ["3", "7"])
    assert inconsistent["classification"] == "inconsistent"
    assert (inconsistent["rank"], inconsistent["augmented_rank"]) == (1, 2)
    assert inconsistent["solutions"] == {}
    assert inconsistent["residuals_exact"] is None
    assert inconsistent["verified"] is None


def test_zero_matrix_multiple_free_variables_and_exact_decimals(services):
    zero = system(services, [["0", "0", "0"]], ["0"], ["a", "b", "c"])
    assert zero["classification"] == "infinite" and zero["free_variables"] == ["a", "b", "c"]
    assert zero["verified"] is True
    assert system(services, [["0", "0"]], ["1"])["classification"] == "inconsistent"
    exact = system(services, [["1"]], ["0.1234567890123456789"], ["price"])
    assert exact["solutions"]["price"]["exact"] == "1234567890123456789/10000000000000000000"


@pytest.mark.parametrize("rows,rhs,names", [
    ([["1", "2"]], ["3"], ["x"]),
    ([["1", "2"]], ["3", "4"], ["x", "y"]),
    ([["1", "2"]], ["3"], ["x", "x"]),
    ([["1", "2"]], ["3"], ["x", "x+y"]),
    ([["1/0", "2"]], ["3"], ["x", "y"]),
    ([["NaN", "2"]], ["3"], ["x", "y"]),
    ([["1e-1000000", "2"]], ["3"], ["x", "y"]),
    ([["__import__('os').system('echo bad')", "2"]], ["3"], ["x", "y"]),
])
def test_linear_invalid_inputs(services, rows, rhs, names):
    with pytest.raises((ValueError, TypeError)):
        system(services, rows, rhs, names)


def test_linear_http_contract_does_not_modify_bank(client):
    token = client.services.config.token_path.read_text().strip()
    client.services.store.put("subject", {"id": "qa", "name": "Synthetic algebra"})
    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(r) for r in client.services.db.conn.execute("SELECT * FROM " + name)]
                    for name in ("records", "reviews", "tombstones", "kv")}
    before = snapshot()
    response = client.post("/api/agent/call", headers={"Authorization": "Bearer " + token}, json={
        "name": "math_linear_system", "arguments": {"coefficients": [["1", "1"], ["1", "-1"]],
        "constants": ["3", "1"], "variables": ["x", "y"]}})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["solutions"]["x"]["exact"] == "2"
    assert before == snapshot()
