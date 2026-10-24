import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Expression = { exact: string; latex: string };
type Result = { numerator: string; denominator: string; variable: string; polynomial_part: Expression;
  proper_part: Expression; decomposition: Expression; domain_restriction: string; domain_restriction_latex: string;
  residual: string; verified: boolean };

export function PartialFractionsPanel() {
  const id = useId(), generation = useRef(0);
  const [numerator, setNumerator] = useState('x + 3'), [denominator, setDenominator] = useState('(x - 1)*(x + 1)'), [variable, setVariable] = useState('x');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_partial_fractions', undefined, { numerator, denominator, variable, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/partial-fractions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numerator, denominator, variable }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo descomponer. Revisa los polinomios e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Fracciones parciales
      <span className="block mt-1 text-ink-300 font-normal">Descomponer un cociente racional conservando su dominio original</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Escribe dos polinomios en una sola variable, con ** para potencias, fracciones o punto decimal. El denominador debe ser distinto de cero. La descomposición mantiene coeficientes racionales: los factores irreducibles pueden permanecer.</p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Input id={`${id}-numerator`} label="Numerador" value={numerator} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setNumerator(event.target.value); }} />
        <Input id={`${id}-denominator`} label="Denominador" value={denominator} required maxLength={200} aria-describedby={`${id}-help`} onChange={event => { invalidate(); setDenominator(event.target.value); }} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Select id={`${id}-variable`} label="Variable de las fracciones" value={variable} onChange={event => { invalidate(); setVariable(event.target.value); }}>
          <option value="x">x</option><option value="y">y</option><option value="t">t</option>
        </Select>
        <Button type="submit" loading={busy}>{busy ? 'Descomponiendo…' : 'Calcular fracciones parciales'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setNumerator(`${variable} + 3`); setDenominator(`(${variable} - 1)*(${variable} + 1)`); }}>Cargar ejemplo de fracciones</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de fracciones parciales" className="mt-5 min-w-0 space-y-4">
      <h2 className="font-display text-lg text-ink-100" aria-live="polite">Descomposición sobre los racionales</h2>
      <MdContent content={`$$${result.decomposition.latex}$$`} className="overflow-x-auto text-ink-100" />
      <p className="font-mono text-sm text-ink-200 break-all">{result.decomposition.exact}</p>
      <dl className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
        {[{ label: 'Parte polinómica', value: result.polynomial_part }, { label: 'Fracciones propias', value: result.proper_part }].map(({ label, value }) => <div key={label} className="min-w-0">
          <dt className="text-sm text-ink-300">{label}</dt>
          <dd><MdContent content={`$$${value.latex}$$`} className="overflow-x-auto text-ink-100" /><p className="font-mono text-sm text-ink-200 break-all">{value.exact}</p></dd>
        </div>)}
      </dl>
      <div className="space-y-2 text-sm text-ink-200">
        <h3 className="font-medium text-ink-100">Dominio de la expresión original</h3>
        <MdContent content={`$$${result.domain_restriction_latex}$$`} className="overflow-x-auto text-ink-100" />
        <p className="font-mono break-all">{result.domain_restriction}</p>
        <p>El denominador original debe ser distinto de cero, incluso si se cancela un factor o el numerador es cero. Cancelar no recupera puntos excluidos.</p>
        <p>Residuo de comprobación: {result.residual}. {result.verified ? 'El cociente y la descomposición coinciden exactamente en su dominio original.' : 'La identidad no coincide.'}</p>
        <p>No calcula polos, integra ni muestra pasos de coeficientes indeterminados.</p>
      </div>
    </section>}
  </details>;
}
