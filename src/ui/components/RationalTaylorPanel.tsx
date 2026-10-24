import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Expression = { exact: string; latex: string };
type Result = { center_exact: string; order: number; variable: string; polynomial: Expression;
  centered_polynomial: Expression; coefficients: (Expression & { power: number })[]; remainder: Expression;
  domain_restriction: string; domain_restriction_latex: string; residual: string; verified: boolean };

export function RationalTaylorPanel() {
  const id = useId(), generation = useRef(0);
  const [numerator, setNumerator] = useState('1'), [denominator, setDenominator] = useState('1 - x');
  const [center, setCenter] = useState('0'), [order, setOrder] = useState('3'), [variable, setVariable] = useState('x');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_rational_taylor', undefined, { numerator, denominator, center, order, variable, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/rational-taylor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numerator, denominator, center, order: Number(order), variable }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Revisa la función y el centro e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Taylor de funciones racionales
      <span className="block mt-1 text-ink-300 font-normal">Polinomio local, coeficientes y resto exacto alrededor de un centro racional</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Escribe polinomios con coeficientes racionales, ** para potencias y punto decimal o fracciones. El centro debe pertenecer al dominio original, incluso si se cancela un factor.</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Input id={`${id}-numerator`} label="Numerador para Taylor" value={numerator} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setNumerator(event.target.value); }} />
        <Input id={`${id}-denominator`} label="Denominador para Taylor" value={denominator} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setDenominator(event.target.value); }} />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
        <Input id={`${id}-center`} label="Centro racional" value={center} placeholder="0 o 1/2" required maxLength={200} onChange={event => { invalidate(); setCenter(event.target.value); }} />
        <Input id={`${id}-order`} label="Grado máximo (0–12)" type="number" min={0} max={12} step={1} value={order} required onChange={event => { invalidate(); setOrder(event.target.value); }} />
        <Select id={`${id}-variable`} label="Variable de Taylor" value={variable} onChange={event => { invalidate(); setVariable(event.target.value); }}><option value="x">x</option><option value="y">y</option><option value="t">t</option></Select>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>{busy ? 'Calculando Taylor…' : 'Calcular Taylor racional'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setNumerator('1'); setDenominator(`1 - ${variable}`); setCenter('0'); setOrder('3'); }}>Cargar ejemplo de Taylor</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de Taylor racional" className="mt-5 min-w-0 space-y-4">
      <h2 className="font-display text-lg text-ink-100" aria-live="polite">Polinomio centrado en {result.center_exact}</h2>
      <p className="text-sm text-ink-300">Grado máximo solicitado: {result.order}. Las potencias se refieren a ({result.variable} − ({result.center_exact})).</p>
      <MdContent content={`$$${result.centered_polynomial.latex}$$`} className="overflow-x-auto text-ink-100" />
      <p className="font-mono text-sm text-ink-200 break-all">{result.centered_polynomial.exact}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="text-left text-ink-100 font-medium mb-2">Coeficientes en potencias del desplazamiento</caption><thead className="text-ink-300"><tr><th scope="col" className="py-2 pr-4">Potencia</th><th scope="col" className="py-2">Coeficiente exacto</th></tr></thead><tbody>{result.coefficients.map(row => <tr key={row.power} className="border-t border-ink-700"><th scope="row" className="py-2 pr-4 font-normal tabular-nums">{row.power}</th><td className="py-2 font-mono break-all">{row.exact}</td></tr>)}</tbody></table></div>
      <dl className="space-y-4">{[{label: 'Polinomio expandido', value: result.polynomial}, {label: 'Resto algebraico exacto: función menos polinomio', value: result.remainder}].map(({label,value}) => <div key={label} className="min-w-0"><dt className="text-sm text-ink-300">{label}</dt><dd><MdContent content={`$$${value.latex}$$`} className="overflow-x-auto text-ink-100" /><p className="font-mono text-sm text-ink-200 break-all">{value.exact}</p></dd></div>)}</dl>
      <div className="space-y-2 text-sm text-ink-200">
        <h3 className="font-medium text-ink-100">Dominio de la expresión original</h3>
        <MdContent content={`$$${result.domain_restriction_latex}$$`} className="overflow-x-auto text-ink-100" /><p className="font-mono break-all">{result.domain_restriction}</p>
        <p>Residuo de comprobación: {result.residual}. {result.verified ? 'Función = polinomio + resto exactamente en el dominio original.' : 'La identidad no coincide.'}</p>
        <p>El polinomio es una aproximación local; el resto mostrado es exacto. No calcula radio de convergencia ni cota numérica del error.</p>
      </div>
    </section>}
  </details>;
}
