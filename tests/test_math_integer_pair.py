import math
import pytest
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import integer_pair


def test_extended_euclid_signs_zeros_large_integers_and_divisions():
    for a, b in ((240, 46), (-240, 46), (240, -46), (-240, -46), (0, -7), (-7, 0), (0, 0),
                 (9007199254740993, 9007199254740995)):
        value = integer_pair(str(a), str(b))
        assert value['gcd'] == str(math.gcd(a, b)) and value['lcm'] == str(math.lcm(a, b))
        assert a * int(value['bezout']['x']) + b * int(value['bezout']['y']) == int(value['gcd'])
        assert value['verified'] and value['both_zero'] == (a == b == 0)
        remaining = (abs(a), abs(b))
        for step in value['steps']:
            dividend, divisor, quotient, remainder = (int(step[k]) for k in ('dividend', 'divisor', 'quotient', 'remainder'))
            assert (dividend, divisor) == remaining and dividend == divisor * quotient + remainder
            assert 0 <= remainder < divisor
            remaining = (divisor, remainder)
        assert remaining == (math.gcd(a, b), 0)
    for bad in ('1/2', '1.0', '1e3', '1+2', '0xff', 'NaN', '', '1_000', '١٢'):
        with pytest.raises(ValueError):
            integer_pair(bad, '46')


def test_integer_pair_api_agent_contract_and_bank_preservation(client):
    def snapshot():
        return {name: [tuple(row) for row in client.services.db.conn.execute('SELECT * FROM '+name)]
                for name in ('records', 'reviews', 'tombstones', 'kv')}
    before = snapshot()
    args = {'a': ' -9007199254740993 ', 'b': '+46'}
    api = client.post('/api/math/integer-pair', json=args)
    agent = client.post('/api/agent/call', headers={'Authorization': 'Bearer '+client.services.token},
                        json={'name': 'math_integer_pair', 'arguments': args})
    assert api.status_code == agent.status_code == 200
    assert api.json() == agent.json() == call_tool(client.services, 'math_integer_pair', args)
    assert api.json()['a_exact'] == '-9007199254740993'
    assert client.post('/api/math/integer-pair', json={'a': '1/2', 'b': '3'}).status_code == 400
    assert client.post('/api/math/integer-pair', json={'a': 240, 'b': '46'}).status_code == 400
    assert snapshot() == before
    catalog = {tool['name']: tool for tool in tool_catalog()}
    assert len(catalog) == 67 and catalog['math_integer_pair']['annotations']['readOnlyHint']
