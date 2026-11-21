import pytest
from hoardtest import EXPECTED_TOOL_COUNT
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import descriptive_statistics


def test_exact_statistics_population_sample_and_single_observation():
    result = descriptive_statistics(['1/2', '1', '1.5'])
    assert result['values_exact'] == ['1/2', '1', '3/2']
    assert result['mean']['exact'] == result['median']['exact'] == '1'
    assert result['squared_deviations']['exact'] == '1/2'
    assert result['population']['variance']['exact'] == '1/6'
    assert result['population']['standard_deviation']['exact'] == 'sqrt(6)/6'
    assert result['sample']['variance']['exact'] == '1/4'
    assert result['sample']['standard_deviation']['exact'] == '1/2'
    assert (result['population']['denominator'], result['sample']['denominator']) == (3, 2)
    even = descriptive_statistics(['4', '-2', '4', '0'])
    assert even['mean']['exact'] == '3/2' and even['median']['exact'] == '2'
    assert even['minimum']['exact'] == '-2' and even['range']['exact'] == '6'
    one = descriptive_statistics(['0.1234567890123456789'])
    assert one['mean']['exact'] == '1234567890123456789/10000000000000000000'
    assert one['sample'] is None and one['population']['variance']['exact'] == '0'
    for bad in ([], ['1', 'NaN'], ['1/0'], ['x'], ['1+2']):
        with pytest.raises(ValueError):
            descriptive_statistics(bad)


def test_statistics_http_agent_and_native_contract_preserve_bank(client):
    def snapshot():
        return {t: [tuple(r) for r in client.services.db.conn.execute('SELECT * FROM '+t)]
                for t in ('records', 'reviews', 'tombstones', 'kv')}
    before = snapshot()
    args = {'values': ['9007199254740993', '9007199254740995']}
    ui = client.post('/api/math/statistics', json=args)
    agent = client.post('/api/agent/call', headers={'Authorization':'Bearer '+client.services.token},
                        json={'name':'math_statistics','arguments':args})
    assert ui.status_code == agent.status_code == 200
    assert ui.json() == agent.json() == call_tool(client.services, 'math_statistics', args)
    assert ui.json()['mean']['exact'] == '9007199254740994'
    assert ui.json()['population']['variance']['exact'] == '1'
    assert ui.json()['sample']['variance']['exact'] == '2'
    bad = client.post('/api/math/statistics', json={'values':['1','nan']})
    assert bad.status_code == 400 and 'Observation 2' in bad.json()['error']
    assert snapshot() == before
    catalog = {t['name']:t for t in tool_catalog()}
    assert len(catalog) == EXPECTED_TOOL_COUNT and catalog['math_statistics']['annotations']['readOnlyHint']
