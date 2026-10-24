import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Select } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useCopilotDraft } from '@/ui/hooks/useCopilotDraft';

type Operation = 'determinant' | 'inverse' | 'rref' | 'multiply' | 'nullspace';
type Result = { operation: Operation; original_matrix: string[][]; matrix_exact: string[][]; rows: number; columns: number;
  status: 'computed' | 'singular'; determinant_exact?: string; inverse_exact?: string[][] | null; residuals_exact?: string[][];
  verified?: boolean | null; rref_exact?: string[][]; rank?: number; pivot_columns_one_based?: number[];
  original_right_matrix?: string[][]; right_matrix_exact?: string[][]; right_rows?: number; right_columns?: number;
  product_exact?: string[][]; product_rows?: number; product_columns?: number;
  nullity?: number; nullspace_basis_exact?: string[][]; nullspace_residuals_exact?: string[][] };
const titles: Record<Operation, string> = { determinant: 'Determinante', inverse: 'Inversa', rref: 'Reducción por filas', multiply: 'Producto A · B', nullspace: 'Núcleo A · x = 0' };
const examples: Record<string, { matrix: string; operation: Operation; right?: string }> = {
  inverse: { matrix: '1; 2\n3; 4', operation: 'inverse' }, fractions: { matrix: '1/2; 1/3\n2; 3', operation: 'inverse' },
  singular: { matrix: '1; 2\n2; 4', operation: 'inverse' }, rectangular: { matrix: '1; 2; 3\n2; 4; 6', operation: 'rref' },
  product: { matrix: '1/2; 1; -2\n0; 3; 1', right: '2; 0\n1/3; 4\n-1; 2', operation: 'multiply' },
  nullspace: { matrix: '1/2; 1; -1\n1; 2; -2', operation: 'nullspace' },
};

function ExactMatrix({ title, values }: { title: string; values: string[][] }) {
  return <div role="region" aria-label={title} tabIndex={0} className="overflow-x-auto rounded border border-ink-700 focus:outline-none focus:ring-2 focus:ring-amber-500">
    <table className="w-full text-sm border-collapse">
      <caption className="text-left px-3 py-2 text-ink-200 font-medium">{title}</caption>
      <thead><tr><th scope="col" className="px-3 py-2 text-left text-ink-300">Fila</th>
        {values[0].map((_, index) => <th key={index} scope="col" className="px-3 py-2 text-right whitespace-nowrap text-ink-300">C{index + 1}</th>)}
      </tr></thead>
      <tbody>{values.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-ink-800">
        <th scope="row" className="px-3 py-2 text-left text-ink-300">F{rowIndex + 1}</th>
        {row.map((cell, index) => <td key={index} className="px-3 py-2 text-right font-mono text-ink-100 whitespace-nowrap">{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function MatrixPanel() {
  const [matrix, setMatrix] = useState(examples.inverse.matrix), [operation, setOperation] = useState<Operation>('inverse');
  const [right, setRight] = useState('1; 0\n0; 1');
  const [example, setExample] = useState('inverse'), [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useCopilotDraft('math_matrix', undefined, { matrix, right_matrix: right, operation, result, busy, error }, open);
  function invalidate() { generation.current++; setResult(null); setError(''); setCopied(''); setBusy(false); }
  async function calculate(event: FormEvent) {
    event.preventDefault(); invalidate(); const request = generation.current; setBusy(true);
    try {
      const parse = (text: string, name: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
        const cells = line.split(';').map(value => value.trim());
        if (cells.some(value => !value)) throw new Error(`${name}, fila ${index + 1}: completa todos los números separados por punto y coma.`);
        return cells;
      });
      const rows = parse(matrix, 'Matriz A');
      if (!rows.length) throw new Error('Escribe al menos una fila de números.');
      const body = { matrix: rows, operation, ...(operation === 'multiply' ? { right_matrix: parse(right, 'Matriz B') } : {}) };
      const next = await hoardJson<Result>('/math/matrix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (request === generation.current) setResult(next);
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : 'No se pudo calcular. Conservamos la matriz para que la revises.');
    } finally { if (request === generation.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const request = generation.current;
    const block = (name: string, values: string[][]) => [name, ...values.map(row => row.join('\t'))];
    const text = [`Matrices exactas · ${titles[result.operation]}`, ...block('Entrada escrita', result.original_matrix),
      ...block('Matriz A exacta', result.matrix_exact),
      ...(result.original_right_matrix ? block('Entrada B escrita', result.original_right_matrix) : []),
      ...(result.right_matrix_exact ? block('Matriz B exacta', result.right_matrix_exact) : []),
      ...(result.product_exact ? [`Dimensiones: ${result.rows} × ${result.columns} por ${result.right_rows} × ${result.right_columns} = ${result.product_rows} × ${result.product_columns}`, ...block('Producto A · B exacto', result.product_exact)] : []),
      ...(result.determinant_exact != null ? [`Determinante: ${result.determinant_exact}`] : []),
      ...(result.status === 'singular' ? ['Matriz singular: no existe inversa.'] : []),
      ...(result.inverse_exact ? block('Inversa exacta', result.inverse_exact) : []),
      ...(result.residuals_exact ? block('Comprobación A * inversa - I', result.residuals_exact) : []),
      ...(result.rref_exact ? [...block('Forma reducida por filas', result.rref_exact), `Rango: ${result.rank}`, `Columnas pivote (desde 1): ${result.pivot_columns_one_based?.join('; ') || 'ninguna'}`] : []),
      ...(result.nullspace_basis_exact ? [`Núcleo A * x = 0. Rango: ${result.rank}. Dimensión del núcleo: ${result.nullity}.`,
        ...(result.nullspace_basis_exact.length ? result.nullspace_basis_exact.flatMap((vector, index) => [`Vector ${index + 1}: ${vector.join('; ')}`, `A * vector ${index + 1}: ${result.nullspace_residuals_exact?.[index].join('; ')}`]) : ['Base vacía: la única solución es el vector cero.']),
        'Todas las soluciones son combinaciones lineales de estos vectores; la base no es única ni necesariamente ortonormal.'] : []),
      'Cálculo racional exacto; no incluye una demostración paso a paso.'].join('\n');
    try { await navigator.clipboard.writeText(text); if (request === generation.current) setCopied('Entradas y resultado copiados.'); }
    catch { if (request === generation.current) setCopied('No se pudo copiar. Selecciona los valores para copiarlos manualmente.'); }
  }
  return <details className="mb-6 border-b border-ink-700 pb-3" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) invalidate(); }}>
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Matrices exactas
      <span className="block mt-1 text-ink-300 font-normal">Determinantes, inversas, reducción por filas, producto A · B y núcleo con fracciones exactas</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={calculate} onChange={invalidate}>
      <div><label htmlFor="matrix-input" className="block text-sm font-medium text-ink-200 mb-1">{operation === 'multiply' ? 'Filas de la matriz A' : 'Filas de la matriz'}</label>
        <textarea id="matrix-input" required rows={4} value={matrix} onChange={event => setMatrix(event.target.value)} aria-describedby="matrix-help"
          className="w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <p id="matrix-help" className="mt-1 text-sm text-ink-300">Una fila por línea; separa números con punto y coma. Mismo número de columnas en cada fila. Usa enteros, fracciones o punto decimal, sin variables.</p>
      </div>
      {operation === 'multiply' && <div>
        <label htmlFor="matrix-right" className="block text-sm font-medium text-ink-200 mb-1">Filas de la matriz B</label>
        <textarea id="matrix-right" required rows={4} value={right} onChange={event => setRight(event.target.value)} aria-describedby="matrix-help matrix-product-help"
          className="w-full rounded border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <p id="matrix-product-help" className="mt-1 text-sm text-ink-300">Las columnas de A deben coincidir con las filas de B. Calcula A · B en ese orden; cada celda combina una fila de A con una columna de B.</p>
      </div>}
      <div className="flex flex-wrap items-end gap-3">
        <Select id="matrix-operation" label="Operación con la matriz" value={operation} onChange={event => setOperation(event.target.value as Operation)}>
          {Object.entries(titles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
        <Select id="matrix-example" label="Ejemplo de matriz" value={example} onChange={event => setExample(event.target.value)}>
          <option value="inverse">Matriz invertible</option><option value="fractions">Coeficientes racionales</option>
          <option value="singular">Matriz singular</option><option value="rectangular">Rectangular y rango</option>
          <option value="product">Producto rectangular A · B</option>
          <option value="nullspace">Núcleo de una matriz rectangular</option>
        </Select>
        <Button type="button" variant="secondary" onClick={() => { invalidate(); setMatrix(examples[example].matrix); if (examples[example].right) setRight(examples[example].right!); setOperation(examples[example].operation); }}>Cargar matriz de ejemplo</Button>
        <Button type="submit" loading={busy}>{busy ? 'Calculando matriz…' : 'Calcular matriz'}</Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result && <section aria-label="Resultado de matrices exactas" className="mt-5 space-y-4 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100" aria-live="polite">{titles[result.operation]} · {result.product_rows ?? result.rows} × {result.product_columns ?? result.columns}</h2>
        <Button type="button" variant="secondary" onClick={copy}>Copiar matriz y resultado</Button>
      </div>
      <ExactMatrix title="Matriz A" values={result.matrix_exact} />
      {result.right_matrix_exact && result.product_exact && <>
        <ExactMatrix title="Matriz B" values={result.right_matrix_exact} />
        <p className="text-sm text-ink-200">A ({result.rows} × {result.columns}) · B ({result.right_rows} × {result.right_columns}) = {result.product_rows} × {result.product_columns}.</p>
        <ExactMatrix title="Producto A · B exacto" values={result.product_exact} />
      </>}
      {result.determinant_exact != null && <p className="text-ink-200 break-all">Determinante: <span className="font-mono">{result.determinant_exact}</span></p>}
      {result.status === 'singular' && <p role="status" className="text-ink-200">La matriz es singular: su determinante es cero y no existe inversa.</p>}
      {result.inverse_exact && <><ExactMatrix title="Matriz inversa" values={result.inverse_exact} />
        <p className="text-sm text-ink-200">{result.verified ? 'Comprobación exacta: A por su inversa da la identidad.' : 'La comprobación presenta diferencias.'}</p>
        {result.residuals_exact && <details><summary className="text-sm text-amber-400 cursor-pointer">Ver residuos de A por inversa menos identidad</summary>
          <div className="mt-3"><ExactMatrix title="Residuos A · inversa − I" values={result.residuals_exact} /></div>
        </details>}
      </>}
      {result.rref_exact && <><ExactMatrix title="Forma reducida por filas" values={result.rref_exact} />
        <p className="text-sm text-ink-200">Rango: {result.rank}. Columnas pivote, contando desde 1: {result.pivot_columns_one_based?.join(', ') || 'ninguna'}.</p>
      </>}
      {result.nullspace_basis_exact && <section aria-label="Base del núcleo" className="space-y-4">
        <h3 className="font-display text-lg text-ink-100">Base del núcleo A · x = 0</h3>
        <p className="text-sm text-ink-200">Rango: {result.rank}. Dimensión del núcleo: {result.nullity}. Coordenadas en el orden de las columnas de A.</p>
        {result.nullspace_basis_exact.length ? <>
          <p className="text-sm text-ink-200">Todas las soluciones son combinaciones lineales de estos vectores. La base no es única ni necesariamente ortonormal.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{result.nullspace_basis_exact.map((vector, index) => <ExactMatrix key={index} title={`Vector ${index + 1}`} values={vector.map(cell => [cell])} />)}</div>
          <p className="text-sm text-ink-200">{result.verified ? 'Comprobación exacta: A por cada vector de la base da el vector cero.' : 'La comprobación presenta diferencias.'}</p>
          <details><summary className="text-sm text-amber-400 cursor-pointer">Ver residuos A · vector</summary>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">{result.nullspace_residuals_exact?.map((vector, index) => <ExactMatrix key={index} title={`A · vector ${index + 1}`} values={vector.map(cell => [cell])} />)}</div>
          </details>
        </> : <p role="status" className="text-sm text-ink-200">La base está vacía: la única solución de A · x = 0 es el vector cero de {result.columns} coordenadas.</p>}
      </section>}
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">Determinante e inversa requieren una matriz cuadrada; la reducción por filas y el núcleo admiten matrices rectangulares. Cálculo racional exacto, sin demostrar los pasos. No se guarda nada en el banco.</p>
  </details>;
}
