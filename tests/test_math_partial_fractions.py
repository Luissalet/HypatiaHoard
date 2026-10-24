from fractions import Fraction

import pytest

from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import partial_fractions
from test_math_polynomial_division import rational_value


def test_exact_decomposition_and_independent_values_keep_original_domain():
    cases = [('x+3', '(x-1)*(x+1)', 'x'), ('x**3+2', 'x**2-1', 'x'),
             ('1', '(t-1)**2*(t+2)', 't'), ('0.1*y+0.2', 'y*(y+1)', 'y'),
             ('1', 'x**2-2', 'x'), ('x**2-1', 'x-1', 'x'), ('0', 'x-1', 'x'), ('3*x+2', '2', 'x')]
    for numerator, denominator, variable in cases:
        out = partial_fractions(numerator, denominator, variable)
        assert out['verified'] and out['residual'] == '0'
        assert out['domain_restriction'] == f"({out['denominator_normalized']['exact']}) != 0"
        for point in map(Fraction, ('-3', '0', '2', '1/3')):
            den = rational_value(denominator, variable, point)
            if den == 0:
                continue
            expected = rational_value(numerator, variable, point) / den
            assert rational_value(out['decomposition']['exact'], variable, point) == expected
            assert (rational_value(out['polynomial_part']['exact'], variable, point)
                    + rational_value(out['proper_part']['exact'], variable, point)) == expected
    cancelled = partial_fractions('x**2-1', 'x-1')
    assert cancelled['decomposition']['exact'] == 'x + 1' and cancelled['domain_restriction'] == '(x - 1) != 0'
    assert partial_fractions('0', 'x-1')['domain_restriction'] == '(x - 1) != 0'
    assert partial_fractions('1', 'x**2-2')['decomposition']['exact'] == '1/(x**2 - 2)'


def test_zero_denominator_and_existing_qq_grammar():
    for numerator, denominator, variable in [('1', '0', 'x'), ('x', 'x-x', 'x'), ('1/x', 'x', 'x'),
                                             ('sin(x)', 'x', 'x'), ('sqrt(2)*x', 'x', 'x'),
                                             ('x+y', 'x', 'x'), ('x', 'x', 'z')]:
        with pytest.raises(ValueError):
            partial_fractions(numerator, denominator, variable)


def test_api_agent_match_and_preserve_study_tables(client):
    db = client.services.db.conn
    def snapshot():
        return {n: sorted([tuple(r) for r in db.execute('SELECT * FROM "'+n+'"')],key=repr)
                for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before = snapshot()
    args = {'numerator': 't**2-1', 'denominator': 't-1', 'variable': 't'}
    api = client.post('/api/math/partial-fractions', json=args)
    agent = client.post('/api/agent/call', headers={'Authorization':'Bearer '+client.services.token},
                        json={'name':'math_partial_fractions','arguments':args})
    assert api.status_code == agent.status_code == 200
    assert api.json() == agent.json() == call_tool(client.services,'math_partial_fractions',args)
    for invalid in ({'numerator':'x','denominator':'0'}, {'numerator':3,'denominator':'x'}, {}):
        assert client.post('/api/math/partial-fractions',json=invalid).status_code == 400
    catalog = {tool['name']:tool for tool in tool_catalog()}
    assert len(catalog) == 70 and catalog['math_partial_fractions']['annotations']['readOnlyHint']
    assert snapshot() == before
