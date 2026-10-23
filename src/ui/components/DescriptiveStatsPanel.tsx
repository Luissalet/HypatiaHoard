import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Select } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Value = { exact: string; approx: string | null };
type Dispersion = { denominator: number; variance: Value; standard_deviation: Value };
type Result = { values: string[]; values_exact: string[]; count: number; sum: Value; mean: Value; median: Value;
  minimum: Value; maximum: Value; range: Value; squared_deviations: Value; population: Dispersion; sample: Dispersion | null };
const samples = { fractions: '1/2\n1\n3/2', repeated: '2\n4\n4\n4\n5\n5\n7\n9', single: '0.1234567890123456789' };
const labels = { sum: 'Suma', mean: 'Media', median: 'Mediana', minimum: 'Mínimo', maximum: 'Máximo', range: 'Rango' } as const;

function NumericValue({ value }: { value: Value }) {
  return <><span className="block font-mono text-ink-100 break-all">{value.exact}</span>
    {value.approx && <span className="block text-xs text-ink-400 break-all">≈ {value.approx}</span>}</>;
}

export function DescriptiveStatsPanel() {
  const [values, setValues] = useState(samples.fractions), [example, setExample] = useState<keyof typeof samples>('fractions');
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_statistics', undefined, { values, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const observations = values.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!observations.length) throw new Error('Escribe al menos una observación.');
      const next = await hoardJson<Result>('/math/statistics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: observations }) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Conservamos los datos para que lo intentes de nuevo.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = ['Estadística descriptiva exacta', 'Observaciones originales:', ...result.values, `N: ${result.count}`,
      ...Object.entries(labels).map(([key, label]) => `${label}: ${result[key as keyof typeof labels].exact}`),
      `Suma de desviaciones al cuadrado: ${result.squared_deviations.exact}`,
      `Varianza poblacional (divisor N=${result.population.denominator}): ${result.population.variance.exact}`,
      `Desviación típica poblacional: ${result.population.standard_deviation.exact}`,
      ...(result.sample ? [`Varianza muestral (divisor N−1=${result.sample.denominator}): ${result.sample.variance.exact}`,
        `Desviación típica muestral: ${result.sample.standard_deviation.exact}`] : ['Varianza y desviación muestrales no definidas: se necesitan dos observaciones.']),
      'Describe estos datos; no estima probabilidades ni realiza predicciones.'].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Datos y estadísticas copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Estadística exacta
      <span className="block mt-1 text-ink-300 font-normal">Media, mediana y dispersión con fracciones y decimales exactos</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div>
        <label htmlFor="statistics-values" className="block text-sm font-medium text-ink-200 mb-1">Observaciones numéricas</label>
        <textarea id="statistics-values" rows={5} required value={values} onChange={event => setValues(event.target.value)} aria-describedby="statistics-help"
          className="w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <p id="statistics-help" className="mt-1 text-sm text-ink-300">Un valor por línea. Usa enteros, fracciones como 1/3 o punto decimal; conserva repetidos. Las líneas vacías se ignoran, no representan datos ausentes.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id="statistics-example" label="Ejemplo de estadística" value={example} onChange={event => setExample(event.target.value as keyof typeof samples)}>
          <option value="fractions">Fracciones</option><option value="repeated">Valores repetidos</option><option value="single">Una observación</option>
        </Select>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setValues(samples[example]); }}>Cargar datos de ejemplo</Button>
        <Button type="submit" loading={busy}>{busy ? 'Calculando…' : 'Calcular estadísticas'}</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado estadístico" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.count} {result.count === 1 ? 'observación' : 'observaciones'}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar datos y estadísticas</Button>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
        {Object.entries(labels).map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-sm text-ink-300">{label}</dt>
          <dd><NumericValue value={result[key as keyof typeof labels]} /></dd></div>)}
      </dl>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-y border-ink-700 py-4">
        <div className="min-w-0 space-y-2"><h3 className="font-medium text-ink-100">Población · divisor N = {result.population.denominator}</h3>
          <dl className="space-y-2"><div><dt className="text-sm text-ink-300">Varianza poblacional</dt><dd><NumericValue value={result.population.variance} /></dd></div>
            <div><dt className="text-sm text-ink-300">Desviación típica poblacional</dt><dd><NumericValue value={result.population.standard_deviation} /></dd></div></dl></div>
        <div className="min-w-0 space-y-2"><h3 className="font-medium text-ink-100">Muestra{result.sample && ` · divisor N−1 = ${result.sample.denominator}`}</h3>
          {result.sample ? <dl className="space-y-2"><div><dt className="text-sm text-ink-300">Varianza muestral</dt><dd><NumericValue value={result.sample.variance} /></dd></div>
            <div><dt className="text-sm text-ink-300">Desviación típica muestral</dt><dd><NumericValue value={result.sample.standard_deviation} /></dd></div></dl>
            : <p className="text-sm text-ink-200">Varianza y desviación muestrales no definidas: se necesitan dos observaciones.</p>}</div>
      </div>
      <p className="text-sm text-ink-300 break-all">Suma de desviaciones al cuadrado: <span className="font-mono">{result.squared_deviations.exact}</span></p>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">La varianza de población divide por N y la muestral por N−1. Describe los datos escritos; no hace predicciones ni modifica el banco de estudio.</p>
  </details>;
}
