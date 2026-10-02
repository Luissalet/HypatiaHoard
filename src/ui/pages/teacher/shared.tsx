/**
 * Piezas comunes de las pantallas del Profesor: recarga al cambiar los datos
 * (escrituras locales o sincronización con Hypatia), cabecera, estado de modelos
 * y la barra de progreso de un trabajo del servidor.
 */

import { useEffect, useRef, useState, type DependencyList, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import { TEACHER_CHANGED } from '@/data/teacherRepo';
import { useHoardMode } from '@/data/hoardMode';
import { getCapabilities, type HoardCapabilities } from '@/data/hoardClient';
import { FINAL_JOB, getJob, type TeacherJob } from '@/data/teacherClient';
import { teacherSyncNow } from '@/data/teacherSync';
import { RoleSwitch } from '@/ui/components/RoleSwitch';

/** Contador que sube cuando cambian los datos del profesor (para recargar). */
export function useTeacherTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(TEACHER_CHANGED, bump);
    window.addEventListener('hypatia-synced', bump);
    return () => {
      window.removeEventListener(TEACHER_CHANGED, bump);
      window.removeEventListener('hypatia-synced', bump);
    };
  }, []);
  return tick;
}

/** Carga asíncrona simple con recarga por dependencias. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, initial: T): [T, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((v) => { if (alive) { setValue(v); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [value, loading];
}

export interface ModelCaps extends HoardCapabilities { hoard: boolean }

/** ¿Hay servidor local y modelos? (en el build público, nunca). */
export function useModelCaps(): ModelCaps {
  const hoard = useHoardMode();
  const [caps, setCaps] = useState<HoardCapabilities>({ llm: false, embeddings: false, tts: false, vision: false });
  useEffect(() => {
    if (!hoard) return;
    let alive = true;
    void getCapabilities(true).then((c) => { if (alive) setCaps(c); });
    void teacherSyncNow();
    return () => { alive = false; };
  }, [hoard]);
  return { hoard, ...caps };
}

export function TeacherHeader({ title, back = '/teacher', right }: { title: string; back?: string; right?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="border-b border-ink-800 bg-ink-900/50 backdrop-blur-sm sticky top-0 z-10">
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate(back)} className="text-ink-400 hover:text-ink-200 text-sm transition-colors shrink-0">
          ← {back === '/' ? 'Inicio' : 'Profesor'}
        </button>
        <h1 className="font-display text-lg sm:text-xl text-ink-100 truncate flex-1 min-w-0">{title}</h1>
        <div className="flex items-center gap-2 shrink-0">
          {right}
          <RoleSwitch compact />
        </div>
      </div>
    </header>
  );
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'En cola', running: 'Trabajando', done: 'Terminado', no_model: 'Sin modelo', no_sources: 'Sin fuentes',
  error: 'Error', cancelled: 'Cancelado',
};

/** Progreso de un trabajo del servidor (generación o corrección) hasta que termina. */
export function JobBanner({ jobId, onFinished }: { jobId: string; onFinished?: (job: TeacherJob) => void }) {
  const [job, setJob] = useState<TeacherJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
    let alive = true;
    const tick = async () => {
      try {
        const j = await getJob(jobId);
        if (!alive) return;
        setJob(j);
        if (FINAL_JOB.includes(j.status)) {
          if (!done.current) {
            done.current = true;
            await teacherSyncNow();
            onFinished?.(j);
          }
          return;
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      if (alive) setTimeout(tick, 1500);
    };
    void tick();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
  if (error) return <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>;
  if (!job) return null;
  const total = job.progress?.total ?? 0;
  const pct = total ? Math.round(((job.progress?.done ?? 0) / total) * 100) : job.status === 'done' ? 100 : 0;
  const bad = job.status === 'error' || job.status === 'no_model' || job.status === 'no_sources';
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${bad ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-ink-700 bg-ink-800 text-ink-300'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {job.kind === 'exam_generate' ? 'Generación de preguntas' : 'Corrección con IA'} · {STATUS_TEXT[job.status] ?? job.status}
          {job.progress?.label && !FINAL_JOB.includes(job.status) ? ` · ${job.progress.label}` : ''}
        </span>
        {total > 0 && <span>{job.progress.done}/{total}</span>}
      </div>
      {!FINAL_JOB.includes(job.status) && (
        <div className="h-1 bg-ink-700 rounded-full mt-2 overflow-hidden">
          <div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.max(pct, 5)}%` }} />
        </div>
      )}
      {(job.note || job.error) && <p className="mt-1">{job.error ?? job.note}</p>}
    </div>
  );
}

export function downloadText(text: string, filename: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`;
}

export function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : String(v).replace('.', ',');
}

export const TYPE_SHORT: Record<string, string> = { TEST: 'Test', DESARROLLO: 'Desarrollo', COMPLETAR: 'Completar', PRACTICO: 'Práctico' };

/**
 * Campo que se guarda al salir (blur) y que se actualiza con el valor guardado solo
 * cuando no se está escribiendo en él: guardar una casilla no borra lo que se está
 * tecleando en la siguiente, y una importación o sincronización se ve al momento.
 */
export function CommitInput({ stored, onCommit, ...rest }: { stored: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur'>) {
  const [value, setValue] = useState(stored);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setValue(stored); }, [stored]);
  return (
    <input {...rest} value={value} onChange={(e) => setValue(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; if (value !== stored) onCommit(value); }} />
  );
}

export function CommitTextarea({ stored, onCommit, ...rest }: { stored: string; onCommit: (v: string) => void } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange' | 'onBlur'>) {
  const [value, setValue] = useState(stored);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setValue(stored); }, [stored]);
  return (
    <textarea {...rest} value={value} onChange={(e) => setValue(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; if (value !== stored) onCommit(value); }} />
  );
}
