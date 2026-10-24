import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@/ui/components';

type Destination = { id: string; title: string; keywords: string };
const searchable = (text: string) => text.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function CalculatorNavigator({ calculators }: { calculators: readonly Destination[] }) {
  const id = useId();
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(calculators[0].id);
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  const matches = calculators.filter(item => {
    const text = searchable(`${item.title} ${item.keywords}`);
    return terms.every(term => text.includes(term));
  });
  const destination = matches.find(item => item.id === selected) || matches[0];

  function open(event: FormEvent) {
    event.preventDefault();
    if (!destination) return;
    const section = document.getElementById(destination.id);
    const details = section?.querySelector('details');
    if (!section || !details) return;
    details.open = true;
    details.querySelector('summary')?.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  }

  return <section aria-labelledby={`${id}-title`} className="mb-6 border-b border-ink-700 pb-5">
    <h2 id={`${id}-title`} className="font-display text-lg text-ink-100">Calculadoras</h2>
    <p className="mt-1 text-sm text-ink-300">Localiza una operación y abre su formulario. Tus campos y las demás calculadoras permanecen disponibles.</p>
    <form onSubmit={open} className="mt-4 space-y-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Input id={`${id}-search`} type="search" label="Buscar calculadora" value={query} onChange={event => setQuery(event.target.value)} placeholder="Taylor, matrices, MCD…" />
        <Select id={`${id}-destination`} label="Calculadora" value={destination?.id || ''} disabled={!matches.length} onChange={event => setSelected(event.target.value)}>
          {matches.length ? matches.map(item => <option key={item.id} value={item.id}>{item.title}</option>) : <option value="">Sin coincidencias</option>}
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!destination}>Abrir calculadora</Button>
        {query && <Button type="button" variant="secondary" onClick={() => setQuery('')}>Ver todas</Button>}
        <p role="status" className="text-sm text-ink-300">{matches.length} de {calculators.length} calculadoras</p>
      </div>
      {!matches.length && <p className="text-sm text-ink-200">Prueba otro nombre o pulsa Ver todas. También puedes recorrer las calculadoras de abajo.</p>}
    </form>
  </section>;
}
