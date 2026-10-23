import { useState, type FormEvent } from 'react';
import { Button, Select } from '@/ui/components';
import { MdContent } from '@/ui/components/MdContent';
import { hoardJson } from '@/data/hoardClient';

type Value = { exact: string; latex: string; approx: string | null };
type LinearResult = {
  classification: 'unique' | 'infinite' | 'inconsistent'; variables: string[];
  solutions: Record<string, Value>; rank: number; augmented_rank: number;
  free_variables: string[]; rref_augmented: string[][]; residuals_exact: string[] | null; verified: boolean | null;
};
const NAMES=['x','y','z','u','v','w','p','q'];
const blank=()=>Array.from({length:12},()=>Array<string>(8).fill('0'));
const titles={unique:'Solución única',infinite:'Infinitas soluciones',inconsistent:'Sistema incompatible'};
const cellClass='w-full min-w-[4.5rem] rounded border border-ink-600 bg-ink-900 px-2 py-2 text-sm font-mono text-ink-100 focus:outline-none focus:ring-2 focus:ring-amber-500';
const samples={unique:{a:[['1/3','1/2'],['1','-1']],b:['1','0']},
  infinite:{a:[['1','1'],['2','2']],b:['1','2']},inconsistent:{a:[['1','1'],['2','2']],b:['1','3']}};

export function LinearSystemPanel() {
  const [rows,setRows]=useState(2),[columns,setColumns]=useState(2);
  const [names,setNames]=useState([...NAMES]),[matrix,setMatrix]=useState(blank),[rhs,setRhs]=useState(()=>Array<string>(12).fill('0'));
  const [example,setExample]=useState<keyof typeof samples>('unique');
  const [result,setResult]=useState<LinearResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState('');
  const clear=()=>{setResult(null);setError('');setCopied('');};
  function loadExample(){
    const sample=samples[example],next=blank();sample.a.forEach((row,i)=>row.forEach((value,j)=>{next[i][j]=value;}));
    setMatrix(next);setRhs([...sample.b,...Array<string>(10).fill('0')]);setNames([...NAMES]);setRows(2);setColumns(2);clear();
  }
  async function solve(event: FormEvent){
    event.preventDefault();clear();setBusy(true);
    try{setResult(await hoardJson<LinearResult>('/math/linear-system',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({coefficients:matrix.slice(0,rows).map(r=>r.slice(0,columns)),constants:rhs.slice(0,rows),variables:names.slice(0,columns)})}));}
    catch(failure){setError(failure instanceof Error?failure.message:'No se pudo resolver el sistema.');}
    finally{setBusy(false);}
  }
  async function copyResult(){
    if(!result)return;
    const text=[titles[result.classification],...result.variables.filter(v=>result.solutions[v]).map(v=>`${v} = ${result.solutions[v].exact}`),
      ...(result.free_variables.length?[`Variables libres: ${result.free_variables.join(', ')}`]:[]),`Rango A: ${result.rank}; rango [A | b]: ${result.augmented_rank}`,
      'Matriz reducida [A | b]:',...result.rref_augmented.map(row=>`${row.slice(0,-1).join('\t')}\t|\t${row[row.length-1]}`)].join('\n');
    try{await navigator.clipboard.writeText(text);setCopied('Resultado copiado.');}
    catch{setCopied('No se pudo copiar. Puedes seleccionar el resultado y copiarlo manualmente.');}
  }
  return <details className="mb-6 border-b border-ink-700 pb-3">
    <summary className="cursor-pointer text-sm text-amber-400 font-medium rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Sistemas lineales exactos
      <span className="block mt-1 text-ink-300 font-normal">Edita la matriz y consulta soluciones, variables libres y forma reducida</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={solve} onChange={clear}>
      <fieldset disabled={busy} className="space-y-4 min-w-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select id="linear-rows" label="Ecuaciones" value={rows} onChange={e=>setRows(Number(e.target.value))}>{Array.from({length:12},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</Select>
          <Select id="linear-columns" label="Incógnitas" value={columns} onChange={e=>setColumns(Number(e.target.value))}>{Array.from({length:8},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</Select>
        </div>
        <p className="text-sm text-ink-200">Cada fila es una ecuación: coeficientes de A, incógnitas en el orden de las columnas y resultado b. Admite enteros, fracciones como -1/3 y decimales con punto.</p>
        <div className="overflow-x-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500" role="region" aria-label="Editor de matriz aumentada" tabIndex={0}>
          <table className="w-full border-collapse text-left">
            <caption className="text-left text-sm text-ink-300 pb-2">Matriz aumentada [A | b] · desplaza la matriz si no cabe. Los datos se conservan al reducir y ampliar dimensiones.</caption>
            <thead><tr><th scope="col" className="pr-2 text-xs font-normal text-ink-300">Fila</th>
              {names.slice(0,columns).map((name,j)=><th key={j} scope="col" className="p-1 font-normal">
                <input aria-label={`Nombre de la incógnita ${j+1}`} required maxLength={20} pattern="[a-zA-Z][a-zA-Z0-9_]*" className={cellClass} value={name}
                  onChange={e=>setNames(previous=>previous.map((v,k)=>k===j?e.target.value:v))} />
              </th>)}<th scope="col" className="pl-3 text-sm text-ink-200">b</th></tr></thead>
            <tbody>{matrix.slice(0,rows).map((row,i)=><tr key={i}>
              <th scope="row" className="pr-2 text-xs font-normal text-ink-300">{i+1}</th>
              {row.slice(0,columns).map((value,j)=><td key={j} className="p-1"><input required maxLength={100} spellCheck={false} autoComplete="off" aria-label={`Coeficiente ${names[j]||j+1}, ecuación ${i+1}`} className={cellClass} value={value}
                onChange={e=>setMatrix(previous=>previous.map((r,k)=>k===i?r.map((v,c)=>c===j?e.target.value:v):r))} /></td>)}
              <td className="p-1 pl-3 border-l border-ink-600"><input required maxLength={100} spellCheck={false} autoComplete="off" aria-label={`Resultado b, ecuación ${i+1}`} className={cellClass} value={rhs[i]}
                onChange={e=>setRhs(previous=>previous.map((v,k)=>k===i?e.target.value:v))} /></td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs text-ink-300">Los nombres empiezan con una letra y deben ser distintos. Los decimales conservan sus dígitos exactos; no uses coma decimal.</p>
        <div className="flex flex-wrap gap-3 items-end">
          <Select id="linear-example" label="Ejemplo editable" value={example} onChange={e=>setExample(e.target.value as keyof typeof samples)}>
            <option value="unique">Solución única con fracciones</option><option value="infinite">Infinitas soluciones</option><option value="inconsistent">Sistema incompatible</option>
          </Select>
          <Button type="button" variant="secondary" onClick={loadExample}>Cargar sistema de ejemplo</Button>
          <Button type="submit" loading={busy}>{busy?'Resolviendo…':'Resolver sistema'}</Button>
        </div>
      </fieldset>
    </form>
    {error&&<p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result&&<section className="mt-5 space-y-4" aria-label="Resultado del sistema lineal">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 aria-live="polite" className="font-display text-lg text-ink-100">{titles[result.classification]}</h2><Button type="button" variant="secondary" onClick={copyResult}>Copiar resultado</Button></div>
      {result.classification==='inconsistent'?<p className="text-sm text-ink-200">Las ecuaciones se contradicen. No hay una solución común.</p>:<>
        {!!result.free_variables.length&&<p className="text-sm text-ink-200">Variables libres: {result.free_variables.join(', ')}. Puedes elegir sus valores; las demás incógnitas dependen de ellas.</p>}
        <dl className="divide-y divide-ink-800">{result.variables.map(v=><div key={v} className="py-3 min-w-0">
          <dt className="font-medium text-ink-100">{v}</dt><dd className="mt-1 space-y-2">
            <MdContent content={`$$${result.solutions[v].latex}$$`} className="overflow-x-auto text-ink-100" />
            <p className="font-mono text-sm text-ink-200 break-words">{result.solutions[v].exact}</p>
            {result.solutions[v].approx&&<p className="text-sm text-ink-300">Aproximación: {result.solutions[v].approx}</p>}
          </dd></div>)}</dl>
      </>}
      <p className="text-sm text-ink-300">Rango A: {result.rank} · rango [A | b]: {result.augmented_rank}{result.verified?' · comprobado por sustitución exacta':''}</p>
      <details><summary className="text-sm text-amber-400 cursor-pointer">Ver matriz reducida (RREF)</summary>
        <div className="overflow-x-auto mt-3 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500" role="region" aria-label="Matriz reducida aumentada" tabIndex={0}>
          <table className="w-full text-left text-sm font-mono"><caption className="text-left text-ink-300 pb-2 font-body">Forma reducida de [A | b]</caption>
            <thead><tr>{[...result.variables,'b'].map((v,j)=><th scope="col" key={j} className="p-2 text-ink-200 font-normal">{v}</th>)}</tr></thead>
            <tbody>{result.rref_augmented.map((row,i)=><tr key={i}>{row.map((v,j)=><td key={j} className={`p-2 text-ink-100 whitespace-nowrap ${j===result.variables.length?'border-l border-ink-600':''}`}>{v}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
      <p role="status" className="text-sm text-ink-200">{copied}</p>
    </section>}
    <p className="mt-4 text-sm text-ink-300">El motor exacto local resuelve A·x=b. No guarda el sistema en el banco ni presenta pasos de demostración.</p>
  </details>;
}
