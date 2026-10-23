import { useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';
import { LinearSystemPanel } from '@/ui/components/LinearSystemPanel';
import { ValueTablePanel } from '@/ui/components/ValueTablePanel';
import { InterpolationPanel } from '@/ui/components/InterpolationPanel';
import { BaseConversionPanel } from '@/ui/components/BaseConversionPanel';
import { MatrixPanel } from '@/ui/components/MatrixPanel';

type Operation = 'evaluate' | 'expand' | 'factor' | 'solve' | 'differentiate' | 'integrate' | 'limit';
type Value = { exact: string; latex: string; approx: string | null };
type Result = Partial<Value> & {
  operation: Operation;
  expression: string;
  variable: string;
  status?: 'evaluated' | 'infinite' | 'divergent' | 'nonexistent' | 'unevaluated';
  integration_constant?: string | null;
  solutions?: Value[];
  all_values?: boolean;
  left?: Value;
  right?: Value;
};

const EXAMPLES: Record<Operation, { expression: string; lower?: string; upper?: string; point?: string }> = {
  evaluate: { expression: '1/3 + 1/6' },
  expand: { expression: '(x+2)*(x-3)' },
  factor: { expression: 'x**3-x**2+x-1' },
  solve: { expression: 'x**2 - 2 = 0' },
  differentiate: { expression: 'sin(x) + x**3' },
  integrate: { expression: 'exp(-x)', lower: '0', upper: 'oo' },
  limit: { expression: 'sin(x)/x', point: '0' },
};

function MathValue({ value, constant = false }: { value: Partial<Value>; constant?: boolean }) {
  return <div className="min-w-0 space-y-2">
    {value.latex && <MdContent content={`$$${value.latex}${constant ? ' + C' : ''}$$`} className="overflow-x-auto text-ink-100" />}
    <p className="font-mono text-sm break-words text-ink-200">{value.exact}{constant ? ' + C' : ''}</p>
    {value.approx && <p className="text-sm text-ink-300">Aproximación: {value.approx}</p>}
  </div>;
}

export function ExactMathPanel() {
  const [operation, setOperation] = useState<Operation>('evaluate');
  const [expression, setExpression] = useState('');
  const [variable, setVariable] = useState('x');
  const [definite, setDefinite] = useState(false);
  const [lower, setLower] = useState('0');
  const [upper, setUpper] = useState('1');
  const [point, setPoint] = useState('0');
  const [side, setSide] = useState('both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState('');

  function clearResult() { setResult(null); setError(''); setCopied(''); }

  function example() {
    const sample = EXAMPLES[operation];
    setExpression(sample.expression.replace(/\bx\b/g, variable));
    setDefinite(Boolean(sample.lower));
    setLower(sample.lower ?? '0'); setUpper(sample.upper ?? '1');
    setPoint(sample.point ?? '0'); setSide('both'); clearResult();
  }

  async function calculate(event: FormEvent) {
    event.preventDefault(); clearResult(); setBusy(true);
    try {
      const body = { operation, expression, variable,
        ...(operation === 'integrate' && definite ? { lower, upper } : {}),
        ...(operation === 'limit' ? { point, side } : {}) };
      setResult(await hoardJson<Result>('/math/compute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se ha podido calcular. Revisa la expresión e inténtalo de nuevo.');
    } finally { setBusy(false); }
  }

  const statusText = result?.status === 'divergent' ? 'La integral no converge.'
    : result?.status === 'nonexistent' ? 'El límite no existe.'
    : result?.status === 'unevaluated' ? 'El motor no ha resuelto esta expresión.'
    : result?.status === 'infinite' ? 'El límite es infinito.'
    : result?.operation === 'expand' ? 'Polinomio desarrollado'
    : result?.operation === 'factor' ? 'Polinomio factorizado' : 'Resultado exacto';
  const algebra = operation === 'expand' || operation === 'factor';
  const algebraResult = result?.operation === 'expand' || result?.operation === 'factor';

  async function copyResult() {
    if (!result || result.exact == null) return;
    const text = [statusText, `Expresión: ${result.expression}`, `Variable: ${result.variable}`,
      `Resultado: ${result.exact}`, ...(result.operation === 'factor' ? ['Factorización sobre los racionales.'] : [])].join('\n');
    try { await navigator.clipboard.writeText(text); setCopied('Resultado copiado.'); }
    catch { setCopied('No se pudo copiar. Puedes seleccionar el resultado y copiarlo manualmente.'); }
  }

  return <><details className="mb-6 border-y border-ink-700 py-3">
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Calculadora exacta
      <span className="block mt-1 text-ink-300 font-normal">Cuentas, polinomios, ecuaciones, derivadas, integrales y límites</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={clearResult}>
      <fieldset disabled={busy} className="space-y-4 min-w-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select id="math-operation" label="Operación" value={operation} onChange={e => setOperation(e.target.value as Operation)}>
            <option value="evaluate">Calcular una cuenta</option><option value="expand">Desarrollar un polinomio</option>
            <option value="factor">Factorizar un polinomio</option><option value="solve">Resolver una ecuación</option>
            <option value="differentiate">Derivar</option><option value="integrate">Integrar</option><option value="limit">Calcular un límite</option>
          </Select>
          <Select id="math-variable" label="Variable" value={variable} onChange={e => setVariable(e.target.value)}>
            <option value="x">x</option><option value="y">y</option><option value="t">t</option>
          </Select>
        </div>
        <Input id="math-expression" label="Expresión" required maxLength={200} value={expression} onChange={e => setExpression(e.target.value)}
          placeholder={EXAMPLES[operation].expression.replace(/\bx\b/g, variable)} aria-describedby={algebra ? 'math-syntax math-polynomial' : 'math-syntax'} />
        <p id="math-syntax" className="text-sm text-ink-300">{algebra
          ? 'Usa ** para potencias, punto decimal y fracciones como 1/3.'
          : 'Usa ** para potencias y punto decimal. Funciones: sqrt, sin, cos, exp y log; constantes: pi y E.'}</p>
        {algebra && <p id="math-polynomial" className="text-sm text-ink-200">
          Polinomios con coeficientes enteros, decimales o fracciones; usa denominadores constantes y potencias enteras no negativas.
          {operation === 'factor' && ' La factorización es sobre los racionales: x**2-2 permanece igual.'}
        </p>}
        {operation === 'integrate' && <>
          <label className="flex gap-2 items-center text-sm text-ink-200">
            <input type="checkbox" checked={definite} onChange={e => setDefinite(e.target.checked)} className="accent-amber-500" /> Integral definida
          </label>
          {definite ? <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input id="math-lower" label="Desde" required maxLength={200} value={lower} onChange={e => setLower(e.target.value)} />
            <Input id="math-upper" label="Hasta" required maxLength={200} value={upper} onChange={e => setUpper(e.target.value)} />
          </div> : <p className="text-sm text-ink-300">La primitiva incluye una constante arbitraria C.</p>}
          <p className="text-sm text-ink-300">Los extremos admiten pi, fracciones y oo o -oo para infinito.</p>
        </>}
        {operation === 'limit' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input id="math-point" label="Punto de llegada" required maxLength={200} value={point} onChange={e => setPoint(e.target.value)} placeholder="0, pi, oo o -oo" />
          <Select id="math-side" label="Dirección" value={side} onChange={e => setSide(e.target.value)}>
            <option value="both">Ambos lados</option><option value="left">Por la izquierda</option><option value="right">Por la derecha</option>
          </Select>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>{busy ? 'Calculando…' : 'Calcular'}</Button>
          <Button type="button" variant="secondary" onClick={example}>Cargar ejemplo</Button>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-3">
        {result && <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg text-ink-100">{statusText}</h2>
            {algebraResult && <Button type="button" variant="secondary" onClick={copyResult}>Copiar resultado</Button>}
          </div>
          {algebraResult && <dl className="text-sm text-ink-300 space-y-1">
            <dt>Expresión original · variable {result.variable}</dt>
            <dd className="font-mono text-ink-200 break-words">{result.expression}</dd>
          </dl>}
          {result.all_values ? <p className="text-ink-200">La ecuación es una identidad: se cumple para cualquier valor de {variable}.</p>
            : result.solutions ? result.solutions.length ? result.solutions.map((value, i) => <MathValue key={i} value={value} />)
              : <p className="text-ink-200">La ecuación no tiene soluciones.</p>
            : result.exact != null && <MathValue value={result} constant={Boolean(result.integration_constant)} />}
          {result.status === 'nonexistent' && result.left && result.right && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><p className="text-sm text-ink-300">Por la izquierda</p><MathValue value={result.left} /></div>
            <div><p className="text-sm text-ink-300">Por la derecha</p><MathValue value={result.right} /></div>
          </div>}
        </>}
      </div>
      {copied && <p role="status" className="text-sm text-ink-200">{copied}</p>}
      <p className="text-sm text-ink-300">Cálculo simbólico local. Las integrales y límites sin resolver se indican como tales. No se guarda nada en tu banco de estudio.</p>
    </form>
  </details><ValueTablePanel /><InterpolationPanel /><BaseConversionPanel /><MatrixPanel /><LinearSystemPanel /></>;
}
