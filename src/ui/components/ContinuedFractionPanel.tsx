import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Result = { input: string; exact: string; coefficients: string[]; convergents: string[];
  notation: string; reconstructed: string; verified: boolean };

export function ContinuedFractionPanel() {
  const id = useId(), generation = useRef(0);
  const [value, setValue] = useState('355/113'), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [copied, setCopied] = useState('');
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_continued_fraction', undefined, { value, result, busy, error }, open);
  function invalidate() { generation.current++; setBusy(false); setResult(null); setError(''); setCopied(''); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/continued-fraction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
      if (request === generation.current) setResult(next);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Revisa el número e inténtalo de nuevo.'); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const lines = [`${result.input} = ${result.exact}`, result.notation,
      ...result.coefficients.map((term, index) => `${index}: término ${term}; convergente ${result.convergents[index]}`),
      `Reconstrucción: ${result.reconstructed}; comprobación exacta: ${result.verified ? 'sí' : 'no'}`];
    try { await navigator.clipboard.writeText(lines.join('\n')); if (request === generation.current) setCopied('Fracción continua y convergentes copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Puedes seleccionar el resultado para copiarlo manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Fracciones continuas
      <span className="block mt-1 text-ink-300 font-normal">Descomponer un racional y obtener sus convergentes exactos</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate}>
      <p id={`${id}-help`} className="text-sm text-ink-300">Escribe un entero, decimal finito o fracción de enteros, por ejemplo −3/8 (con el signo - del teclado). No admite π, raíces ni expansiones periódicas de irracionales. Los negativos usan cocientes redondeados hacia abajo.</p>
      <Input id={`${id}-value`} label="Número racional" value={value} required aria-describedby={`${id}-help`} onChange={event => { invalidate(); setValue(event.target.value); }} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy}>{busy ? 'Calculando…' : 'Calcular fracción continua'}</Button>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setValue('355/113'); }}>Cargar ejemplo 355/113</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de la fracción continua" className="mt-5 min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">Fracción continua finita</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar fracción y convergentes</Button>
      </div>
      <p className="font-mono text-lg text-amber-300 break-all">{result.exact} = {result.notation}</p>
      <p className="text-sm text-ink-300">Cada fila usa los términos hasta ese índice. El último convergente reconstruye el número completo, sin redondeo decimal.</p>
      <div className="max-w-full overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500" role="region" aria-label="Tabla de términos y convergentes" tabIndex={0}>
        <table className="w-full text-sm text-left text-ink-200">
          <caption className="sr-only">Términos y convergentes, con índice inicial cero</caption>
          <thead><tr className="border-b border-ink-700"><th scope="col" className="py-2 pr-3">Índice</th><th scope="col" className="py-2 pr-3">Término</th><th scope="col" className="py-2">Convergente</th></tr></thead>
          <tbody>{result.coefficients.map((term, index) => <tr key={index} className="border-b border-ink-700"><th scope="row" className="py-2 pr-3 font-normal tabular-nums">{index}</th><td className="py-2 pr-3 font-mono">{term}</td><td className="py-2 font-mono">{result.convergents[index]}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="text-sm text-ink-200 break-all">Reconstrucción: <span className="font-mono">{result.reconstructed}</span>. Comprobación exacta: {result.verified ? 'coincide con el racional de entrada.' : 'no coincide con la entrada.'}</p>
      {copied && <p role="status" className="text-sm text-ink-200">{copied}</p>}
    </section>}
  </details>;
}
