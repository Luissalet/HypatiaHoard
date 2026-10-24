import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Condition = { id: number; residue: string; modulus: string };
type Result = { status: 'solved' | 'no_solution'; residue: string | null; period: string | null;
  all_integers: boolean; verified: boolean;
  constraints: { residue: string; modulus: string; residue_exact: string; modulus_exact: string }[];
  checks: { index: number; expected: string; actual: string; modulus: string; period_remainder: string }[];
  conflict: null | { index: number; prior_residue: string; prior_period: string; difference: string; gcd: string; compatibility_remainder: string; bezout: { x: string; y: string; value: string } } };
const example: Condition[] = [{ id: 0, residue: '2', modulus: '6' }, { id: 1, residue: '5', modulus: '9' }];
const family = (r: Result) => `x = ${r.residue} + k × ${r.period}, k ∈ ℤ`;

export function CongruenceSystemPanel() {
  const id = useId(), nextId = useRef(2), generation = useRef(0);
  const [rows, setRows] = useState<Condition[]>(example), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const constraints = rows.map(({ residue, modulus }) => ({ residue, modulus }));
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_congruence_system', undefined, { constraints, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  function change(rowId: number, field: 'residue' | 'modulus', value: string) {
    invalidate(); setRows(current => current.map(row => row.id === rowId ? { ...row, [field]: value } : row));
  }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/congruence-system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ constraints }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo resolver. Corrige los enteros e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current, c = result.conflict;
    const lines = result.constraints.map(row => `x ≡ ${row.residue_exact} (mod ${row.modulus_exact})`);
    lines.push(result.status === 'solved' ? family(result) : `Sin solución: condición ${(c?.index ?? 0) + 1} incompatible con las anteriores.`);
    if (c) lines.push(`Clase previa: x = ${c.prior_residue} + k × ${c.prior_period}`, `Diferencia: ${c.difference}; MCD: ${c.gcd}; resto: ${c.compatibility_remainder}`);
    for (const row of result.checks) lines.push(`${result.residue} mod ${row.modulus} = ${row.actual}; esperado ${row.expected}; período mod ${row.modulus} = ${row.period_remainder}`);
    lines.push(`Comprobación exacta: ${result.verified ? 'sí' : 'no'}`);
    try { await navigator.clipboard.writeText(lines.join('\n')); if (request === generation.current) setCopied('Sistema y comprobación copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Sistema de congruencias
      <span className="block mt-1 text-ink-300 font-normal">Combinar condiciones x ≡ r (mod m), también con módulos no coprimos</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Enteros decimales con signo opcional, sin expresiones ni fracciones. Cada módulo debe ser distinto de cero; los negativos se normalizan a su valor absoluto. Todas las condiciones deben cumplirse.</p>
      {rows.map((row, index) => <fieldset key={row.id} className="min-w-0 border-b border-ink-700 pb-4">
        <legend className="mb-2 text-sm text-ink-200">Condición {index + 1}</legend>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Input id={`${id}-r-${row.id}`} label={`Residuo ${index + 1}`} value={row.residue} required aria-describedby={`${id}-help`} onChange={event => change(row.id, 'residue', event.target.value)} />
          <Input id={`${id}-m-${row.id}`} label={`Módulo ${index + 1}`} value={row.modulus} required aria-describedby={`${id}-help`} onChange={event => change(row.id, 'modulus', event.target.value)} />
          <Button type="button" variant="secondary" disabled={rows.length === 1} onClick={() => { invalidate(); setRows(current => current.filter(item => item.id !== row.id)); }} aria-label={`Quitar condición ${index + 1}`}>Quitar</Button>
        </div>
      </fieldset>)}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={() => { invalidate(); const rowId = nextId.current++; setRows(current => [...current, { id: rowId, residue: '', modulus: '' }]); }}>Añadir condición</Button>
        <Button type="submit" loading={busy}>{busy ? 'Resolviendo…' : 'Resolver sistema de congruencias'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setRows(example); }}>Cargar ejemplo no coprimo</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado del sistema de congruencias" className="mt-5 min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{result.status === 'solved' ? 'Todas las soluciones del sistema' : 'Sistema sin solución'}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar sistema y comprobación</Button>
      </div>
      {result.status === 'solved' ? <>
        <p className="font-mono text-lg text-amber-300 break-all">{family(result)}</p>
        <p className="text-sm text-ink-200">{result.all_integers ? 'Cualquier entero cumple todas las condiciones.' : 'El residuo es el menor no negativo y el período es el mínimo común múltiplo de los módulos. k puede ser cualquier entero.'}</p>
      </> : <p className="text-sm text-ink-200 break-words">La condición {(result.conflict?.index ?? 0) + 1} es incompatible con las anteriores. La diferencia de residuos ({result.conflict?.difference}) no es divisible por su MCD ({result.conflict?.gcd}); el resto es {result.conflict?.compatibility_remainder}.</p>}
      <details className="text-sm text-ink-200">
        <summary className="cursor-pointer font-medium text-ink-100">Comprobación exacta del sistema</summary>
        <div className="mt-3 space-y-2 font-mono break-all">
          {result.constraints.map((row, index) => <p key={index}>x ≡ {row.residue_exact} (mod {row.modulus_exact})</p>)}
          {result.checks.map(row => <p key={row.index}>{result.residue} mod {row.modulus} = {row.actual}; esperado {row.expected}. Período mod {row.modulus} = {row.period_remainder}.</p>)}
          {result.conflict && <p>Clase previa: x = {result.conflict.prior_residue} + k × {result.conflict.prior_period}; MCD = {result.conflict.gcd}; resto = {result.conflict.compatibility_remainder}.</p>}
        </div>
      </details>
      {copied && <p role="status" className="text-sm text-ink-200">{copied}</p>}
    </section>}
  </details>;
}
