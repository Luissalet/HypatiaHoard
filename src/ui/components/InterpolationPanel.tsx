import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Select } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Result = { variable: string; points: string[][]; exact: string; degree: number | null; is_zero: boolean; verified: boolean;
  coefficients_exact: string[]; rows: { point: string[]; x_exact: string; y_exact: string; evaluated_exact: string; residual_exact: string }[] };
const samples = { quadratic: '-1; 2\n1; 2\n2; 5', fractions: '0; 1\n1/2; 5/4\n1; 2', duplicate: '0.5; 1\n1/2; 2' };

export function InterpolationPanel() {
  const [points, setPoints] = useState(samples.fractions), [variable, setVariable] = useState('x');
  const [example, setExample] = useState<keyof typeof samples>('fractions');
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState(''), [open, setOpen] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_interpolation', undefined, { points, variable, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const pairs = points.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
        const pair = line.split(';').map(value => value.trim());
        if (pair.length !== 2 || pair.some(value => !value)) throw new Error(`Fila ${index + 1}: escribe una abscisa y un valor separados por punto y coma.`);
        return pair;
      });
      if (!pairs.length) throw new Error('Escribe al menos un par de números.');
      const next = await hoardJson<Result>('/math/interpolate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: pairs, variable }) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo interpolar. Conservamos los puntos para que lo intentes de nuevo.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = ['Interpolación exacta', `Variable: ${result.variable}`, 'Puntos originales (abscisa; valor):',
      ...result.points.map(pair => pair.join('; ')), `Polinomio: ${result.exact}`,
      result.is_zero ? 'Polinomio cero; grado no definido.' : `Grado: ${result.degree}`,
      `Coeficientes (potencias descendentes): ${result.coefficients_exact.join('; ')}`,
      'Abscisa exacta\tValor exacto\tPolinomio evaluado\tResiduo',
      ...result.rows.map(row => [row.x_exact, row.y_exact, row.evaluated_exact, row.residual_exact].join('\t')),
      'Interpolación exacta de estos datos, no regresión ni predicción.'].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Polinomio y comprobación copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Interpolación de puntos
      <span className="block mt-1 text-ink-300 font-normal">Obtén un polinomio exacto y comprueba que reproduce cada dato</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div>
        <label htmlFor="interpolation-points" className="block text-sm font-medium text-ink-200 mb-1">Pares de abscisa y valor</label>
        <textarea id="interpolation-points" required rows={5} value={points} onChange={event => setPoints(event.target.value)} aria-describedby="interpolation-help"
          className="w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <p id="interpolation-help" className="mt-1 text-sm text-ink-300">Un par por línea, separado por punto y coma: 1/2; 5/4. Usa enteros, fracciones o punto decimal. Las abscisas deben ser distintas: 0.5 y 1/2 son la misma.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id="interpolation-variable" label="Variable del polinomio" value={variable} onChange={event => setVariable(event.target.value)}>
          <option value="x">x</option><option value="y">y</option><option value="t">t</option>
        </Select>
        <Select id="interpolation-example" label="Ejemplo de interpolación" value={example} onChange={event => setExample(event.target.value as keyof typeof samples)}>
          <option value="fractions">Puntos con fracciones</option><option value="quadratic">Polinomio cuadrático</option><option value="duplicate">Abscisa repetida</option>
        </Select>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setPoints(samples[example]); }}>Cargar puntos de ejemplo</Button>
        <Button type="submit" loading={busy}>{busy ? 'Interpolando…' : 'Interpolar puntos'}</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de la interpolación" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.is_zero ? 'Polinomio cero · grado no definido' : `Polinomio de grado ${result.degree}`}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar polinomio y comprobación</Button>
      </div>
      <p className="font-mono text-lg text-ink-100 break-all">p({result.variable}) = {result.exact}</p>
      <p className="text-sm text-ink-300">Coeficientes, de mayor a menor potencia: <span className="font-mono break-all">{result.coefficients_exact.join('; ')}</span></p>
      <p className="text-sm text-ink-200">{result.verified ? 'Comprobación exacta: todos los residuos son cero.' : 'La comprobación presenta diferencias; revisa los residuos.'}</p>
      <ol className="divide-y divide-ink-800">
        {result.rows.map((row, index) => <li key={index} className="py-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm min-w-0">
          <div className="min-w-0"><p className="text-ink-300">Punto {index + 1} · escrito</p><p className="font-mono text-ink-100 break-all">{row.point.join('; ')}</p>
            <p className="text-ink-300 break-all">Par exacto: {row.x_exact}; {row.y_exact}</p></div>
          <div className="min-w-0"><p className="text-ink-300">Sustitución exacta</p><p className="font-mono text-ink-100 break-all">p({row.x_exact}) = {row.evaluated_exact}</p>
            <p className="text-ink-300 break-all">Residuo: {row.residual_exact}</p></div>
        </li>)}
      </ol>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">El polinomio es único entre los de grado menor que el número de puntos. Ajusta exactamente los datos; no es una regresión ni una predicción. No se guarda nada en el banco.</p>
  </details>;
}
