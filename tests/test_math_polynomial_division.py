import ast
from fractions import Fraction

import pytest

from hypatia.agent_tools import TOOLS_BY_NAME, call_tool, tool_catalog
from hypatia.math_tool import polynomial_division


def rational_value(source, variable, point):
    def visit(node):
        if isinstance(node, ast.Constant):
            return Fraction(ast.get_source_segment(source, node))
        if isinstance(node, ast.Name) and node.id == variable:
            return point
        if isinstance(node, ast.UnaryOp):
            return -visit(node.operand) if isinstance(node.op, ast.USub) else visit(node.operand)
        left, right = visit(node.left), visit(node.right)
        if isinstance(node.op, ast.Add): return left + right
        if isinstance(node.op, ast.Sub): return left - right
        if isinstance(node.op, ast.Mult): return left * right
        if isinstance(node.op, ast.Div): return left / right
        if isinstance(node.op, ast.Pow): return left ** int(right)
        raise AssertionError('Unexpected polynomial output')
    return visit(ast.parse(source, mode='eval').body)


def test_quotient_remainder_against_known_results_and_independent_fraction_identity():
    cases = [('x**3+2', 'x**2+1', 'x', 'x', '2 - x'),
             ('x**3-1', 'x-1', 'x', 'x**2 + x + 1', '0'),
             ('0', 'x+1', 'x', '0', '0'), ('x', 'x**2+1', 'x', '0', 'x'),
             ('y**2+1/3', '2', 'y', 'y**2/2 + 1/6', '0'),
             ('0.1*t+0.2', 't+1', 't', '1/10', '1/10'),
             ('5*x**2+10*x+3', '2*x+2', 'x', '5*x/2 + 5/2', '-2')]
    for a, b, variable, quotient, remainder in cases:
        result = polynomial_division(a, b, variable)
        assert result['dividend'] == a and result['divisor'] == b and result['variable'] == variable
        assert result['quotient']['exact'] == quotient and result['remainder']['exact'] == remainder
        assert result['verified'] and result['residual'] == '0'
        assert result['exact_division'] == (remainder == '0')
        degree = result['remainder']['degree']
        assert degree is None if remainder == '0' else degree < result['divisor_normalized']['degree']
        for point in map(Fraction, ('-3', '0', '2', '1/3')):
            assert rational_value(a, variable, point) == rational_value(b, variable, point) * rational_value(quotient, variable, point) + rational_value(remainder, variable, point)


def test_zero_divisor_and_non_rational_polynomials_keep_existing_grammar():
    for a, b, variable in [('x', '0', 'x'), ('x', 'x-x', 'x'), ('1/x', 'x', 'x'),
                           ('sin(x)', 'x', 'x'), ('sqrt(2)*x', 'x', 'x'),
                           ('x+y', 'x', 'x'), ('x**-1', 'x', 'x'), ('x', 'x', 'z')]:
        with pytest.raises(ValueError):
            polynomial_division(a, b, variable)


def test_api_agent_catalog_and_study_table_preservation(client):
    def snapshot():
        db = client.services.db.conn
        return {n: sorted([tuple(r) for r in db.execute('SELECT * FROM "' + n + '"')], key=repr)
                for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before = snapshot()
    for args in ({'dividend': 'x**3+2', 'divisor': 'x**2+1'},
                 {'dividend': '0.1*t+0.2', 'divisor': 't+1', 'variable': 't'}):
        api = client.post('/api/math/polynomial-division', json=args)
        agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer ' + client.services.token},
                            json={'name': 'math_polynomial_division', 'arguments': args})
        assert api.status_code == agent.status_code == 200
        assert api.json() == agent.json() == call_tool(client.services, 'math_polynomial_division', args)
    for args in ({'dividend': 'x', 'divisor': '0'}, {'dividend': 'x', 'divisor': 'sin(x)'},
                 {'dividend': 3, 'divisor': 'x'}, {}):
        assert client.post('/api/math/polynomial-division', json=args).status_code == 400
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert catalog.keys() == TOOLS_BY_NAME.keys() and catalog['math_polynomial_division']['annotations']['readOnlyHint']
    assert snapshot() == before
