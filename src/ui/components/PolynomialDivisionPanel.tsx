import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Polynomial = { exact: string; latex: string; degree: number | null };
type Result = { dividend: string; divisor: string; variable: string; dividend_normalized: Polynomial;
  divisor_normalized: Polynomial; quotient: Polynomial; remainder: Polynomial; identity: string;
  residual: string; exact_division: boolean; verified: boolean };

export function PolynomialDivisionPanel() {
  const id = useId(), generation = useRef(0);
  const [dividend, setDividend] = useState('x**3 + 2'), [divisor, setDivisor] = useState('x**2 + 1'), [variable, setVariable] = useState('x');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_polynomial_division', undefined, { dividend, divisor, variable, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/polynomial-division', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dividend, divisor, variable }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo dividir. Revisa los polinomios e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = [`Dividendo: ${result.dividend}`, `Divisor: ${result.divisor}`, `Variable: ${result.variable}`,
      `Cociente: ${result.quotient.exact}`, `Resto: ${result.remainder.exact}`, result.identity,
      `Residuo de comprobación: ${result.residual}; comprobación exacta: ${result.verified ? 'sí' : 'no'}`].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('División y comprobación copiadas.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      División de polinomios
      <span className="block mt-1 text-ink-300 font-normal">Cociente, resto e identidad exacta con coeficientes racionales</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Usa una sola variable y ** para potencias, con enteros, fracciones o punto decimal. El divisor debe ser distinto de cero. La división es sobre los racionales; el cociente puede tener fracciones. No muestra pasos de división larga.</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Input id={`${id}-dividend`} label="Dividendo" value={dividend} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setDividend(event.target.value); }} />
        <Input id={`${id}-divisor`} label="Divisor" value={divisor} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setDivisor(event.target.value); }} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id={`${id}-variable`} label="Variable de la división" value={variable} onChange={event => { invalidate(); setVariable(event.target.value); }}>
          <option value="x">x</option><option value="y">y</option><option value="t">t</option>
        </Select>
        <Button type="submit" loading={busy}>{busy ? 'Dividiendo…' : 'Dividir polinomios'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setDividend(`${variable}**3 + 2`); setDivisor(`${variable}**2 + 1`); }}>Cargar ejemplo con resto</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de la división polinómica" className="mt-5 min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.exact_division ? 'División sin resto' : 'División con resto'}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar división y comprobación</Button>
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
        {[{ label: 'Cociente', value: result.quotient }, { label: 'Resto', value: result.remainder }].map(({ label, value }) => <div key={label} className="min-w-0">
          <dt className="text-sm text-ink-300">{label}</dt>
          <dd><MdContent content={`$$${value.latex}$$`} className="overflow-x-auto text-ink-100" /><p className="font-mono text-sm text-ink-200 break-all">{value.exact}</p></dd>
        </div>)}
      </dl>
      <div className="space-y-2 text-sm text-ink-200">
        <h3 className="font-medium text-ink-100">Comprobación A = B × Q + R</h3>
        <p className="font-mono break-all">{result.identity}</p>
        <p>Residuo de comprobación: {result.residual}. {result.verified ? 'La identidad coincide exactamente.' : 'La identidad no coincide.'}</p>
        <p>{result.exact_division ? 'El resto es cero y no tiene grado definido.' : `Grado del resto: ${result.remainder.degree}; menor que el grado del divisor: ${result.divisor_normalized.degree}.`}</p>
      </div>
      {copied && <p role="status" className="text-sm text-ink-200">{copied}</p>}
    </section>}
  </details>;
}
