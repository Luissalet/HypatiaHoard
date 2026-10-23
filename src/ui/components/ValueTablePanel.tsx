import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Row = { point: string; point_exact?: string; status: keyof typeof statuses; exact?: string; approx?: string | null; error?: string };
type Result = { expression: string; variable: string; points: string[]; rows: Row[] };
const statuses = { evaluated: 'Real', complex: 'Complejo', undefined: 'Indefinido', invalid_point: 'Punto inválido', unevaluated: 'Sin resolver' };
const samples = { fractions: { expression: 'x**2 + 1/3', points: '-1; 0; 1/3; 0.1; pi' },
  domain: { expression: 'x/x', points: '-1; 0; 1; 0' }, complex: { expression: 'log(x)', points: '-1; 0; 1; E' } };

export function ValueTablePanel() {
  const [expression, setExpression] = useState('');
  const [variable, setVariable] = useState('x');
  const [points, setPoints] = useState('-1; 0; 1');
  const [example, setExample] = useState<keyof typeof samples>('fractions');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const [open, setOpen] = useState(false);
  useCopilotDraft('math_value_table', undefined, { expression, variable, points, result, busy, error }, open);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  function invalidate() { generation.current++; setResult(null); setError(''); setCopied(''); setBusy(false); }
  function loadExample() {
    invalidate(); setExpression(samples[example].expression.replace(/\bx\b/g, variable)); setPoints(samples[example].points);
  }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate();
    const request = generation.current;
    setBusy(true);
    try {
      const body = { expression, variable, points: points.split(/[;,\n]/).map(p => p.trim()).filter(Boolean) };
      const next = await hoardJson<Result>('/math/values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular la tabla. Conservamos los datos para que lo intentes de nuevo.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copyTable() {
    if (!result) return;
    const request = generation.current;
    const text = ['Tabla de valores', `Expresión: ${result.expression}`, `Variable: ${result.variable}`, `Puntos: ${result.points.join('; ')}`,
      'Evaluación de la expresión original, no un límite. Complejos: ramas principales del motor local; I es la unidad imaginaria.',
      'Punto\tPunto exacto\tEstado\tValor exacto\tAproximación\tDetalle',
      ...result.rows.map(row => [row.point, row.point_exact ?? '', statuses[row.status], row.exact ?? '', row.approx ?? '', row.error ?? ''].join('\t'))].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Tabla copiada.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Selecciona los resultados para copiarlos manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Tabla de valores
      <span className="block mt-1 text-ink-300 font-normal">Evalúa una expresión en varios puntos y conserva fracciones y decimales exactos</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
        <Input id="values-expression" label="Expresión de la tabla" required maxLength={200} value={expression} onChange={e => setExpression(e.target.value)} placeholder="x**2 + 1/3" aria-describedby="values-syntax" />
        <Select id="values-variable" label="Variable de la tabla" value={variable} onChange={e => setVariable(e.target.value)}>
          <option value="x">x</option><option value="y">y</option><option value="t">t</option>
        </Select>
      </div>
      <p id="values-syntax" className="text-sm text-ink-300">Usa ** para potencias y punto decimal. Funciones: sqrt, sin, cos, exp y log; constantes: pi y E.</p>
      <div>
        <label htmlFor="values-points" className="block text-sm font-medium text-ink-200 mb-1">Puntos de evaluación</label>
        <textarea id="values-points" required rows={3} value={points} onChange={e => setPoints(e.target.value)} aria-describedby="values-points-help"
          className="w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <p id="values-points-help" className="mt-1 text-sm text-ink-300">Separa con punto y coma, coma o salto de línea. Constantes reales finitas, como -1, 1/3, 0.1 o pi; sin variables ni infinito. Se mantiene el orden y los puntos repetidos.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id="values-example" label="Ejemplo de tabla" value={example} onChange={e => setExample(e.target.value as keyof typeof samples)}>
          <option value="fractions">Fracciones y constantes</option><option value="domain">Un punto indefinido</option><option value="complex">Valores complejos</option>
        </Select>
        <Button type="button" variant="secondary" onClick={loadExample}>Cargar ejemplo de tabla</Button>
        <Button type="submit" loading={busy}>{busy ? 'Calculando tabla…' : 'Calcular tabla'}</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de la tabla de valores" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.rows.length === 1 ? '1 punto evaluado' : `${result.rows.length} puntos evaluados`}</h2>
        <Button type="button" variant="secondary" onClick={copyTable}>Copiar tabla</Button>
      </div>
      <p className="text-sm text-ink-300">Expresión original · variable {result.variable}<br /><span className="font-mono text-ink-200 break-all">{result.expression}</span></p>
      <ol className="divide-y divide-ink-800">
        {result.rows.map((row, index) => <li key={index} className="py-4 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 sm:gap-5">
          <div className="min-w-0">
            <p className="text-sm text-ink-300">Punto {index + 1} · {statuses[row.status]}</p>
            <p className="font-mono text-ink-100 break-all">{result.variable} = {row.point}</p>
            {row.point_exact && row.point_exact !== row.point && <p className="mt-1 text-sm text-ink-300 break-all">Punto exacto: {row.point_exact}</p>}
          </div>
          <div className="min-w-0 space-y-1">
            {row.exact != null && <><p className="text-sm text-ink-300">Valor exacto</p><p className="font-mono text-ink-100 break-all">{row.exact}</p></>}
            {row.approx && <p className="text-sm text-ink-300 break-all">Aproximación: {row.approx}</p>}
            {row.status === 'undefined' && <p className="text-sm text-rose-300">La expresión original no está definida en este punto.</p>}
            {row.status === 'invalid_point' && <p className="text-sm text-rose-300">Usa una constante real finita sin variables.</p>}
            {row.error && <p className="text-xs text-ink-300 break-words">Motor: {row.error}</p>}
          </div>
        </li>)}
      </ol>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">Evalúa la expresión original, no calcula un límite: x/x en 0 es indefinido. Los complejos usan las ramas principales del motor local; I es la unidad imaginaria. No se guarda nada en el banco.</p>
  </details>;
}
