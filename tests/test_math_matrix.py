"""Rational matrix operations with explicit singular and rectangular outcomes."""

import pytest
from hypatia.agent_tools import call_tool, tool_catalog
from hypatia.math_tool import matrix_calculate


def test_exact_inverse_singular_and_rectangular_reduction():
    source = [['1','2'],['3','4']]
    inverse = matrix_calculate(source)
    assert inverse['determinant_exact'] == '-2'
    assert inverse['inverse_exact'] == [['-2','1'],['3/2','-1/2']]
    assert inverse['residuals_exact'] == [['0','0'],['0','0']] and inverse['verified']
    assert source == [['1','2'],['3','4']]
    assert matrix_calculate([['0.1']])['inverse_exact'] == [['10']]
    precise = matrix_calculate([['0.1234567890123456789']],'determinant')
    assert precise['determinant_exact'] == '1234567890123456789/10000000000000000000'
    singular = matrix_calculate([['1','2'],['2','4']])
    assert singular['status'] == 'singular' and singular['inverse_exact'] is None and singular['verified'] is None
    reduced = matrix_calculate([['1','2','3'],['2','4','6']],'rref')
    assert reduced['rref_exact'] == [['1','2','3'],['0','0','0']]
    assert reduced['rank'] == 1 and reduced['pivot_columns_one_based'] == [1]
    zero = matrix_calculate([['0','0'],['0','0']],'rref')
    assert zero['rank'] == 0 and zero['pivot_columns_one_based'] == []
    for matrix in ([], [['1'],['2','3']], [['1/0']], [['pi']]):
        with pytest.raises(ValueError):
            matrix_calculate(matrix)
    with pytest.raises(ValueError,match='square'):
        matrix_calculate([['1','2']])


def test_matrix_api_agent_parity_and_bank_unchanged(client):
    def snapshot():
        with client.services.db.lock:
            return {t:[tuple(row) for row in client.services.db.conn.execute('SELECT * FROM '+t)]
                    for t in ('records','reviews','tombstones','kv')}
    before = snapshot()
    args = {'matrix':[['1/2','1/3'],['2','3']],'operation':'inverse'}
    ui = client.post('/api/math/matrix',json=args)
    agent = client.post('/api/agent/call',headers={'Authorization':'Bearer '+client.services.token},json={'name':'math_matrix','arguments':args})
    assert ui.status_code == agent.status_code == 200
    assert ui.json() == agent.json() == call_tool(client.services,'math_matrix',args)
    assert ui.json()['verified'] and before == snapshot()
    catalog = {t['name']:t for t in tool_catalog()}
    assert len(catalog) == 69 and catalog['math_matrix']['annotations']['readOnlyHint']
    assert client.post('/api/math/matrix',json={'matrix':[['1','2']],'operation':'determinant'}).status_code == 400
