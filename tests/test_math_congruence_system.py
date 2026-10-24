import math
import pytest
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import congruence_system


def conditions(pairs):
    return [{"residue": str(r), "modulus": str(m)} for r, m in pairs]


def test_complete_system_families_against_independent_enumeration():
    for pairs in (((2, 6), (5, 9)), ((2, 3), (3, 5), (2, 7)), ((2, 6), (4, 9)),
                  ((-1, -6), (5, 9)), ((0, -1), (8, 1)), ((-17, -5),),
                  ((2, 6), (2, 6), (5, -9))):
        result = congruence_system(conditions(pairs))
        period = math.lcm(*(abs(m) for _, m in pairs))
        actual = [n for n in range(period) if all((n - r) % abs(m) == 0 for r, m in pairs)]
        assert result['verified']
        if actual:
            assert result['status'] == 'solved'
            assert actual == [int(result['residue'])]
            assert int(result['period']) == period
            assert result['all_integers'] == (period == 1)
            for k in (-3, 0, 4):
                assert all((int(result['residue']) + k * period - r) % abs(m) == 0 for r, m in pairs)
            for check in result['checks']:
                assert check['actual'] == check['expected'] and check['period_remainder'] == '0'
        else:
            assert result['status'] == 'no_solution' and result['residue'] is result['period'] is None
            conflict = result['conflict']
            assert 0 < conflict['index'] < len(pairs)
            common = math.gcd(int(conflict['prior_period']), abs(pairs[conflict['index']][1]))
            assert int(conflict['gcd']) == common
            assert int(conflict['compatibility_remainder']) == int(conflict['difference']) % common != 0


def test_large_exact_strings_normalization_and_invalid_entries():
    n = 9007199254740993
    raw = [{'residue': ' +000' + str(n), 'modulus': '-' + str(n + 2)},
           {'residue': str(n), 'modulus': str(n + 4)}]
    result = congruence_system(raw)
    assert result['residue'] == str(n)
    assert result['period'] == str((n + 2) * (n + 4))
    assert result['constraints'][0]['residue'] == raw[0]['residue']
    assert result['constraints'][0]['modulus_exact'] == str(n + 2)
    for invalid in ('1/2', '1.0', '1e3', '1_000', '١٢', '', 2):
        with pytest.raises(ValueError):
            congruence_system([{'residue': invalid, 'modulus': '7'}])
    for invalid in ([], [{'residue': '1', 'modulus': '0'}],
                    conditions(((2, 6), (4, 9))) + [{'residue': 'bad', 'modulus': '7'}]):
        with pytest.raises(ValueError):
            congruence_system(invalid)


def test_system_api_agent_and_direct_contract_keep_all_study_tables(client):
    def snapshot():
        db = client.services.db.conn
        return {name: sorted([tuple(row) for row in db.execute('SELECT * FROM "' + name + '"')], key=repr)
                for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before = snapshot()
    for pairs in (((2, 6), (5, 9)), ((2, 6), (4, 9))):
        args = {'constraints': conditions(pairs)}
        api = client.post('/api/math/congruence-system', json=args)
        agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer ' + client.services.token},
                            json={'name': 'math_congruence_system', 'arguments': args})
        assert api.status_code == agent.status_code == 200
        assert api.json() == agent.json() == call_tool(client.services, 'math_congruence_system', args)
    for args in ({'constraints': []}, {'constraints': [{'residue': 2, 'modulus': '3'}]},
                 {'constraints': [{'residue': '2', 'modulus': '0'}]}):
        assert client.post('/api/math/congruence-system', json=args).status_code == 400
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert len(catalog) == 71 and catalog['math_congruence_system']['annotations']['readOnlyHint']
    assert snapshot() == before
