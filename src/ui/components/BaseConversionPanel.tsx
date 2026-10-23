import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Result = { number: string; source_base: number; target_base: number; source_normalized: string; result: string;
  decimal: string; verified: boolean; equivalents: { base: number; value: string }[] };
const names: Record<number, string> = { 2: 'binario', 8: 'octal', 10: 'decimal', 16: 'hexadecimal' };
const bases = Array.from({ length: 35 }, (_, index) => index + 2);
const examples = { hex: { number: 'FF', source: '16', target: '10' }, large: { number: '9007199254740993', source: '10', target: '16' }, negative: { number: '-101010', source: '2', target: '10' } };

export function BaseConversionPanel() {
  const [number, setNumber] = useState('FF'), [source, setSource] = useState('16'), [target, setTarget] = useState('10');
  const [example, setExample] = useState<keyof typeof examples>('hex'), [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_base_conversion', undefined, { number, source_base: source, target_base: target, result, busy, error }, open);
  function invalidate() { generation.current++; setResult(null); setBusy(false); setError(''); setCopied(''); }
  async function convert(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const next = await hoardJson<Result>('/math/base-convert', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, source_base: Number(source), target_base: Number(target) }) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo convertir. Revisa los dígitos y la base de origen.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const text = ['Conversión exacta de bases', `Entrada: ${result.number} (base ${result.source_base})`,
      `Entrada normalizada: ${result.source_normalized}`, `Resultado: ${result.result} (base ${result.target_base})`,
      ...result.equivalents.map(item => `Base ${item.base}: ${item.value}`),
      `Comprobación exacta: ${result.verified ? 'correcta' : 'hay diferencias'}`,
      'Entero con signo; sin ancho de bits ni complemento a dos.'].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Conversión y equivalencias copiadas.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Selecciona los valores para copiarlos manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Conversión de bases
      <span className="block mt-1 text-ink-300 font-normal">Convierte enteros entre bases 2–36 sin redondear su valor</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={convert} onChange={invalidate}>
      <Input id="base-number" label="Entero que quieres convertir" required value={number} onChange={event => setNumber(event.target.value)} aria-describedby="base-help" placeholder="FF" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select id="base-source" label="Base de origen" value={source} onChange={event => setSource(event.target.value)}>
          {bases.map(base => <option key={base} value={base}>{base}{names[base] ? ` · ${names[base]}` : ''}</option>)}
        </Select>
        <Select id="base-target" label="Base de destino" value={target} onChange={event => setTarget(event.target.value)}>
          {bases.map(base => <option key={base} value={base}>{base}{names[base] ? ` · ${names[base]}` : ''}</option>)}
        </Select>
      </div>
      <p id="base-help" className="text-sm text-ink-300">Dígitos 0–9 y letras A–Z, sin distinguir mayúsculas. Admite signo y guion bajo entre dígitos. Los prefijos 0b, 0o y 0x corresponden a las bases 2, 8 y 16; selecciona la base correcta.</p>
      <div className="flex flex-wrap items-end gap-3">
        <Select id="base-example" label="Ejemplo de conversión" value={example} onChange={event => setExample(event.target.value as keyof typeof examples)}>
          <option value="hex">Hexadecimal a decimal</option><option value="large">Entero grande exacto</option><option value="negative">Binario negativo</option>
        </Select>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); const next = examples[example]; setNumber(next.number); setSource(next.source); setTarget(next.target); }}>Cargar entero de ejemplo</Button>
        <Button type="submit" loading={busy}>{busy ? 'Convirtiendo…' : 'Convertir entero'}</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de la conversión de bases" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">Resultado en base {result.target_base}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar conversión y equivalencias</Button>
      </div>
      <p className="font-mono text-lg text-ink-100 break-all">{result.result}</p>
      <p className="text-sm text-ink-300 break-all">Entrada normalizada en base {result.source_base}: <span className="font-mono">{result.source_normalized}</span></p>
      <dl className="divide-y divide-ink-800">
        {result.equivalents.map(item => <div key={item.base} className="py-3 grid grid-cols-1 sm:grid-cols-[10rem_minmax(0,1fr)] gap-1 sm:gap-4">
          <dt className="text-sm text-ink-300">Base {item.base} · {names[item.base]}</dt><dd className="font-mono text-ink-100 break-all min-w-0">{item.value}</dd>
        </div>)}
      </dl>
      <p className="text-sm text-ink-200">{result.verified ? 'Comprobación exacta: el resultado representa el mismo entero.' : 'La comprobación presenta diferencias.'}</p>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">Enteros con signo, sin fracciones, ancho fijo de bits ni complemento a dos. Se aplican los límites de conversión de enteros del motor local. No se guarda nada en el banco.</p>
  </details>;
}
