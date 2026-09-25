/**
 * CalendarWidget.tsx
 *
 * Mini calendario mensual para el Dashboard.
 * Muestra los deliverables (actividades/tests/exámenes) de todas las asignaturas.
 * Los exámenes (type='exam') se muestran con un diamante; el resto con un punto.
 * La fuente única de verdad es el repo de deliverables — no se usa subject.examDate.
 */

import { useEffect, useState, useMemo } from 'react';
import { deliverableRepo } from '@/data/deliverableRepo';
import type { Deliverable, Subject, DeliverableStatus } from '@/domain/models';
import { isDeliverableCompleted } from '@/domain/models';

interface CalendarWidgetProps {
  subjects: Subject[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  // 0=Sun…6=Sat → convert to Mon-based (0=Mon…6=Sun)
  const day = new Date(year, month, 1).getDay();
  return (day + 6) % 7;
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<DeliverableStatus, string> = {
  pending: 'Pendiente',
  in_progress: 'En progreso',
  done: 'Hecho',
  submitted: 'Entregado',
};

const STATUS_COLOR: Record<DeliverableStatus, string> = {
  pending: 'text-ink-500',
  in_progress: 'text-blue-400',
  done: 'text-sage-400',
  submitted: 'text-amber-400',
};

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
const DAY_LABELS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

// ─── Component ────────────────────────────────────────────────────────────────

export function CalendarWidget({ subjects }: CalendarWidgetProps) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Subject color lookup
  const subjectColor = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of subjects) map[s.id] = s.color ?? '#f59e0b';
    return map;
  }, [subjects]);

  // Subject name lookup
  const subjectName = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of subjects) map[s.id] = s.name;
    return map;
  }, [subjects]);

  useEffect(() => {
    deliverableRepo.getAll().then(setDeliverables);
  }, []);

  // Group all deliverables by dueDate
  const byDate = useMemo(() => {
    const map: Record<string, Deliverable[]> = {};
    for (const d of deliverables) {
      if (!d.dueDate) continue;
      if (!map[d.dueDate]) map[d.dueDate] = [];
      map[d.dueDate].push(d);
    }
    return map;
  }, [deliverables]);

  // Calendar grid
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDow = getFirstDayOfWeek(viewYear, viewMonth);
  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate());

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
    setSelectedDay(null);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
    setSelectedDay(null);
  };

  // Selected day events
  const selectedAllDeliverables = selectedDay ? (byDate[selectedDay] ?? []) : [];
  const selectedExamDeliverables = selectedAllDeliverables.filter(d => d.type === 'exam');
  const selectedRegularDeliverables = selectedAllDeliverables.filter(d => d.type !== 'exam');

  return (
    <div className="bg-ink-900 border border-ink-700 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-800">
        <button
          onClick={prevMonth}
          className="text-ink-500 hover:text-ink-200 transition-colors px-1"
        >
          ‹
        </button>
        <span className="text-sm font-medium text-ink-200 font-display">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </span>
        <button
          onClick={nextMonth}
          className="text-ink-500 hover:text-ink-200 transition-colors px-1"
        >
          ›
        </button>
      </div>

      {/* Day-of-week header */}
      <div className="grid grid-cols-7 px-2 pt-2">
        {DAY_LABELS.map(d => (
          <div key={d} className="text-center text-xs text-ink-600 pb-1">{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 gap-px px-2 pb-2">
        {/* Empty cells before first day */}
        {Array.from({ length: firstDow }).map((_, i) => (
          <div key={`e-${i}`} />
        ))}

        {/* Days */}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
          const dateStr = toDateStr(viewYear, viewMonth, day);
          const allEvents = byDate[dateStr] ?? [];
          const examEvents = allEvents.filter(d => d.type === 'exam');
          const regularEvents = allEvents.filter(d => d.type !== 'exam');
          const isToday = dateStr === todayStr;
          const isSelected = dateStr === selectedDay;
          const hasEvents = allEvents.length > 0;

          return (
            <button
              key={day}
              onClick={() => setSelectedDay(isSelected ? null : dateStr)}
              className={`relative flex flex-col items-center justify-center rounded-lg py-1 min-h-[28px] text-xs transition-all ${
                isSelected
                  ? 'bg-amber-500 text-ink-900 font-bold'
                  : isToday
                  ? 'bg-amber-500/20 text-amber-300 font-semibold'
                  : hasEvents
                  ? 'text-ink-200 hover:bg-ink-800'
                  : 'text-ink-600 hover:bg-ink-800'
              }`}
            >
              {day}
              {/* Dot row: exam diamonds + regular dots */}
              {hasEvents && (
                <div className="flex items-center gap-0.5 mt-0.5">
                  {/* Exam deliverable diamonds */}
                  {examEvents.slice(0, 2).map((d) => (
                    <span
                      key={d.id}
                      className="w-1.5 h-1.5 rounded-sm rotate-45 flex-shrink-0"
                      style={{ backgroundColor: subjectColor[d.subjectId] ?? '#f59e0b' }}
                      title={`🎓 ${d.name}`}
                    />
                  ))}
                  {/* Regular deliverable dots */}
                  {regularEvents.slice(0, Math.max(0, 3 - examEvents.length)).map((d) => (
                    <span
                      key={d.id}
                      className="w-1 h-1 rounded-full flex-shrink-0"
                      style={{ backgroundColor: subjectColor[d.subjectId] ?? '#f59e0b' }}
                    />
                  ))}
                  {allEvents.length > 3 && (
                    <span className="text-[8px] text-ink-500 leading-none">+</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected day panel */}
      {selectedDay && selectedAllDeliverables.length > 0 && (
        <div className="border-t border-ink-800 px-3 py-3 flex flex-col gap-2">
          <p className="text-xs text-ink-500 font-medium mb-1">
            {new Date(selectedDay + 'T12:00:00').toLocaleDateString('es-ES', {
              weekday: 'short', day: 'numeric', month: 'short'
            })}
          </p>

          {/* Exam deliverable entries */}
          {selectedExamDeliverables.map(d => (
            <div key={d.id} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-sm rotate-45 flex-shrink-0"
                style={{ backgroundColor: subjectColor[d.subjectId] ?? '#f59e0b' }}
              />
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium truncate ${isDeliverableCompleted(d.status) ? 'line-through text-ink-600' : 'text-amber-300'}`}>
                  🎓 {d.name}
                </p>
                <p className={`text-xs ${STATUS_COLOR[d.status]}`}>
                  {STATUS_LABEL[d.status]} · {subjectName[d.subjectId] ?? ''}
                  {d.dueTime && ` · ${d.dueTime}`}
                </p>
              </div>
            </div>
          ))}

          {/* Regular deliverable entries */}
          {selectedRegularDeliverables.map(d => (
            <div key={d.id} className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: subjectColor[d.subjectId] ?? '#f59e0b' }}
              />
              <div className="flex-1 min-w-0">
                <p className={`text-xs truncate ${isDeliverableCompleted(d.status) ? 'line-through text-ink-600' : 'text-ink-300'}`}>
                  {d.name}
                </p>
                <p className={`text-xs ${STATUS_COLOR[d.status]}`}>
                  {STATUS_LABEL[d.status]} · {subjectName[d.subjectId] ?? ''}
                  {d.dueTime && ` · ${d.dueTime}`}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
