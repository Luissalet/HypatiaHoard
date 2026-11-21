import math
import pytest
from hypatia.agent_tools import TOOLS_BY_NAME, call_tool, tool_catalog
from hypatia.math_tool import linear_congruence


def test_complete_congruence_families_and_incompatibility():
    for a, b, m in ((35, 14, 28), (6, 5, 9), (-35, 14, -28), (35, -14, 28),
                    (0, 0, 7), (0, 14, 7), (0, 1, 7), (9, 2, 1), (3, 1, -11),
                    (9007199254740993, 1, 9007199254740995)):
        r = linear_congruence(str(a), str(b), str(m))
        g = math.gcd(a, m)
        assert r['gcd'] == str(g) and r['modulus_exact'] == str(abs(m)) and r['verified']
        assert a * int(r['bezout']['x']) + abs(m) * int(r['bezout']['y']) == g
        if b % g:
            assert r['status'] == 'no_solution' and r['residue'] is r['period'] is None
            assert r['compatibility_remainder'] == str(b % g) and r['residue_count'] == '0'
        else:
            residue, period = int(r['residue']), int(r['period'])
            assert r['status'] == 'solved' and 0 <= residue < period == abs(m) // g
            assert r['residue_count'] == str(g) and r['all_integers'] == (period == 1)
            for k in (-2, 0, 3):
                assert (a * (residue + k * period) - b) % abs(m) == 0
        if abs(m) < 30:
            actual = [x for x in range(abs(m)) if (a * x - b) % abs(m) == 0]
            expected = [] if b % g else [int(r['residue']) + k * int(r['period']) for k in range(g)]
            assert actual == expected
    assert linear_congruence('35', '14', '28')['residue'] == '2'
    for bad in ('1/2', '1.0', '1e3', '1_000', '١٢', ''):
        with pytest.raises(ValueError):
            linear_congruence('35', bad, '28')
    with pytest.raises(ValueError, match='zero'):
        linear_congruence('35', '14', '0')


def test_congruence_api_mcp_contract_and_bank_preservation(client):
    def snapshot():
        return {name: [tuple(row) for row in client.services.db.conn.execute('SELECT * FROM '+name)]
                for name in ('records', 'reviews', 'tombstones', 'kv')}
    before = snapshot()
    for args in ({'a': ' -9007199254740993 ', 'b': '+1', 'modulus': '-9007199254740995'},
                 {'a': '6', 'b': '5', 'modulus': '9'}):
        api = client.post('/api/math/linear-congruence', json=args)
        agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer '+client.services.token},
                            json={'name': 'math_linear_congruence', 'arguments': args})
        assert api.status_code == agent.status_code == 200
        assert api.json() == agent.json() == call_tool(client.services, 'math_linear_congruence', args)
    for args in ({'a': 35, 'b': '14', 'modulus': '28'}, {'a': '35', 'b': '14', 'modulus': '0'}):
        assert client.post('/api/math/linear-congruence', json=args).status_code == 400
    assert snapshot() == before
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert catalog.keys() == TOOLS_BY_NAME.keys() and catalog['math_linear_congruence']['annotations']['readOnlyHint']
