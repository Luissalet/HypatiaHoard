"""Integer strings stay exact through every supported output radix."""

import pytest
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import convert_base


def test_large_signed_values_prefixes_and_roundtrip():
    result = convert_base('9007199254740993', 10, 16)
    assert result['result'] == '20000000000001' and result['decimal'] == '9007199254740993'
    assert result['verified']
    for base in range(2, 37):
        encoded = convert_base('-9007199254740993', 10, base)['result']
        assert convert_base(encoded, base, 10)['result'] == '-9007199254740993'
    for source, base, expected in [('  +0xff ',16,'255'), ('0b1111_0000',2,'240'), ('0o17',8,'15'), ('z',36,'35'), ('-0',10,'0')]:
        assert convert_base(source,base,10)['result'] == expected
    assert convert_base('-101010',2,10)['result'] == '-42'
    for number, base in [('2',2), ('1.5',10), ('FF',10), ('',10)]:
        with pytest.raises(ValueError):
            convert_base(number,base,10)


def test_base_conversion_api_agent_contract_and_bank(client):
    def snapshot():
        with client.services.db.lock:
            return {name: [tuple(row) for row in client.services.db.conn.execute('SELECT * FROM '+name)]
                    for name in ('records','reviews','tombstones','kv')}
    before = snapshot()
    args = {'number':'FF', 'source_base':16, 'target_base':2}
    ui = client.post('/api/math/base-convert',json=args)
    agent = client.post('/api/agent/call',headers={'Authorization':'Bearer '+client.services.token},
                        json={'name':'math_base_convert','arguments':args})
    assert ui.status_code == agent.status_code == 200
    assert ui.json() == agent.json() == call_tool(client.services,'math_base_convert',args)
    assert ui.json()['result'] == '11111111' and snapshot() == before
    catalog = {item['name']:item for item in tool_catalog()}
    assert len(catalog) == 71 and catalog['math_base_convert']['annotations']['readOnlyHint']
    assert client.post('/api/math/base-convert',json={'number':'2','source_base':2}).status_code == 400
