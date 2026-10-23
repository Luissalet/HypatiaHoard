import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Division = { dividend: string; divisor: string; quotient: string; remainder: string };
type Result = { a: string; b: string; a_exact: string; b_exact: string; gcd: string; lcm: string;
  bezout: { x: string; y: string; value: string }; verified: boolean; steps: Division[]; both_zero: boolean };
const divisionText = (step: Division) => `${step.dividend} = ${step.divisor} × ${step.quotient} + ${step.remainder}`;
const identityText = (result: Result) => `(${result.a_exact}) × (${result.bezout.x}) + (${result.b_exact}) × (${result.bezout.y}) = ${result.bezout.value}`;

export function IntegerPairPanel() {
  const [a, setA] = useState('240'), [b, setB] = useState('46');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_integer_pair', undefined, { a, b, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/integer-pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, b }) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Corrige los enteros e inténtalo de nuevo.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = ['MCD, MCM y Bézout exactos', `a: ${result.a_exact}`, `b: ${result.b_exact}`,
      `MCD: ${result.gcd}`, `MCM: ${result.lcm}`, `x: ${result.bezout.x}`, `y: ${result.bezout.y}`,
      identityText(result), `Identidad comprobada: ${result.verified ? 'sí' : 'no'}`,
      ...(result.both_zero ? ['Para (0, 0) se usa MCD = MCM = 0 y x = y = 0 por convención.'] : []),
      'Divisiones de Euclides sobre valores absolutos:', ...result.steps.map(divisionText),
      ...(!result.steps.length ? ['No hacen falta divisiones: el segundo entero es cero.'] : [])].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Resultado y divisiones copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      MCD, MCM y Bézout
      <span className="block mt-1 text-ink-300 font-normal">Resultados exactos y recorrido de Euclides para dos enteros</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input id="integer-pair-a" label="Primer entero (a)" value={a} required aria-describedby="integer-pair-help" onChange={event => setA(event.target.value)} />
        <Input id="integer-pair-b" label="Segundo entero (b)" value={b} required aria-describedby="integer-pair-help" onChange={event => setB(event.target.value)} />
      </div>
      <p id="integer-pair-help" className="text-sm text-ink-300">Enteros decimales con signo opcional. Usa sólo cifras: sin fracciones, punto decimal ni expresiones. Los valores grandes conservan todas sus cifras.</p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>{busy ? 'Calculando…' : 'Calcular MCD y MCM'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setA('240'); setB('46'); }}>Cargar ejemplo de Euclides</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de MCD y Bézout" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">Resultado exacto</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar resultado y divisiones</Button>
      </div>
      <dl className="grid grid-cols-2 gap-4">
        <div className="min-w-0"><dt className="text-sm text-ink-300">Máximo común divisor</dt><dd className="font-mono text-ink-100 break-all">{result.gcd}</dd></div>
        <div className="min-w-0"><dt className="text-sm text-ink-300">Mínimo común múltiplo</dt><dd className="font-mono text-ink-100 break-all">{result.lcm}</dd></div>
      </dl>
      <div className="border-y border-ink-700 py-4 space-y-2">
        <h3 className="font-medium text-ink-100">Identidad de Bézout · a × x + b × y = MCD</h3>
        <p className="font-mono text-sm text-ink-100 break-all">x = {result.bezout.x} · y = {result.bezout.y}</p>
        <p className="font-mono text-sm text-ink-100 break-all">{identityText(result)}</p>
        <p className="text-sm text-ink-300">{result.verified ? 'La igualdad se ha comprobado con enteros exactos.' : 'La igualdad no se ha podido comprobar.'} Los coeficientes no son únicos.</p>
      </div>
      {result.both_zero && <p className="text-sm text-ink-200">Para (0, 0) se usa MCD = MCM = 0 y x = y = 0 por convención.</p>}
      <div className="space-y-2 min-w-0"><h3 className="font-medium text-ink-100">Divisiones de Euclides</h3>
        <p className="text-sm text-ink-300">Sobre los valores absolutos de a y b; cada resto es menor que su divisor. El último divisor es el MCD.</p>
        {result.steps.length ? <ol className="list-decimal pl-6 space-y-2 text-sm font-mono text-ink-100">
          {result.steps.map((step, index) => <li key={index} className="break-all">{divisionText(step)}</li>)}
        </ol> : <p className="text-sm text-ink-200">No hacen falta divisiones: el segundo entero es cero.</p>}
      </div>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
  </details>;
}
