from fractions import Fraction

import pytest

from hoardtest import EXPECTED_TOOL_COUNT
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import polynomial_division, polynomial_gcd
from test_math_polynomial_division import rational_value


def test_monic_common_divisor_lcm_and_independent_bezout_identity():
    cases = [('x**3-x', 'x**2-1', 'x', 'x**2 - 1', 'x**3 - x'),
             ('2*t**2-2', '4*t-4', 't', 't - 1', 't**2 - 1'),
             ('0.1*y+0.2', '0.3*y+0.6', 'y', 'y + 2', 'y + 2'),
             ('x**2+1', 'x+1', 'x', '1', 'x**3 + x**2 + x + 1'),
             ('0', '-2*x+4', 'x', 'x - 2', '0'),
             ('3*t+9', '0', 't', 't + 3', '0'),
             ('2', '3', 'x', '1', '1'), ('0', '0', 'x', '0', '0')]
    for a, b, variable, gcd, lcm in cases:
        out = polynomial_gcd(a, b, variable)
        assert out['gcd']['exact'] == gcd and out['lcm']['exact'] == lcm
        assert out['verified'] and out['residual'] == '0'
        assert out['gcd']['degree'] is None if gcd == '0' else out['gcd']['degree'] >= 0
        for point in map(Fraction, ('-3', '0', '2', '1/3')):
            assert (rational_value(a, variable, point) * rational_value(out['u']['exact'], variable, point)
                    + rational_value(b, variable, point) * rational_value(out['v']['exact'], variable, point)
                    == rational_value(gcd, variable, point))
        if gcd != '0':
            assert polynomial_division(a, gcd, variable)['remainder']['exact'] == '0'
            assert polynomial_division(b, gcd, variable)['remainder']['exact'] == '0'
        for nonzero in (a, b):
            if nonzero != '0':
                assert polynomial_division(lcm, nonzero, variable)['remainder']['exact'] == '0'


def test_existing_polynomial_grammar_is_preserved():
    for a, b, variable in [('1/x', 'x', 'x'), ('sin(x)', 'x', 'x'), ('sqrt(2)*x', 'x', 'x'),
                           ('x+y', 'x', 'x'), ('x**-1', 'x', 'x'), ('x', 'x', 'z')]:
        with pytest.raises(ValueError):
            polynomial_gcd(a, b, variable)


def test_api_agent_catalog_and_no_study_mutation(client):
    db = client.services.db.conn
    def snapshot():
        return {n: sorted([tuple(r) for r in db.execute('SELECT * FROM "' + n + '"')], key=repr)
                for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before = snapshot()
    args = {'a': 't**3-t', 'b': 't**2-1', 'variable': 't'}
    api = client.post('/api/math/polynomial-gcd', json=args)
    agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer ' + client.services.token},
                        json={'name': 'math_polynomial_gcd', 'arguments': args})
    assert api.status_code == agent.status_code == 200
    assert api.json() == agent.json() == call_tool(client.services, 'math_polynomial_gcd', args)
    for invalid in ({'a': 'x', 'b': 'sin(x)'}, {'a': 3, 'b': 'x'}, {}):
        assert client.post('/api/math/polynomial-gcd', json=invalid).status_code == 400
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert len(catalog) == EXPECTED_TOOL_COUNT and catalog['math_polynomial_gcd']['annotations']['readOnlyHint']
    assert snapshot() == before
