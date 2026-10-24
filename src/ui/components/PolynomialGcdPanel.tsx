import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Polynomial = { exact: string; latex: string; degree: number | null };
type Result = { a: string; b: string; variable: string; gcd: Polynomial; lcm: Polynomial;
  u: Polynomial; v: Polynomial; identity: string; residual: string; verified: boolean; coprime: boolean; both_zero: boolean };

export function PolynomialGcdPanel() {
  const id = useId(), generation = useRef(0);
  const [a, setA] = useState('x**3 - x'), [b, setB] = useState('x**2 - 1'), [variable, setVariable] = useState('x');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_polynomial_gcd', undefined, { a, b, variable, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/polynomial-gcd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, b, variable }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Revisa los polinomios e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      MCD y Bézout de polinomios
      <span className="block mt-1 text-ink-300 font-normal">Factor común, múltiplo común e identidad exacta sobre los racionales</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Una sola variable, ** para potencias y coeficientes enteros, fracciones o punto decimal. El MCD y el MCM no nulos son mónicos: su coeficiente principal es 1. Se admiten polinomios cero.</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Input id={`${id}-a`} label="Polinomio A" value={a} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setA(event.target.value); }} />
        <Input id={`${id}-b`} label="Polinomio B" value={b} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setB(event.target.value); }} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id={`${id}-variable`} label="Variable del MCD" value={variable} onChange={event => { invalidate(); setVariable(event.target.value); }}>
          <option value="x">x</option><option value="y">y</option><option value="t">t</option>
        </Select>
        <Button type="submit" loading={busy}>{busy ? 'Calculando MCD…' : 'Calcular MCD y Bézout'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setA(`${variable}**3 - ${variable}`); setB(`${variable}**2 - 1`); }}>Cargar ejemplo de factor común</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado del MCD polinómico" className="mt-5 min-w-0 space-y-4">
      <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.both_zero ? 'Dos polinomios cero' : result.coprime ? 'Polinomios coprimos sobre los racionales' : 'Factor común encontrado'}</h2>
      <dl className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
        {[{ label: 'MCD', value: result.gcd }, { label: 'MCM', value: result.lcm }, { label: 'Coeficiente U', value: result.u }, { label: 'Coeficiente V', value: result.v }].map(({ label, value }) => <div key={label} className="min-w-0">
          <dt className="text-sm text-ink-300">{label}</dt>
          <dd><MdContent content={`$$${value.latex}$$`} className="overflow-x-auto text-ink-100" /><p className="font-mono text-sm text-ink-200 break-all">{value.exact}</p></dd>
        </div>)}
      </dl>
      <div className="space-y-2 text-sm text-ink-200">
        <h3 className="font-medium text-ink-100">Identidad de Bézout: A × U + B × V = MCD</h3>
        <p className="font-mono break-all">{result.identity}</p>
        <p>Residuo de comprobación: {result.residual}. {result.verified ? 'La identidad coincide exactamente.' : 'La identidad no coincide.'}</p>
        {result.both_zero && <p>Por convenio, MCD, MCM, U y V son cero. El polinomio cero no tiene grado definido.</p>}
        <p>U y V no son únicos. Si uno de los polinomios es cero, el MCM es cero. Las constantes no nulas son unidades sobre los racionales; su MCD mónico es 1.</p>
        <p>La comprobación es algebraica; no muestra los pasos del algoritmo de Euclides.</p>
      </div>
    </section>}
  </details>;
}
