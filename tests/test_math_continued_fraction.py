from fractions import Fraction

import pytest

from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import continued_fraction


def test_convergents_reconstruct_rationals_with_independent_recurrence():
    for value in ('355/113', '-3/8', '0', '-7', '0.125', '9007199254740993/9007199254740995'):
        result = continued_fraction(value)
        assert result['input'] == value and result['exact'] == str(Fraction(value))
        terms = [int(term) for term in result['coefficients']]
        assert terms and all(term > 0 for term in terms[1:])
        p0, p1, q0, q1 = 0, 1, 1, 0
        for term, convergent in zip(terms, result['convergents'], strict=True):
            p0, p1, q0, q1 = p1, term * p1 + p0, q1, term * q1 + q0
            assert convergent == str(Fraction(p1, q1))
        reconstructed = Fraction(terms[-1])
        for term in reversed(terms[:-1]):
            reconstructed = term + 1 / reconstructed
        assert reconstructed == Fraction(value)
        assert result['reconstructed'] == str(reconstructed) and result['verified']
    result = continued_fraction('355/113')
    assert result['coefficients'] == ['3', '7', '16']
    assert result['convergents'] == ['3', '22/7', '355/113']
    assert result['notation'] == '[3; 7, 16]'
    assert continued_fraction('-3/8')['coefficients'] == ['-1', '1', '1', '1', '2']
    assert continued_fraction('0')['notation'] == '[0]'


def test_existing_literal_contract_preserves_original_and_rejects_nonrationals():
    assert continued_fraction(' +000.125 ')['input'] == ' +000.125 '
    assert continued_fraction(' +000.125 ')['exact'] == '1/8'
    for value in ('pi', 'sqrt(2)', '1/0', '3/-8', 'NaN', 'Infinity', '', '1e-101', 3):
        with pytest.raises(ValueError):
            continued_fraction(value)


def test_api_agent_and_catalog_preserve_all_study_tables(client):
    def snapshot():
        db = client.services.db.conn
        return {name: sorted([tuple(row) for row in db.execute('SELECT * FROM "' + name + '"')], key=repr)
                for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before = snapshot()
    for value in ('355/113', '-3/8', '9007199254740993/9007199254740995'):
        args = {'value': value}
        api = client.post('/api/math/continued-fraction', json=args)
        agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer ' + client.services.token},
                            json={'name': 'math_continued_fraction', 'arguments': args})
        assert api.status_code == agent.status_code == 200
        assert api.json() == agent.json() == call_tool(client.services, 'math_continued_fraction', args)
    for args in ({'value': 'pi'}, {'value': '1/0'}, {'value': 3}, {}):
        assert client.post('/api/math/continued-fraction', json=args).status_code == 400
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert len(catalog) == 67 and catalog['math_continued_fraction']['annotations']['readOnlyHint']
    assert snapshot() == before
