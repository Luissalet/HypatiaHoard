"""The same exact calculator is exposed through the agent catalog and MCP bridge."""

import pytest

from hypatia.agent_tools import call_tool, tool_catalog


def test_matrix_product_contract_and_bank_preservation(client):
    with client.services.db.lock:
        names = [row[0] for row in client.services.db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        before = {name: [tuple(row) for row in client.services.db.conn.execute('SELECT * FROM "' + name + '"')] for name in names}
    args = {"operation": "multiply", "matrix": [["1/2", "1", "-2"], ["0", "3", "1"]],
            "right_matrix": [["2", "0"], ["1/3", "4"], ["-1", "2"]]}
    token = client.services.config.token_path.read_text().strip()
    direct = client.post("/api/math/matrix", json=args)
    gateway = client.post("/api/agent/call", headers={"Authorization": "Bearer " + token},
                          json={"name": "math_matrix", "arguments": args})
    assert direct.status_code == gateway.status_code == 200
    value = direct.json()
    assert value == gateway.json() == call_tool(client.services, "math_matrix", args)
    assert value["product_exact"] == [["10/3", "0"], ["0", "14"]]
    assert (value["rows"], value["columns"], value["right_rows"], value["right_columns"],
            value["product_rows"], value["product_columns"]) == (2, 3, 3, 2, 2, 2)
    assert value["original_matrix"] == args["matrix"] and value["original_right_matrix"] == args["right_matrix"]
    decimal = call_tool(client.services, "math_matrix", {"operation": "multiply", "matrix": [["0.1", "-1/3"]], "right_matrix": [["3"], ["0.6"]]})
    assert decimal["product_exact"] == [["1/10"]]
    a, b = [["1", "1"], ["0", "1"]], [["1", "0"], ["1", "1"]]
    ab = call_tool(client.services, "math_matrix", {"operation": "multiply", "matrix": a, "right_matrix": b})
    ba = call_tool(client.services, "math_matrix", {"operation": "multiply", "matrix": b, "right_matrix": a})
    assert ab["product_exact"] == [["2", "1"], ["1", "1"]]
    assert ba["product_exact"] == [["1", "1"], ["1", "2"]]
    with client.services.db.lock:
        after = {name: [tuple(row) for row in client.services.db.conn.execute('SELECT * FROM "' + name + '"')] for name in names}
    assert after == before


def test_matrix_product_reports_operand_and_dimension_errors(client):
    cases = [
        ({"matrix": [["1", "2"]]}, "Matrix B"),
        ({"matrix": [["1", "2"]], "right_matrix": [["1", "2"]]}, "columns"),
        ({"matrix": [["1"]], "right_matrix": [["1"], ["2", "3"]]}, "Matrix B: Row 2"),
        ({"matrix": [["1"]], "right_matrix": [["1/0"]]}, "Matrix B: Row 1, column 1"),
    ]
    for arguments, detail in cases:
        response = client.post("/api/math/matrix", json={"operation": "multiply", **arguments})
        assert response.status_code == 400 and detail in response.json()["error"]
    response = client.post("/api/math/matrix", json={"operation": "inverse", "matrix": [["1"]], "right_matrix": [["1"]]})
    assert response.status_code == 400 and "only used by multiply" in response.json()["error"]


def test_polynomial_forms_are_exact_and_equivalent(services):
    import sympy as sp

    cases = [
        ("expand", "(x+2)*(x-3)", "x", "x**2 - x - 6"),
        ("factor", "x**3-x**2+x-1", "x", "(x - 1)*(x**2 + 1)"),
        ("expand", "(t+0.1)*(t-1/3)", "t", "t**2 - 7*t/30 - 1/30"),
        ("factor", "y**2/2-y/2", "y", "y*(y - 1)/2"),
        ("factor", "x**2-2", "x", "x**2 - 2"),
        ("factor", "0", "x", "0"),
    ]
    for operation, expression, variable, expected in cases:
        value = call_tool(services, "math_compute", dict(operation=operation, expression=expression, variable=variable))
        assert value["exact"] == expected and value["expression"] == expression
        assert sp.expand(sp.sympify(value["exact"]) - sp.sympify(expression, rational=True)) == 0
        assert value["latex"] and (value["approx"] is None or expected == "0")


def test_polynomial_scope_preserves_original_domain(services):
    for expression in ("sin(x)", "pi*x", "(x-1)/(x-1)", "x*x**-1", "log(x)-log(x)"):
        with pytest.raises(ValueError, match="[Pp]olynomial|rational"):
            call_tool(services, "math_compute", {"operation": "factor", "expression": expression})
    # This scope belongs to the new polynomial operations; existing calculus keeps its syntax.
    assert call_tool(services, "math_compute", {"operation": "differentiate", "expression": "1/x"})["exact"] == "-1/x**2"


def test_polynomial_ui_agent_contract_and_study_bank(client):
    client.services.store.put("subject", {"id": "qa-polynomial", "name": "Synthetic polynomials"})
    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(row) for row in client.services.db.conn.execute("SELECT * FROM " + name)]
                    for name in ("records", "reviews", "tombstones", "kv")}
    before = snapshot()
    for operation, expression in [("expand", "(x+2)*(x-3)"), ("factor", "x**3-x**2+x-1")]:
        args = {"operation": operation, "expression": expression}
        ui = client.post("/api/math/compute", json=args)
        agent = client.post("/api/agent/call", headers={"Authorization": "Bearer " + client.services.token},
                            json={"name": "math_compute", "arguments": args})
        assert ui.status_code == agent.status_code == 200
        assert ui.json() == agent.json() == call_tool(client.services, "math_compute", args)
    assert snapshot() == before
    catalog = {entry["name"]: entry for entry in tool_catalog()}
    assert {"expand", "factor"} <= set(catalog["math_compute"]["inputSchema"]["properties"]["operation"]["enum"])


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
    direct = client.post("/api/math/linear-system", json={"coefficients": [["1", "1"], ["1", "-1"]],
        "constants": ["3", "1"], "variables": ["x", "y"]})
    assert direct.status_code == 200 and direct.json() == result
    for constants, expected in [(["1", "2"], "infinite"), (["1", "3"], "inconsistent")]:
        args = {"coefficients": [["1", "1"], ["2", "2"]], "constants": constants, "variables": ["x", "y"]}
        response = client.post("/api/math/linear-system", json=args)
        assert response.status_code == 200 and response.json()["classification"] == expected
        assert response.json() == call_tool(client.services, "math_linear_system", args)
    assert before == snapshot()
