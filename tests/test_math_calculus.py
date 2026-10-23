"""Analytic reference cases and shared UI/agent contracts for exact calculus."""

import subprocess
import sys

import pytest

from hypatia.agent_tools import call_tool, tool_catalog
from hypatia import math_tool


@pytest.mark.parametrize("expression,bounds,expected", [
    ("x**2", {"lower": "0", "upper": "1"}, "1/3"),
    ("x**2", {"lower": "1", "upper": "0"}, "-1/3"),
    ("x + 0.1", {"lower": "0", "upper": "1"}, "3/5"),
    ("sin(x)", {"lower": "0", "upper": "pi"}, "2"),
    ("exp(-x)", {"lower": "0", "upper": "oo"}, "1"),
    ("exp(x)", {"lower": "-oo", "upper": "0"}, "1"),
    ("exp(-x**2)", {"lower": "-oo", "upper": "oo"}, "sqrt(pi)"),
    ("1/sqrt(x)", {"lower": "0", "upper": "1"}, "2"),
    ("x", {"lower": "1/3", "upper": "1/2"}, "5/72"),
    ("x", {"lower": "2", "upper": "2"}, "0"),
    ("0", {}, "0"),
    ("x**2 + 1", {}, "x**3/3 + x"),
])
def test_integrals_against_analytic_results(services, expression, bounds, expected):
    result = call_tool(services, "math_compute", {"operation": "integrate", "expression": expression, **bounds})
    assert result["exact"] == expected
    assert result["status"] == "evaluated"
    assert result["integration_constant"] == (None if bounds else "C")
    assert result["latex"]


@pytest.mark.parametrize("expression,kwargs,expected,status", [
    ("sin(x)/x", {"point": "0"}, "1", "evaluated"),
    ("(1-cos(x))/x**2", {"point": "0"}, "1/2", "evaluated"),
    ("x**2/exp(x)", {"point": "oo"}, "0", "evaluated"),
    ("exp(x)", {"point": "-oo"}, "0", "evaluated"),
    ("1/x", {"point": "0", "side": "left"}, "-oo", "infinite"),
    ("1/x", {"point": "0", "side": "right"}, "oo", "infinite"),
    ("1/x**2", {"point": "0"}, "oo", "infinite"),
    ("sin(x)", {"point": "pi/2"}, "1", "evaluated"),
    ("sin(x)", {"point": "oo"}, "AccumBounds(-1, 1)", "nonexistent"),
])
def test_limits_against_analytic_results(services, expression, kwargs, expected, status):
    result = call_tool(services, "math_compute", {"operation": "limit", "expression": expression, **kwargs})
    assert (result["exact"], result["status"]) == (expected, status)
    if status != "evaluated":
        assert result["approx"] is None


def test_bilateral_and_oscillating_limits_are_not_numbers(services):
    jump = call_tool(services, "math_compute", {"operation": "limit", "expression": "1/x", "point": "0"})
    assert jump["status"] == "nonexistent"
    assert jump["exact"] is jump["latex"] is jump["approx"] is None
    assert (jump["left"]["exact"], jump["right"]["exact"]) == ("-oo", "oo")
    oscillating = math_tool.compute("limit", "sin(1/x)", point="0")
    assert oscillating["status"] == "nonexistent"


@pytest.mark.parametrize("expression,lower,upper", [("1/x", "-1", "1"), ("1/x**2", "-1", "1"), ("sin(x)", "0", "oo")])
def test_divergent_integral_does_not_become_a_principal_value(expression, lower, upper):
    result = math_tool.compute("integrate", expression, lower=lower, upper=upper)
    assert result["status"] == "divergent"
    assert result["approx"] is None


def test_unresolved_integral_and_other_variable():
    unresolved = math_tool.compute("integrate", "sin(sin(x))")
    assert unresolved["status"] == "unevaluated"
    assert unresolved["approx"] is None
    assert "Integral" in unresolved["exact"]
    assert math_tool.compute("integrate", "t**2", "t")["exact"] == "t**3/3"
    assert math_tool.compute("limit", "sin(y)/y", "y", point="0")["exact"] == "1"


@pytest.mark.parametrize("operation,extra", [
    ("integrate", {"lower": "0"}), ("integrate", {"upper": "1"}),
    ("integrate", {"lower": "x", "upper": "1"}),
    ("integrate", {"lower": "sqrt(-1)", "upper": "1"}),
    ("integrate", {"lower": "__import__('os')", "upper": "1"}),
    ("limit", {}), ("limit", {"point": "x"}), ("limit", {"point": "1/0"}),
    ("limit", {"point": "0", "side": "up"}),
    ("evaluate", {"lower": "0", "upper": "1"}),
    ("differentiate", {"point": "0"}), ("integrate", {"point": "0"}),
])
def test_calculus_rejects_mismatched_or_invalid_arguments(operation, extra):
    with pytest.raises(ValueError):
        math_tool.compute(operation, "1", **extra)


def test_worker_timeout_terminates_the_real_process(monkeypatch):
    run = subprocess.run
    popen = subprocess.Popen
    children = []

    def observe_child(*args, **kwargs):
        child = popen(*args, **kwargs)
        children.append(child)
        return child

    def slow_worker(command, **kwargs):
        return run([sys.executable, "-c", "import time; time.sleep(30)"], **{**kwargs, "timeout": 0.1})

    monkeypatch.setattr(subprocess, "Popen", observe_child)
    monkeypatch.setattr(subprocess, "run", slow_worker)
    with pytest.raises(ValueError, match="did not finish"):
        math_tool.compute("integrate", "x")
    assert len(children) == 1 and children[0].poll() is not None


def test_ui_and_agent_return_identical_results_and_preserve_study_bank(client):
    client.services.store.put("subject", {"id": "qa-calculus", "name": "Synthetic calculus"})

    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(row) for row in client.services.db.conn.execute("SELECT * FROM " + name)]
                    for name in ("records", "reviews", "tombstones", "kv")}

    before = snapshot()
    arguments = {"operation": "integrate", "expression": "x**2", "lower": "0", "upper": "1"}
    ui = client.post("/api/math/compute", json=arguments)
    assert ui.status_code == 200, ui.text
    agent = client.post("/api/agent/call", headers={"Authorization": "Bearer " + client.services.token},
                        json={"name": "math_compute", "arguments": arguments})
    assert agent.status_code == 200 and agent.json() == ui.json()
    assert ui.json()["exact"] == "1/3"
    assert snapshot() == before
    bad = client.post("/api/math/compute", json={**arguments, "upper": "x"})
    assert bad.status_code == 400 and "constant" in bad.json()["error"]
    invalid = client.post("/api/math/compute", json={"operation": "limit", "expression": "x", "side": "up"})
    assert invalid.status_code == 400
    catalog = {entry["name"]: entry for entry in tool_catalog()}
    assert {"integrate", "limit"} <= set(catalog["math_compute"]["inputSchema"]["properties"]["operation"]["enum"])
