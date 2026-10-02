/** Rol Profesor: Clases · Exámenes · Rúbricas · Entregas · Análisis. */

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs } from '@/ui/components';
import { useStore } from '@/ui/store';
import { useRole } from '@/data/role';
import { ClassesTab } from './ClassesTab';
import { TeacherExamsTab } from './TeacherExamsTab';
import { RubricsTab } from './RubricsTab';
import { BatchesTab } from './BatchesTab';
import { AnalysisTab } from './AnalysisTab';
import { TeacherHeader } from './shared';

const TABS = [
  { id: 'clases', label: 'Clases' },
  { id: 'examenes', label: 'Exámenes' },
  { id: 'rubricas', label: 'Rúbricas' },
  { id: 'entregas', label: 'Entregas' },
  { id: 'analisis', label: 'Análisis' },
];

export function TeacherHome() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'clases';
  const loadSubjects = useStore((s) => s.loadSubjects);
  const role = useRole();
  useEffect(() => { void loadSubjects(); }, [loadSubjects]);
  return (
    <div className="min-h-screen bg-ink-950 text-ink-100">
      <TeacherHeader title="Profesor" back="/" />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-5">
        {role !== 'teacher' && (
          <p className="text-xs text-ink-400 rounded-lg border border-ink-700 bg-ink-800 px-3 py-2">
            Estás en modo Estudiante: estas pantallas siguen disponibles; el modo Profesor añade sus accesos en el inicio.
          </p>
        )}
        <Tabs tabs={TABS} active={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} />
        {tab === 'clases' && <ClassesTab />}
        {tab === 'examenes' && <TeacherExamsTab />}
        {tab === 'rubricas' && <RubricsTab />}
        {tab === 'entregas' && <BatchesTab />}
        {tab === 'analisis' && <AnalysisTab />}
      </main>
    </div>
  );
}
