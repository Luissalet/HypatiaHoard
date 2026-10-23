import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Result = { a_exact: string; b_exact: string; modulus_exact: string; gcd: string;
  compatibility_remainder: string; bezout: { x: string; y: string; value: string };
  status: 'solved' | 'no_solution'; residue: string | null; period: string | null;
  residue_count: string; all_integers: boolean; verified: boolean };
const equation = (r: Result) => `(${r.a_exact}) × x ≡ ${r.b_exact} (mod ${r.modulus_exact})`;
const family = (r: Result) => `x = ${r.residue} + k × ${r.period}, k ∈ ℤ`;
const identity = (r: Result) => `(${r.a_exact}) × (${r.bezout.x}) + ${r.modulus_exact} × (${r.bezout.y}) = ${r.gcd}`;

export function CongruencePanel() {
  const [a, setA] = useState('35'), [b, setB] = useState('14'), [modulus, setModulus] = useState('28');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_linear_congruence', undefined, { a, b, modulus, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/linear-congruence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, b, modulus }) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo resolver. Corrige los enteros e inténtalo de nuevo.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = [equation(result), `MCD(a, |m|): ${result.gcd}`, identity(result),
      `Resto de b entre MCD: ${result.compatibility_remainder}`,
      ...(result.status === 'solved' ? [family(result), `Residuos distintos módulo ${result.modulus_exact}: ${result.residue_count}`,
        ...(result.all_integers ? ['Cualquier entero es solución.'] : [])] : ['Sin solución: el MCD no divide b.']),
      `Comprobación exacta: ${result.verified ? 'sí' : 'no'}`].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Solución y comprobación copiadas.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Congruencias lineales
      <span className="block mt-1 text-ink-300 font-normal">Todas las soluciones enteras de a × x ≡ b (mod m)</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Input id="congruence-a" label="Coeficiente (a)" value={a} required aria-describedby="congruence-help" onChange={event => setA(event.target.value)} />
        <Input id="congruence-b" label="Término (b)" value={b} required aria-describedby="congruence-help" onChange={event => setB(event.target.value)} />
        <Input id="congruence-modulus" label="Módulo (m)" value={modulus} required aria-describedby="congruence-help" onChange={event => setModulus(event.target.value)} />
      </div>
      <p id="congruence-help" className="text-sm text-ink-300">Enteros decimales con signo opcional, sin expresiones ni fracciones. m debe ser distinto de cero; si es negativo se usa |m|. Para buscar el inverso de a, escribe b = 1.</p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>{busy ? 'Resolviendo…' : 'Resolver congruencia'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setA('35'); setB('14'); setModulus('28'); }}>Cargar ejemplo 35x ≡ 14</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de congruencia" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.status === 'solved' ? 'Todas las soluciones' : 'Sin solución'}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar solución y comprobación</Button>
      </div>
      <p className="font-mono text-sm text-ink-100 break-all">{equation(result)}</p>
      {result.status === 'solved' ? <>
        <p className="font-mono text-lg text-amber-400 break-all">{family(result)}</p>
        <p className="text-sm text-ink-200">{result.all_integers ? 'Cualquier entero es solución. ' : 'k puede ser cualquier entero, positivo, negativo o cero. '}
          El residuo inicial es el menor no negativo módulo el período.</p>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="min-w-0"><dt className="text-sm text-ink-300">Período · |m| / MCD</dt><dd className="font-mono text-ink-100 break-all">{result.period}</dd></div>
          <div className="min-w-0"><dt className="text-sm text-ink-300">Residuos distintos módulo |m|</dt><dd className="font-mono text-ink-100 break-all">{result.residue_count}</dd></div>
        </dl>
        <p className="text-sm text-ink-300">Dentro de 0 ≤ x &lt; |m|, toma k = 0, …, MCD − 1. La fórmula representa todos los residuos sin enumerar una lista que puede ser enorme.</p>
      </> : <p className="text-sm text-ink-200">El MCD no divide b: no existe ningún entero x que satisfaga esta congruencia.</p>}
      <div className="border-y border-ink-700 py-4 space-y-2">
        <h3 className="font-medium text-ink-100">Comprobación con Bézout</h3>
        <p className="font-mono text-sm text-ink-100 break-all">MCD(a, |m|) = {result.gcd}</p>
        <p className="font-mono text-sm text-ink-100 break-all">{identity(result)}</p>
        <p className="font-mono text-sm text-ink-100 break-all">Resto de b entre MCD = {result.compatibility_remainder}</p>
        <p className="text-sm text-ink-300">{result.status === 'no_solution' ? 'El resto distinto de cero comprueba la incompatibilidad.' : 'El resto cero permite dividir por el MCD. Se comprueban el residuo inicial y el período en la congruencia original.'}</p>
      </div>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
  </details>;
}
