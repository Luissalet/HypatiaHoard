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
