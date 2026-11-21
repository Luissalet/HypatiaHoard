from fractions import Fraction

import pytest

from hypatia.agent_tools import TOOLS_BY_NAME, call_tool, tool_catalog
from hypatia.math_tool import rational_taylor
from test_math_polynomial_division import rational_value


def test_known_taylor_coefficients_and_independent_exact_remainder_identity():
    cases = [('1','1-x','0',3,'x',['1']*4),
             ('1','1-x','1/2',3,'x',['2','4','8','16']),
             ('1','(1-t)**2','0',4,'t',['1','2','3','4','5']),
             ('x**2','1','2',3,'x',['4','4','1','0']),
             ('1','1+y','-1/2',3,'y',['2','-4','8','-16']),
             ('x**2-1','x-1','0',3,'x',['1','1','0','0']),
             ('0','x-1','0',0,'x',['0'])]
    for numerator,denominator,center,order,variable,coefficients in cases:
        result = rational_taylor(numerator,denominator,center,order,variable)
        assert result['verified'] and result['residual']=='0'
        assert [r['exact'] for r in result['coefficients']]==coefficients
        assert [r['power'] for r in result['coefficients']]==list(range(order+1))
        assert result['domain_restriction']==f"({result['denominator_normalized']['exact']}) != 0"
        for point in map(Fraction, ('-2','0','2','3/7')):
            den=rational_value(denominator,variable,point)
            if den==0:continue
            poly=rational_value(result['polynomial']['exact'],variable,point)
            rem=rational_value(result['remainder']['exact'],variable,point)
            assert poly+rem==rational_value(numerator,variable,point)/den
            assert poly==rational_value(result['centered_polynomial']['exact'],variable,point)
            assert poly==sum(Fraction(c)*(point-Fraction(center))**k for k,c in enumerate(coefficients))
            assert rem==(point-Fraction(center))**(order+1)*rational_value(result['remainder_factor']['exact'],variable,point)/den
    assert rational_taylor('0','x-1')['domain_restriction']=='(x - 1) != 0'
    centered=rational_taylor('1','1-x','1/2',3)['centered_polynomial']['exact']
    assert '4*(x - 1/2)' in centered and ' + 2' in centered
    assert len(rational_taylor('0.1*t+0.2','2','0.5',12,'t')['coefficients'])==13


def test_original_domain_center_and_existing_qq_grammar():
    for args in [dict(numerator='1',denominator='0'), dict(numerator='x**2-1',denominator='x-1',center='1'),
                 dict(numerator='0',denominator='x-1',center='1'),dict(numerator='sin(x)',denominator='1'),
                 dict(numerator='1/x',denominator='1'),dict(numerator='sqrt(2)*x',denominator='1'),
                 dict(numerator='x+y',denominator='1'),dict(numerator='1',denominator='1',center='pi'),
                 dict(numerator='1',denominator='1',center='1/0'),dict(numerator='1',denominator='1',order=13),
                 dict(numerator='1',denominator='1',order=True),dict(numerator='1',denominator='1',variable='z')]:
        with pytest.raises(ValueError):rational_taylor(**args)


def test_api_agent_match_and_preserve_study_tables(client):
    db=client.services.db.conn
    def snapshot():
        return {n:sorted([tuple(r) for r in db.execute('SELECT * FROM "'+n+'"')],key=repr)
                for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}
    before=snapshot();args={'numerator':'1','denominator':'1-t','center':'1/2','order':3,'variable':'t'}
    api=client.post('/api/math/rational-taylor',json=args)
    agent=client.post('/api/agent/call',headers={'Authorization':'Bearer '+client.services.token},json={'name':'math_rational_taylor','arguments':args})
    assert api.status_code==agent.status_code==200
    assert api.json()==agent.json()==call_tool(client.services,'math_rational_taylor',args)
    for invalid in ({'numerator':'x','denominator':'0'}, {'numerator':3,'denominator':'1'}, {'numerator':'1','denominator':'1','order':1.5}, {}):
        assert client.post('/api/math/rational-taylor',json=invalid).status_code==400
    catalog={t['name']:t for t in tool_catalog()}
    assert catalog.keys() == TOOLS_BY_NAME.keys() and catalog['math_rational_taylor']['annotations']['readOnlyHint']
    assert snapshot()==before
