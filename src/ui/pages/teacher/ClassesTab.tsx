/** Clases: grupos (nombre, curso, año, asignaturas) y sus alumnos (nombre o alias). */

import { useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Input, Modal, Textarea } from '@/ui/components';
import { useStore } from '@/ui/store';
import { classRepo, studentRepo } from '@/data/teacherRepo';
import { parseRoster } from '@/domain/teacherCore';
import type { TeacherClass } from '@/domain/teacher';
import { useLoad, useTeacherTick } from './shared';

export function ClassesTab() {
  const tick = useTeacherTick();
  const subjects = useStore((s) => s.subjects);
  const [classes] = useLoad(() => classRepo.list(), [tick], [] as TeacherClass[]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', course: '', year: '', subjectIds: [] as string[] });
  const current = classes.find((c) => c.id === selected) ?? classes[0];

  const create = async () => {
    if (!form.name.trim()) return;
    const c = await classRepo.create({ name: form.name.trim(), course: form.course.trim() || null, year: form.year.trim() || null, subjectIds: form.subjectIds });
    setForm({ name: '', course: '', year: '', subjectIds: [] });
    setCreating(false);
    setSelected(c.id);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => setCreating(true)}>+ Nueva clase</Button>
        {classes.length === 0 && <p className="text-xs text-ink-500 px-1">Aún no hay clases.</p>}
        {classes.map((c) => (
          <button key={c.id} onClick={() => setSelected(c.id)}
            className={`text-left rounded-xl border px-3 py-2.5 transition-all ${current?.id === c.id ? 'border-amber-500/60 bg-amber-500/10' : 'border-ink-700 bg-ink-800 hover:border-ink-500'}`}>
            <p className="text-sm text-ink-100 font-medium">{c.name}</p>
            <p className="text-xs text-ink-500">{[c.course, c.year].filter(Boolean).join(' · ') || 'Sin curso'}</p>
          </button>
        ))}
      </div>
      {current ? <ClassDetail klass={current} subjects={subjects} tick={tick} /> : (
        <EmptyState title="Crea tu primera clase" description="Un grupo con sus alumnos (solo nombre o alias)." />
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nueva clase">
        <div className="flex flex-col gap-3">
          <Input label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2º B" autoFocus />
          <Input label="Curso" value={form.course} onChange={(e) => setForm({ ...form, course: e.target.value })} placeholder="2º de Bachillerato" />
          <Input label="Año académico" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} placeholder="2026-2027" />
          <SubjectPicker subjects={subjects} value={form.subjectIds} onChange={(subjectIds) => setForm({ ...form, subjectIds })} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>Cancelar</Button>
            <Button size="sm" onClick={create} disabled={!form.name.trim()}>Crear</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SubjectPicker({ subjects, value, onChange }: { subjects: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-400 uppercase tracking-widest">Asignaturas</span>
      <div className="flex flex-wrap gap-2">
        {subjects.length === 0 && <span className="text-xs text-ink-500">No hay asignaturas en el banco.</span>}
        {subjects.map((s) => {
          const on = value.includes(s.id);
          return (
            <button key={s.id} type="button" onClick={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])}
              className={`px-2.5 py-1 rounded-lg text-xs border ${on ? 'border-amber-500 bg-amber-500/15 text-amber-300' : 'border-ink-600 text-ink-300 hover:border-ink-400'}`}>
              {s.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ClassDetail({ klass, subjects, tick }: { klass: TeacherClass; subjects: { id: string; name: string }[]; tick: number }) {
  const [students] = useLoad(() => studentRepo.byClass(klass.id), [klass.id, tick], []);
  const [name, setName] = useState('');
  const [roster, setRoster] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ name: klass.name, course: klass.course ?? '', year: klass.year ?? '', subjectIds: klass.subjectIds });
  const preview = useMemo(() => parseRoster(roster), [roster]);
  const subjectNames = klass.subjectIds.map((id) => subjects.find((s) => s.id === id)?.name ?? '—');

  const addOne = async () => {
    if (!name.trim()) return;
    const res = await studentRepo.addMany(klass.id, [{ displayName: name }]);
    setMsg(res.skipped.length ? `«${res.skipped[0]}» ya estaba en la clase.` : '');
    setName('');
  };
  const importRoster = async () => {
    const res = await studentRepo.addMany(klass.id, preview.students);
    setMsg(`${res.added.length} añadidos${res.skipped.length + preview.skipped.length ? `, ${res.skipped.length + preview.skipped.length} omitidos (repetidos o vacíos)` : ''}.`);
    setRoster('');
    setShowImport(false);
  };

  return (
    <Card className="flex flex-col gap-4 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg text-ink-100">{klass.name}</h2>
          <p className="text-xs text-ink-500">{[klass.course, klass.year].filter(Boolean).join(' · ')}</p>
          <div className="flex flex-wrap gap-1 mt-2">{subjectNames.map((n, i) => <Badge key={i} color="amber">{n}</Badge>)}</div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setEdit({ name: klass.name, course: klass.course ?? '', year: klass.year ?? '', subjectIds: klass.subjectIds }); setEditing(true); }}>Editar</Button>
          <Button size="sm" variant="danger" onClick={async () => {
            if (confirm(`¿Borrar la clase «${klass.name}» con sus alumnos y entregas?`)) await classRepo.delete(klass.id);
          }}>Borrar</Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1"><Input placeholder="Nombre o alias del alumno" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addOne(); }} /></div>
        <Button size="sm" onClick={addOne} disabled={!name.trim()}>Añadir</Button>
        <Button size="sm" variant="secondary" onClick={() => setShowImport(true)}>Importar lista</Button>
      </div>
      {msg && <p className="text-xs text-ink-400">{msg}</p>}
      <p className="text-xs text-ink-500">Solo nombre o alias (y, si quieres, un email como referencia tuya). Estos datos se quedan en este equipo y en tu Hypatia: no se exportan ni se sincronizan con Gist.</p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-ink-500 border-b border-ink-700"><th className="py-1.5 pr-2">#</th><th className="pr-2">Alumno</th><th className="pr-2">Email</th><th /></tr></thead>
          <tbody>
            {students.map((s, i) => (
              <tr key={s.id} className="border-b border-ink-800">
                <td className="py-1.5 pr-2 text-ink-500 text-xs">{i + 1}</td>
                <td className="pr-2 text-ink-200">{s.displayName}</td>
                <td className="pr-2 text-ink-500 text-xs">{s.email ?? ''}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="text-xs text-ink-400 hover:text-ink-100 px-1" onClick={async () => {
                    const n = prompt('Nombre o alias', s.displayName);
                    if (n && n.trim()) await studentRepo.update(s.id, { displayName: n.trim() });
                  }}>Renombrar</button>
                  <button className="text-xs text-rose-400 hover:text-rose-300 px-1" onClick={async () => {
                    if (confirm(`¿Quitar a ${s.displayName}?`)) await studentRepo.delete(s.id);
                  }}>Quitar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {students.length === 0 && <p className="text-xs text-ink-500 py-3">Sin alumnos todavía.</p>}
      </div>

      <Modal open={showImport} onClose={() => setShowImport(false)} title="Importar lista de clase" size="lg">
        <div className="flex flex-col gap-3">
          <Textarea rows={8} value={roster} onChange={(e) => setRoster(e.target.value)}
            placeholder={'Un alumno por línea, o un CSV con cabecera:\nNombre;Apellidos;Correo\nAna;Ejemplo;ana@ejemplo.invalid'} />
          <p className="text-xs text-ink-400">{preview.students.length} alumnos detectados{preview.skipped.length ? ` · ${preview.skipped.length} líneas omitidas` : ''}.</p>
          <div className="max-h-40 overflow-y-auto text-xs text-ink-300">{preview.students.slice(0, 60).map((s, i) => <div key={i}>{s.displayName}{s.email ? ` · ${s.email}` : ''}</div>)}</div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>Cancelar</Button>
            <Button size="sm" onClick={importRoster} disabled={!preview.students.length}>Importar {preview.students.length}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={editing} onClose={() => setEditing(false)} title="Editar clase">
        <div className="flex flex-col gap-3">
          <Input label="Nombre" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <Input label="Curso" value={edit.course} onChange={(e) => setEdit({ ...edit, course: e.target.value })} />
          <Input label="Año académico" value={edit.year} onChange={(e) => setEdit({ ...edit, year: e.target.value })} />
          <SubjectPicker subjects={subjects} value={edit.subjectIds} onChange={(subjectIds) => setEdit({ ...edit, subjectIds })} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
            <Button size="sm" disabled={!edit.name.trim()} onClick={async () => {
              await classRepo.update(klass.id, { name: edit.name.trim(), course: edit.course.trim() || null, year: edit.year.trim() || null, subjectIds: edit.subjectIds });
              setEditing(false);
            }}>Guardar</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
