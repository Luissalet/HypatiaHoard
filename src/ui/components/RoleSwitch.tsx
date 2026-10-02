/**
 * RoleSwitch.tsx — Estudiante / Profesor. Compacto en las cabeceras, completo en
 * Ajustes. Cambiar de rol no oculta nada del modo Estudiante: el Profesor añade
 * sus pantallas (Clases, Exámenes, Rúbricas, Entregas, Análisis).
 */

import { useNavigate } from 'react-router-dom';
import { setRole, useRole } from '@/data/role';
import type { Role } from '@/domain/teacher';

export function RoleSwitch({ compact = false, navigateOnTeacher = false }: { compact?: boolean; navigateOnTeacher?: boolean }) {
  const role = useRole();
  const navigate = useNavigate();
  const pick = (r: Role) => {
    setRole(r);
    if (r === 'teacher' && navigateOnTeacher) navigate('/teacher');
  };
  const btn = (r: Role, label: string, short: string) => (
    <button
      type="button"
      onClick={() => pick(r)}
      aria-pressed={role === r}
      title={r === 'teacher' ? 'Modo Profesor: clases, exámenes, rúbricas y corrección' : 'Modo Estudiante'}
      className={`px-2 sm:px-2.5 py-1 rounded-md text-xs font-medium font-body transition-all ${
        role === r ? 'bg-amber-500 text-ink-900 shadow-sm' : 'text-ink-400 hover:text-ink-200'
      }`}
    >
      {compact ? <><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></> : label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 bg-ink-850 border border-ink-700 rounded-lg p-0.5" role="group" aria-label="Rol">
      {btn('student', 'Estudiante', 'Est.')}
      {btn('teacher', 'Profesor', 'Prof.')}
    </div>
  );
}

export default RoleSwitch;
