import { useEffect, useState } from 'react';
import { Card, Select } from '@/ui/components';
import { getSettings, saveSettings } from '@/data/db';
import { DEFAULT_RETENTION, MAX_RETENTION, MIN_RETENTION, clampRetention, fsrsPreview } from '@/domain/fsrs';

type Scheduler = 'sm2' | 'fsrs';

const days = (n: number) => (n === 1 ? '1 día' : `${n} días`);

/** Ajustes → Repaso espaciado: SM-2 (por defecto) o FSRS-5 con retención deseada. */
export function SchedulerSettings() {
  const [scheduler, setScheduler] = useState<Scheduler>('sm2');
  const [retention, setRetention] = useState(DEFAULT_RETENTION);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    getSettings().then((s) => {
      setScheduler(s.scheduler === 'fsrs' ? 'fsrs' : 'sm2');
      setRetention(clampRetention(s.desiredRetention));
    }).catch(() => undefined);
  }, []);

  const save = async (next: Scheduler, ret: number) => {
    setScheduler(next);
    setRetention(ret);
    await saveSettings({ scheduler: next, desiredRetention: ret, schedulerSetAt: new Date().toISOString() });
    setSaved(next === 'fsrs' ? `Guardado: FSRS al ${Math.round(ret * 100)} %` : 'Guardado: SM-2');
  };

  const p = fsrsPreview(undefined, new Date(), retention);

  return (
    <Card>
      <h2 className="font-display text-base text-ink-200 mb-1">Repaso espaciado</h2>
      <p className="text-sm text-ink-500 mb-4">
        Cómo se calcula cuándo vuelve cada pregunta. <strong className="text-ink-300">SM-2</strong> es el de siempre.{' '}
        <strong className="text-ink-300">FSRS</strong> estima para cada pregunta su estabilidad y su dificultad y la
        trae de vuelta justo cuando tu probabilidad de recordarla baja a la retención que elijas: suele pedir menos
        repasos para el mismo recuerdo. Las preguntas con historial SM-2 parten de él, y Faustus califica en el chat
        con el mismo planificador.
      </p>
      <div className="flex flex-col gap-4">
        <Select
          label="Planificador"
          value={scheduler}
          onChange={(e) => save(e.target.value === 'fsrs' ? 'fsrs' : 'sm2', retention)}
          data-testid="scheduler-select"
        >
          <option value="sm2">SM-2 (clásico)</option>
          <option value="fsrs">FSRS-5</option>
        </Select>
        {scheduler === 'fsrs' && (
          <div className="flex flex-col gap-2">
            <label htmlFor="desired-retention" className="text-xs font-medium text-ink-400 uppercase tracking-widest">
              Retención deseada: {Math.round(retention * 100)} %
            </label>
            <input
              id="desired-retention"
              type="range"
              min={MIN_RETENTION}
              max={MAX_RETENTION}
              step={0.01}
              value={retention}
              onChange={(e) => setRetention(clampRetention(e.target.value))}
              onMouseUp={() => save('fsrs', retention)}
              onKeyUp={() => save('fsrs', retention)}
              onTouchEnd={() => save('fsrs', retention)}
              data-testid="retention-range"
            />
            <p className="text-xs text-ink-500" data-testid="fsrs-preview">
              Una pregunta nueva vuelve en: otra vez {days(p.again)} · difícil {days(p.hard)} · bien {days(p.good)} · fácil{' '}
              {days(p.easy)}. Más retención, más repasos.
            </p>
          </div>
        )}
        {saved && <p className="text-xs text-sage-400" data-testid="scheduler-saved">{saved}</p>}
      </div>
    </Card>
  );
}
