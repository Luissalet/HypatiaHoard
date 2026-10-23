import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/ui/components';
import { hoardJson } from '@/data/hoardClient';
import { useStore } from '@/ui/store';

type CalendarEvent = { id: string; name: string; subject: string; date: string; time: string | null; type: string; status: string };
type Calendar = {
  date_from: string; date_to: string; generated_at: string; filename: string; ics: string;
  events: CalendarEvent[]; excluded: { id: string; name: string; subject: string; reason: string }[];
  completed_skipped: number; outside_range: number;
};
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dayLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'});
const statusLabel: Record<string,string> = {pending:'Pendiente',in_progress:'En progreso',done:'Hecho',submitted:'Entregado'};

export function StudyCalendarPanel({subjectId, subjectName}: {subjectId: string; subjectName: string}) {
  const [from,setFrom]=useState(()=>localDate(new Date()));
  const [to,setTo]=useState(()=>{const d=new Date();d.setMonth(d.getMonth()+3);return localDate(d);});
  const [all,setAll]=useState(false), [completed,setCompleted]=useState(false);
  const [result,setResult]=useState<Calendar|null>(null), [busy,setBusy]=useState(false);
  const [error,setError]=useState(''), [notice,setNotice]=useState(''), [downloaded,setDownloaded]=useState(false);
  const clear=()=>{setResult(null);setError('');setNotice('');setDownloaded(false);};
  async function preview(event: FormEvent) {
    event.preventDefault();clear();setBusy(true);
    try {
      const {syncNow,serverIdFor}=await import('@/data/hoardSync');
      await syncNow();
      const sync=useStore.getState().hoardStatus;
      const snapshot=await hoardJson<Calendar>('/study/calendar/export',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date_from:from,date_to:to,
          subject:all?null:serverIdFor('subject',subjectId),include_completed:completed}),
      });
      setResult(snapshot);
      setNotice(sync?.error?`La sincronización indicó: ${sync.error}. Esta vista usa los registros actuales del servidor; puede faltar algún cambio local.`
        :'Vista del banco sincronizado con el servidor local. La descarga contiene exactamente estas fechas.');
    } catch(failure) {setError(failure instanceof Error?failure.message:'No se ha podido mostrar el calendario.');}
    finally {setBusy(false);}
  }
  function download() {
    if(!result)return;
    const url=URL.createObjectURL(new Blob([result.ics],{type:'text/calendar;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);setDownloaded(true);
  }
  return <details className="border-y border-ink-700 py-4">
    <summary className="cursor-pointer font-medium text-amber-400 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500">
      Llevar fechas al calendario
      <span className="block mt-1 text-sm font-normal text-ink-300">Entregas y exámenes guardados, con vista previa antes de descargar</span>
    </summary>
    <form className="mt-5 space-y-4" onSubmit={preview} onChange={clear}>
      <fieldset disabled={busy} className="space-y-4 min-w-0">
        <p className="text-sm text-ink-200">{all?'Todas las asignaturas':subjectName}. Se incluyen las fechas límite guardadas; no se crean sesiones de estudio ni recordatorios.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input id="study-calendar-from" label="Desde" type="date" required value={from} onChange={e=>setFrom(e.target.value)} />
          <Input id="study-calendar-to" label="Hasta" type="date" required value={to} onChange={e=>setTo(e.target.value)} />
        </div>
        <div className="flex flex-col gap-3 text-sm text-ink-200">
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-amber-500" checked={all} onChange={e=>setAll(e.target.checked)} />Todas las asignaturas</label>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-amber-500" checked={completed} onChange={e=>setCompleted(e.target.checked)} />Incluir hechos y entregados</label>
        </div>
        <p className="text-sm text-ink-300">Sin hora: día completo. Con hora: se conserva la hora local guardada, sin zona horaria asignada; al viajar no se convierte a otra zona.</p>
        <Button type="submit" variant="secondary" loading={busy}>{busy?'Preparando calendario…':'Mostrar calendario'}</Button>
        <p className="text-xs text-ink-400">Al mostrarlo se sincroniza el banco con el servidor local de Hypatia.</p>
      </fieldset>
    </form>
    {error&&<p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
    {result&&<section aria-label="Vista previa del calendario" className="mt-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-ink-700 pt-4">
        <div><h3 className="font-medium text-ink-100">{result.events.length} {result.events.length===1?'fecha exportable':'fechas exportables'}</h3>
          <p className="text-sm text-ink-300">{dayLabel(result.date_from)} – {dayLabel(result.date_to)}</p></div>
        <Button type="button" onClick={download} disabled={!result.events.length}>Descargar .ics</Button>
      </div>
      <p role="status" className="text-sm text-ink-300">{downloaded?'Descarga preparada. Puedes importar el archivo en tu aplicación de calendario.':notice}</p>
      {downloaded&&<p className="text-sm text-ink-300">{notice}</p>}
      {result.events.length?<ol className="divide-y divide-ink-800">
        {result.events.map(item=><li key={item.id} className="py-3 space-y-1 min-w-0">
          <p className="font-medium text-ink-100 break-words">{item.name}</p>
          <p className="text-sm text-ink-200">{dayLabel(item.date)} · {item.time??'Día completo'}</p>
          <p className="text-sm text-ink-300 break-words">{item.subject} · {item.type==='exam'?'Examen':'Entrega'} · {statusLabel[item.status]??item.status}</p>
        </li>)}
      </ol>:<p className="text-sm text-ink-200">No hay fechas exportables con estos filtros. Cambia el periodo o incluye los elementos completados.</p>}
      {!!result.excluded.length&&<details>
        <summary className="text-sm text-amber-400 cursor-pointer">{result.excluded.length} {result.excluded.length===1?'elemento no exportable':'elementos no exportables'}</summary>
        <ul className="mt-2 space-y-2 text-sm text-ink-200">{result.excluded.map(item=><li key={item.id} className="break-words">{item.name} · {item.subject}: {item.reason}</li>)}</ul>
      </details>}
      <p className="text-xs text-ink-400">{result.completed_skipped} hechos/entregados omitidos · {result.outside_range} fuera del periodo. Vista preparada {new Date(result.generated_at).toLocaleString('es-ES')}. Es una instantánea; no se actualiza automáticamente en tu calendario.</p>
    </section>}
  </details>;
}
