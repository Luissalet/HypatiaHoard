/**
 * Deliverables.tsx
 *
 * Gestión de actividades y tests de evaluación continua.
 * Cada deliverable tiene un estado (pending/in_progress/done/submitted)
 * y opcionalmente una nota numérica, independientes entre sí.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/ui/components';
import { deliverableRepo, gradingConfigRepo } from '@/data/deliverableRepo';
import { calcGradeBreakdown, DEFAULT_GRADING_CONFIG, fmt } from '@/domain/grading';
import { subjectRepo } from '@/data/repos';
import type {
  Deliverable,
  DeliverableStatus,
  Subject,
  SubjectGradingConfig,
} from '@/domain/models';
import { isDeliverableCompleted, DeliverableType } from '@/domain/models';

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CYCLE: DeliverableStatus[] = ['pending', 'in_progress', 'done', 'submitted'];

const STATUS_CONFIG: Record<
  DeliverableStatus,
  { label: string; shortLabel: string; icon: string; className: string }
> = {
  pending: {
    label: 'Pendiente',
    shortLabel: 'Pendiente',
    icon: '○',
    className: 'border-ink-600 text-ink-500 bg-ink-800 hover:border-ink-400 hover:text-ink-300',
  },
  in_progress: {
    label: 'En progreso',
    shortLabel: 'En progreso',
    icon: '◑',
    className: 'border-blue-700 text-blue-400 bg-blue-900/20 hover:border-blue-500',
  },
  done: {
    label: 'Hecho',
    shortLabel: 'Hecho',
    icon: '✓',
    className: 'border-sage-600 text-sage-400 bg-sage-900/20 hover:border-sage-400',
  },
  submitted: {
    label: 'Entregado',
    shortLabel: 'Entregado',
    icon: '↑',
    className: 'border-amber-600 text-amber-400 bg-amber-900/20 hover:border-amber-400',
  },
};

function nextStatus(current: DeliverableStatus): DeliverableStatus {
  const idx = STATUS_CYCLE.indexOf(current);
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function matchSubject(name: string, subjects: Subject[]): Subject | undefined {
  const n = normalize(name);
  return subjects.find((s) => normalize(s.name).includes(n) || n.includes(normalize(s.name)));
}

function parseGrade(raw: string): number | undefined {
  const cleaned = raw.replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

function parseDateES(raw: string): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split('/');
  if (parts.length !== 3) return undefined;
  const [d, m, y] = parts;
  return `${y.padStart(4, '20')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function isTestName(name: string) {
  return /^test/i.test(name.trim());
}

function dueDateColor(dueDate: string | undefined, status: DeliverableStatus): string {
  const completed = isDeliverableCompleted(status);
  if (completed) return 'text-ink-600';
  if (!dueDate) return 'text-ink-500';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return 'text-rose-400';
  if (diff <= 7) return 'text-amber-400';
  return 'text-ink-500';
}

function dueDateLabel(dueDate: string | undefined, status: DeliverableStatus): string {
  if (!dueDate) return '';
  const completed = isDeliverableCompleted(status);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  const formatted = due.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  if (completed) return formatted;
  if (diff < 0) return `${formatted} · vencido`;
  if (diff === 0) return `${formatted} · hoy`;
  if (diff === 1) return `${formatted} · mañana`;
  if (diff <= 7) return `${formatted} · ${diff}d`;
  return formatted;
}

// ─── CSV Import ───────────────────────────────────────────────────────────────

async function importFromCSV(
  csvText: string,
  subjects: Subject[],
  defaultTestPts: number,
): Promise<{ created: number; skipped: number }> {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headerLine = lines[0];
  const headers = parseCSVRow(headerLine).map((h) => normalize(h));

  const idx = {
    subject: headers.findIndex((h) => h.includes('asignatura')),
    name: headers.findIndex((h) => h.includes('actividad') || h.includes('nombre')),
    start: headers.findIndex((h) => h === 'inicio'),
    end: headers.findIndex((h) => h === 'fin'),
    completed: headers.findIndex((h) => h.includes('entregado')),
    grade: headers.findIndex((h) => h === 'nota'),
  };

  const batchNow = new Date().toISOString();
  let created = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { skipped++; continue; }

    const row = parseCSVRow(line);
    const subjectName = row[idx.subject] ?? '';
    const name = row[idx.name] ?? '';
    if (!subjectName || !name) { skipped++; continue; }

    const subject = matchSubject(subjectName, subjects);
    if (!subject) { skipped++; continue; }

    const type: 'activity' | 'test' = isTestName(name) ? 'test' : 'activity';
    const wasCompleted = (row[idx.completed] ?? '').toUpperCase() === 'TRUE';
    const grade = parseGrade(row[idx.grade] ?? '');
    const dueDate = parseDateES(row[idx.end] ?? '');
    const startDate = parseDateES(row[idx.start] ?? '');

    // Determinar status a partir del CSV
    let status: DeliverableStatus = 'pending';
    if (wasCompleted && grade != null) status = 'submitted';
    else if (wasCompleted) status = 'done';

    const deliverable: Deliverable = {
      id: uuidv4(),
      subjectId: subject.id,
      name,
      type,
      startDate,
      dueDate,
      status,
      grade: wasCompleted && grade != null ? grade : undefined,
      continuousPoints: type === 'test' ? defaultTestPts : 0,
      createdAt: batchNow,
      updatedAt: batchNow,
    };

    try {
      await db.deliverables.add(deliverable);
      created++;
    } catch {
      skipped++;
    }
  }

  return { created, skipped };
}

/** Simple CSV row parser that handles quoted fields. */
function parseCSVRow(line: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let cell = '';
  for (let i = 0; i <= line.length; i++) {
    const ch = i < line.length ? line[i] : ',';
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cell.trim()); cell = ''; }
    else cell += ch;
  }
  return result;
}

// ─── Grade Calculator ─────────────────────────────────────────────────────────

interface GradeCalculatorProps {
  config: SubjectGradingConfig;
  deliverables: Deliverable[];
  onConfigChange: (config: SubjectGradingConfig) => void;
}

function GradeCalculator({ config, deliverables, onConfigChange }: GradeCalculatorProps) {
  const bd = calcGradeBreakdown(config, deliverables);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(config);

  useEffect(() => setDraft(config), [config]);

  const gradeColor = (g: number) =>
    g >= 9 ? 'text-sage-400' : g >= 7 ? 'text-green-400' : g >= 5 ? 'text-amber-400' : 'text-rose-400';

  const handleSave = () => {
    onConfigChange(draft);
    setEditing(false);
  };

  const continuousPct =
    config.maxContinuousPoints === 0
      ? 0
      : Math.min((bd.rawContinuous / config.maxContinuousPoints) * 100, 100);

  return (
    <div className="bg-ink-900 border border-ink-700 rounded-xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-ink-400 uppercase tracking-widest">
          Calculadora de nota
        </h3>
        <button
          onClick={() => setEditing(!editing)}
          className="text-xs text-ink-600 hover:text-amber-400 transition-colors"
        >
          ⚙ Configurar
        </button>
      </div>

      {/* Config panel */}
      {editing && (
        <div className="flex flex-col gap-3 p-3 bg-ink-850 rounded-lg border border-ink-700">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-ink-400 mb-1 block">Peso continua (%)</label>
              <input
                type="number" min={0} max={100} step={5}
                value={Math.round(draft.continuousWeight * 100)}
                onChange={(e) => setDraft({ ...draft, continuousWeight: Number(e.target.value) / 100 })}
                className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-100"
              />
            </div>
            <div>
              <label className="text-xs text-ink-400 mb-1 block">Máx. continua (pts)</label>
              <input
                type="number" min={1} step={1}
                value={draft.maxContinuousPoints}
                onChange={(e) => setDraft({ ...draft, maxContinuousPoints: Number(e.target.value) })}
                className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-100"
              />
            </div>
            <div>
              <label className="text-xs text-ink-400 mb-1 block">Puntos por test</label>
              <input
                type="number" min={0} step={0.05}
                value={draft.testContinuousPoints}
                onChange={(e) => setDraft({ ...draft, testContinuousPoints: Number(e.target.value) })}
                className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-100"
              />
            </div>
            <div>
              <label className="text-xs text-ink-400 mb-1 block">Nota examen (0-10)</label>
              <input
                type="number" min={0} max={10} step={0.1}
                placeholder="—"
                value={draft.examGrade ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, examGrade: e.target.value === '' ? undefined : Number(e.target.value) })
                }
                className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-100"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
            <Button size="sm" onClick={handleSave}>Guardar</Button>
          </div>
        </div>
      )}

      {/* Visual breakdown */}
      <div className="flex flex-col gap-3">
        {/* Raw continuous bar */}
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-ink-500">Continua bruta</span>
            <span className="text-amber-400 font-medium">
              {fmt(bd.rawContinuous)} / {config.maxContinuousPoints} pts
              {bd.rawContinuous > config.maxContinuousPoints && (
                <span className="text-ink-500 ml-1">(cap {config.maxContinuousPoints})</span>
              )}
            </span>
          </div>
          <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full transition-all"
              style={{ width: `${continuousPct}%` }}
            />
          </div>
        </div>

        {/* Flow equation */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-ink-850 rounded-lg p-3 border border-ink-700">
            <p className="text-xs text-ink-500 mb-1">Continua</p>
            <p className={`text-2xl font-display font-bold ${gradeColor(bd.continuousContribution / (config.continuousWeight || 1))}`}>
              {fmt(bd.continuousContribution)}
            </p>
            <p className="text-xs text-ink-600 mt-0.5">
              / {fmt(config.maxContinuousPoints * config.continuousWeight)}
            </p>
          </div>

          <div className="bg-ink-850 rounded-lg p-3 border border-ink-700">
            <p className="text-xs text-ink-500 mb-1">Examen</p>
            {bd.examContribution != null ? (
              <>
                <p className={`text-2xl font-display font-bold ${gradeColor(bd.examContribution / (1 - config.continuousWeight))}`}>
                  {fmt(bd.examContribution)}
                </p>
                <p className="text-xs text-ink-600 mt-0.5">
                  / {fmt(10 * (1 - config.continuousWeight))}
                </p>
              </>
            ) : (
              <p className="text-xl font-display text-ink-600 mt-1">—</p>
            )}
          </div>

          <div className={`rounded-lg p-3 border ${bd.finalGrade != null ? 'bg-ink-800 border-amber-700/30' : 'bg-ink-850 border-ink-700'}`}>
            <p className="text-xs text-ink-500 mb-1">Final</p>
            {bd.finalGrade != null ? (
              <p className={`text-2xl font-display font-bold ${gradeColor(bd.finalGrade)}`}>
                {fmt(bd.finalGrade)}
              </p>
            ) : (
              <p className="text-sm font-display text-ink-500 mt-1.5">
                {fmt(bd.continuousContribution)} + ?
              </p>
            )}
          </div>
        </div>

        {/* Formula hint */}
        <p className="text-xs text-ink-700 text-center">
          min({fmt(bd.rawContinuous)}, {config.maxContinuousPoints}) × {Math.round(config.continuousWeight * 100)}%
          {config.examGrade != null && ` + ${config.examGrade} × ${Math.round((1 - config.continuousWeight) * 100)}%`}
          {bd.finalGrade != null && ` = ${fmt(bd.finalGrade)}`}
        </p>

        {bd.remainingPotential > 0.005 && (
          <p className="text-xs text-ink-600 text-center">
            Potencial restante: +{fmt(bd.remainingPotential)} pts en continua
            {bd.bestCaseGrade != null && (
              <span className="text-ink-500"> → mejor caso {fmt(bd.bestCaseGrade)}</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Deliverable Row ──────────────────────────────────────────────────────────

interface DeliverableRowProps {
  d: Deliverable;
  onStatusChange: (id: string, status: DeliverableStatus) => void;
  onGradeChange: (id: string, grade: number | undefined) => void;
  onPointsChange: (id: string, pts: number) => void;
  onEdit: (id: string, patch: { name: string; dueDate?: string; dueTime?: string }) => void;
  onDelete: (id: string) => void;
}

function DeliverableRow({
  d,
  onStatusChange,
  onGradeChange,
  onPointsChange,
  onEdit,
  onDelete,
}: DeliverableRowProps) {
  const completed = isDeliverableCompleted(d.status);
  const dateColor = dueDateColor(d.dueDate, d.status);
  const dateLabel = dueDateLabel(d.dueDate, d.status);
  const [editingPts, setEditingPts] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(d.name);
  const [editDueDate, setEditDueDate] = useState(d.dueDate ?? '');
  const [editDueTime, setEditDueTime] = useState(d.dueTime ?? '');
  const statusConf = STATUS_CONFIG[d.status];

  const openEdit = () => {
    setEditName(d.name);
    setEditDueDate(d.dueDate ?? '');
    setEditDueTime(d.dueTime ?? '');
    setEditing(true);
  };

  const saveEdit = () => {
    if (!editName.trim()) return;
    onEdit(d.id, {
      name: editName.trim(),
      dueDate: editDueDate || undefined,
      dueTime: editDueTime || undefined,
    });
    setEditing(false);
  };

  // ── Edit mode ───────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2.5 rounded-lg bg-ink-850 border border-amber-500/40">
        <input
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(false); }}
          className="bg-ink-800 border border-ink-600 rounded-lg px-3 py-1.5 text-sm text-ink-100 font-body w-full"
          placeholder="Nombre"
        />
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-ink-500 mb-1 block">
              {d.type === 'exam' ? 'Fecha del examen' : 'Fecha límite'}
            </label>
            <input
              type="date"
              value={editDueDate}
              onChange={(e) => setEditDueDate(e.target.value)}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-2 py-1.5 text-xs text-ink-100"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs text-ink-500 mb-1 block">Hora (opcional)</label>
            <input
              type="time"
              value={editDueTime}
              onChange={(e) => setEditDueTime(e.target.value)}
              className="w-full bg-ink-800 border border-ink-700 rounded-lg px-2 py-1.5 text-xs text-ink-100"
            />
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
          <Button size="sm" onClick={saveEdit} disabled={!editName.trim()}>Guardar</Button>
        </div>
      </div>
    );
  }

  // ── Normal mode ─────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all group ${
        completed
          ? 'bg-ink-900/40 border border-ink-800/30'
          : 'bg-ink-850 border border-ink-700 hover:border-ink-600'
      }`}
    >
      {/* Status cycle button */}
      <button
        onClick={() => onStatusChange(d.id, nextStatus(d.status))}
        title={`Estado: ${statusConf.label} — clic para cambiar`}
        className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full border-2 text-xs font-bold transition-all ${statusConf.className}`}
      >
        {statusConf.icon}
      </button>

      {/* Name + date */}
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-body ${
            completed ? 'text-ink-500 line-through' : 'text-ink-200'
          }`}
        >
          {d.name}
        </p>
        {(dateLabel || d.dueTime) && (
          <span className={`text-xs ${dateColor}`}>
            {dateLabel}{d.dueTime ? ` · ${d.dueTime}` : ''}
          </span>
        )}
      </div>

      {/* Status badge — also clickable to cycle */}
      <button
        onClick={() => onStatusChange(d.id, nextStatus(d.status))}
        title={`Estado: ${statusConf.label} — clic para cambiar`}
        className={`hidden sm:flex text-xs px-2 py-0.5 rounded border transition-colors flex-shrink-0 ${statusConf.className}`}
      >
        {statusConf.shortLabel}
      </button>

      {/* Continuous pts badge — click to edit (hidden for exams) */}
      {d.type !== 'exam' && (editingPts ? (
        <input
          type="number"
          min={0}
          step={0.1}
          autoFocus
          className="w-16 bg-ink-800 border border-amber-500 rounded px-1.5 py-0.5 text-xs text-ink-100 text-center"
          defaultValue={d.continuousPoints}
          onBlur={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onPointsChange(d.id, v);
            setEditingPts(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditingPts(false);
          }}
        />
      ) : (
        <button
          onClick={() => setEditingPts(true)}
          title="Puntos en continua — clic para editar"
          className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
            d.continuousPoints === 0 && d.type === 'activity'
              ? 'border-rose-700/50 text-rose-500 bg-rose-900/20 hover:border-rose-400'
              : 'border-ink-700 text-ink-500 bg-ink-800 hover:border-amber-500 hover:text-amber-400'
          }`}
        >
          {d.continuousPoints === 0 && d.type === 'activity' ? '? pts' : `${d.continuousPoints} pts`}
        </button>
      ))}

      {/* Grade input (activities, tests and exams) */}
      {(d.type === 'activity' || d.type === 'test' || d.type === 'exam') && (
        <input
          type="number"
          min={0}
          max={10}
          step={0.1}
          placeholder="nota"
          value={d.grade ?? ''}
          onChange={(e) =>
            onGradeChange(
              d.id,
              e.target.value === '' ? undefined : parseFloat(e.target.value),
            )
          }
          className="w-16 bg-ink-800 border border-ink-600 rounded px-2 py-0.5 text-xs text-center font-body transition-colors text-ink-200 hover:border-amber-500 focus:border-amber-500 outline-none"
        />
      )}

      {/* Type badge */}
      <span
        className={`text-xs px-1.5 py-0.5 rounded border font-medium flex-shrink-0 ${
          d.type === 'test'
            ? 'bg-blue-900/30 text-blue-400 border-blue-800/40'
            : d.type === 'otro'
            ? 'bg-purple-900/30 text-purple-400 border-purple-800/40'
            : d.type === 'exam'
            ? 'bg-rose-900/30 text-rose-400 border-rose-800/40'
            : 'bg-amber-900/20 text-amber-500 border-amber-800/30'
        }`}
      >
        {d.type === 'test' ? 'Test' : d.type === 'otro' ? 'Otro' : d.type === 'exam' ? '🎓 Exam' : 'Act.'}
      </span>

      {/* Edit */}
      <button
        onClick={openEdit}
        className="opacity-0 group-hover:opacity-100 text-ink-600 hover:text-amber-400 transition-all w-5 h-5 flex items-center justify-center text-xs flex-shrink-0"
        title="Editar nombre y fecha"
      >
        ✎
      </button>

      {/* Delete */}
      <button
        onClick={() => onDelete(d.id)}
        className="opacity-0 group-hover:opacity-100 text-ink-600 hover:text-rose-400 transition-all w-5 h-5 flex items-center justify-center text-xs flex-shrink-0"
        title="Eliminar"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Add Deliverable Form ─────────────────────────────────────────────────────

interface AddFormProps {
  subjectId: string;
  defaultTestPoints: number;
  onAdd: (d: Omit<Deliverable, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onClose: () => void;
  initialType?: DeliverableType;
}

function AddDeliverableForm({ subjectId, defaultTestPoints, onAdd, onClose, initialType }: AddFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<DeliverableType>(initialType ?? 'activity');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [continuousPoints, setContinuousPoints] = useState('');

  const defaultPts = type === 'test' ? defaultTestPoints : 0;

  const handleSubmit = () => {
    if (!name.trim()) return;
    const pts = type === 'exam' ? 0 : (continuousPoints !== '' ? parseFloat(continuousPoints) : defaultPts);
    onAdd({
      subjectId,
      name: name.trim(),
      type,
      dueDate: dueDate || undefined,
      dueTime: dueTime || undefined,
      status: 'pending',
      grade: undefined,
      continuousPoints: isNaN(pts) ? defaultPts : pts,
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-ink-850 rounded-xl border border-ink-600">
      {/* Type selector */}
      <div className="flex gap-2">
        {(['activity', 'test', 'exam', 'otro'] as const).map((t) => (
        <button
          key={t}
          onClick={() => setType(t)}
          className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            type === t
              ? t === 'test'
                ? 'bg-blue-600 text-white'
                : t === 'otro'
                ? 'bg-purple-600 text-white'
                : t === 'exam'
                ? 'bg-rose-600 text-white'
                : 'bg-amber-500 text-ink-900'
              : 'bg-ink-800 text-ink-400 hover:text-ink-200'
          }`}
        >
          {t === 'test' ? 'Test' : t === 'otro' ? 'Otro' : t === 'exam' ? 'Examen' : 'Actividad'}
        </button>
))}
      </div>

      <input
        autoFocus
        placeholder={type === 'test' ? 'Nombre del test (ej: Test 1)' : 'Nombre de la actividad'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        className="bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600"
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-ink-500 mb-1 block">
            {type === 'exam' ? 'Fecha del examen' : 'Fecha límite'}
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 font-body"
          />
        </div>
        <div>
          <label className="text-xs text-ink-500 mb-1 block">Hora (opcional)</label>
          <input
            type="time"
            value={dueTime}
            onChange={(e) => setDueTime(e.target.value)}
            className="w-full bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 font-body"
          />
        </div>
      </div>
      {type !== 'exam' && (
        <div>
          <label className="text-xs text-ink-500 mb-1 block">
            Puntos continua {type === 'test' ? `(def. ${defaultTestPoints})` : ''}
          </label>
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder={String(defaultPts)}
            value={continuousPoints}
            onChange={(e) => setContinuousPoints(e.target.value)}
            className="w-full bg-ink-800 border border-ink-600 rounded-lg px-2 py-1.5 text-sm text-ink-100"
          />
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!name.trim()}>
          Añadir
        </Button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// db import needed for CSV import helper
import { db } from '@/data/db';

export function DeliverablesPage() {
  const navigate = useNavigate();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [config, setConfig] = useState<SubjectGradingConfig>({
    id: '',
    ...DEFAULT_GRADING_CONFIG,
  });
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddExam, setShowAddExam] = useState(false);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Load subjects
  useEffect(() => {
    subjectRepo.getAll().then((ss) => {
      setSubjects(ss);
      if (ss.length > 0) setSelectedSubjectId(ss[0].id);
      setLoading(false);
    });
  }, []);

  // Load deliverables + config when subject changes
  const loadSubjectData = useCallback(async (subjectId: string) => {
    if (!subjectId) return;
    const [ds, cfg] = await Promise.all([
      deliverableRepo.getBySubject(subjectId),
      gradingConfigRepo.get(subjectId),
    ]);
    setDeliverables(ds);
    setConfig(cfg);
  }, []);

  useEffect(() => {
    loadSubjectData(selectedSubjectId);
  }, [selectedSubjectId, loadSubjectData]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleStatusChange = async (id: string, status: DeliverableStatus) => {
    await deliverableRepo.update(id, { status });
    setDeliverables((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status } : d)),
    );
  };

  const handleGradeChange = async (id: string, grade: number | undefined) => {
    await deliverableRepo.update(id, { grade });
    setDeliverables((prev) =>
      prev.map((d) => (d.id === id ? { ...d, grade } : d)),
    );
  };

  const handlePointsChange = async (id: string, continuousPoints: number) => {
    await deliverableRepo.update(id, { continuousPoints });
    setDeliverables((prev) =>
      prev.map((d) => (d.id === id ? { ...d, continuousPoints } : d)),
    );
  };

  const handleEdit = async (id: string, patch: { name: string; dueDate?: string; dueTime?: string }) => {
    await deliverableRepo.update(id, patch);
    setDeliverables((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    );
  };

  const handleDelete = async (id: string) => {
    await deliverableRepo.delete(id);
    setDeliverables((prev) => prev.filter((d) => d.id !== id));
  };

  const handleAdd = async (data: Omit<Deliverable, 'id' | 'createdAt' | 'updatedAt'>) => {
    const d = await deliverableRepo.create(data);
    setDeliverables((prev) =>
      [...prev, d].sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')),
    );
    setShowAdd(false);
  };

  const handleConfigChange = async (newConfig: SubjectGradingConfig) => {
    await gradingConfigRepo.save(newConfig);
    setConfig(newConfig);
    await loadSubjectData(selectedSubjectId);
  };

  const handleCSVImport = async (file: File) => {
    setCsvMsg('Importando…');
    try {
      const text = await file.text();
      const { created, skipped } = await importFromCSV(
        text,
        subjects,
        config.testContinuousPoints,
      );
      setCsvMsg(`✓ ${created} importadas (${skipped} omitidas)`);
      await loadSubjectData(selectedSubjectId);
    } catch (e) {
      console.error(e);
      setCsvMsg('Error al importar el CSV');
    }
    setTimeout(() => setCsvMsg(null), 5000);
  };

  const handleClearAll = async () => {
    await deliverableRepo.deleteBySubject(selectedSubjectId);
    setDeliverables([]);
    setShowClearConfirm(false);
  };

  // ─── Derived state ───────────────────────────────────────────────────────────

  const currentSubject = subjects.find((s) => s.id === selectedSubjectId);
  const activities = deliverables.filter((d) => d.type === 'activity');
  const others = deliverables.filter(d => d.type === 'otro');
  const tests = deliverables.filter((d) => d.type === 'test');
  const examDeliverables = deliverables.filter((d) => d.type === 'exam');
  const completedActs = activities.filter((d) => isDeliverableCompleted(d.status)).length;
  const completedTests = tests.filter((d) => isDeliverableCompleted(d.status)).length;
  const completedExams = examDeliverables.filter((d) => isDeliverableCompleted(d.status)).length;

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <p className="text-ink-500 text-sm">Cargando…</p>
      </div>
    );
  }

  if (subjects.length === 0) {
    return (
      <div className="min-h-screen bg-ink-950 flex flex-col items-center justify-center gap-4">
        <p className="text-ink-400">No hay asignaturas. Crea una en el dashboard primero.</p>
        <Button onClick={() => navigate('/')}>← Volver al dashboard</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-ink-950/95 backdrop-blur border-b border-ink-800 px-4 sm:px-6 py-3 flex items-center gap-4">
        <button
          onClick={() => navigate('/')}
          className="text-ink-500 hover:text-ink-200 transition-colors text-sm"
        >
          ←
        </button>
        <h1 className="font-display text-lg text-ink-100">Actividades y entregas</h1>
      </header>

      {/* Body: sidebar izquierdo + contenido */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar izquierdo: lista de asignaturas ──────────────────────── */}
        <aside className="hidden sm:block w-52 flex-shrink-0 border-r border-ink-800 overflow-y-auto bg-ink-950/30">
          <div className="p-3 pt-5 flex flex-col gap-0.5">
            <p className="text-xs font-medium text-ink-600 uppercase tracking-widest px-2 mb-2">
              Asignaturas
            </p>
            {subjects.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedSubjectId(s.id)}
                className={`flex items-center gap-2.5 px-2 py-2 rounded-lg text-left w-full transition-colors ${
                  s.id === selectedSubjectId
                    ? 'bg-ink-800 text-ink-100'
                    : 'text-ink-400 hover:bg-ink-800/60 hover:text-ink-200'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: s.color ?? '#f59e0b' }}
                />
                <span className="text-sm truncate">{s.name}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* ── Contenido principal ──────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col gap-4 sm:gap-6">
            {/* Mobile subject selector (replaces sidebar) */}
            <div className="sm:hidden">
              <select
                value={selectedSubjectId}
                onChange={(e) => setSelectedSubjectId(e.target.value)}
                className="w-full bg-ink-800 border border-ink-600 text-ink-100 rounded-lg px-3 py-2 text-sm font-body focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            {/* Grade calculator */}
            <GradeCalculator
              config={config}
              deliverables={deliverables}
              onConfigChange={handleConfigChange}
            />

            {/* Stats bar */}
            {deliverables.length > 0 && (
              <div className="flex gap-4 text-xs text-ink-500">
                <span>Actividades: {completedActs}/{activities.length}</span>
                <span>·</span>
                <span>Tests: {completedTests}/{tests.length}</span>
                {['pending', 'in_progress', 'done', 'submitted'].map((s) => {
                  const count = deliverables.filter((d) => d.status === s).length;
                  if (count === 0) return null;
                  const conf = STATUS_CONFIG[s as DeliverableStatus];
                  return (
                    <span key={s} className="flex items-center gap-1">
                      <span className={conf.className.split(' ')[2]}>{conf.icon}</span>
                      <span>{count} {conf.label.toLowerCase()}</span>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Legend */}
            <div className="flex gap-3 flex-wrap">
              {(Object.entries(STATUS_CONFIG) as [DeliverableStatus, typeof STATUS_CONFIG[DeliverableStatus]][]).map(([key, conf]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-bold ${conf.className}`}>
                    {conf.icon}
                  </span>
                  <span className="text-xs text-ink-500">{conf.label}</span>
                </div>
              ))}
              <span className="text-xs text-ink-700 self-center">— clic en el estado para cambiar</span>
            </div>

            {/* Activities */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-base text-ink-200">
                  Actividades
                  {activities.length > 0 && (
                    <span className="text-ink-600 text-sm font-body ml-2">
                      {completedActs}/{activities.length}
                    </span>
                  )}
                </h2>
                <Button size="sm" onClick={() => setShowAdd(true)}>+ Añadir</Button>
              </div>

              {showAdd && (
                <div className="mb-3">
                  <AddDeliverableForm
                    subjectId={selectedSubjectId}
                    defaultTestPoints={config.testContinuousPoints}
                    onAdd={handleAdd}
                    onClose={() => setShowAdd(false)}
                  />
                </div>
              )}

              {activities.length === 0 ? (
                <p className="text-sm text-ink-600 py-4 text-center">Sin actividades aún</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {activities.map((d) => (
                    <DeliverableRow
                      key={d.id}
                      d={d}
                      onStatusChange={handleStatusChange}
                      onGradeChange={handleGradeChange}
                      onPointsChange={handlePointsChange}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Tests */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-base text-ink-200">
                  Tests
                  {tests.length > 0 && (
                    <span className="text-ink-600 text-sm font-body ml-2">
                      {completedTests}/{tests.length}
                    </span>
                  )}
                </h2>
              </div>

              {tests.length === 0 ? (
                <p className="text-sm text-ink-600 py-4 text-center">Sin tests aún</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {tests.map((d) => (
                    <DeliverableRow
                      key={d.id}
                      d={d}
                      onStatusChange={handleStatusChange}
                      onGradeChange={handleGradeChange}
                      onPointsChange={handlePointsChange}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Exámenes */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-base text-ink-200">
                  🎓 Exámenes
                  {examDeliverables.length > 0 && (
                    <span className="text-ink-600 text-sm font-body ml-2">
                      {completedExams}/{examDeliverables.length}
                    </span>
                  )}
                </h2>
                <Button size="sm" onClick={() => setShowAddExam(true)}>+ Añadir examen</Button>
              </div>

              {showAddExam && (
                <div className="mb-3">
                  <AddDeliverableForm
                    subjectId={selectedSubjectId}
                    defaultTestPoints={config.testContinuousPoints}
                    onAdd={(d) => { handleAdd(d); setShowAddExam(false); }}
                    onClose={() => setShowAddExam(false)}
                    initialType="exam"
                  />
                </div>
              )}

              {examDeliverables.length === 0 ? (
                <p className="text-sm text-ink-600 py-4 text-center">Sin exámenes añadidos aún</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {examDeliverables.map((d) => (
                    <DeliverableRow
                      key={d.id}
                      d={d}
                      onStatusChange={handleStatusChange}
                      onGradeChange={handleGradeChange}
                      onPointsChange={handlePointsChange}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* CSV import + tools */}
            <section className="flex flex-col gap-3 pt-4 border-t border-ink-800">
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleCSVImport(f);
                    e.target.value = '';
                  }}
                />
                <Button size="sm" variant="secondary" onClick={() => csvInputRef.current?.click()}>
                  📥 Importar CSV
                </Button>
                {deliverables.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowClearConfirm(true)}
                  >
                    🗑 Limpiar todo
                  </Button>
                )}
              </div>

              {csvMsg && (
                <p className={`text-xs ${csvMsg.startsWith('Error') ? 'text-rose-400' : 'text-sage-400'}`}>
                  {csvMsg}
                </p>
              )}

              {showClearConfirm && (
                <div className="flex items-center gap-3 p-3 bg-rose-900/20 border border-rose-700/40 rounded-lg">
                  <p className="text-sm text-rose-300 flex-1">
                    ¿Eliminar todos los deliverables de esta asignatura?
                  </p>
                  <Button size="sm" variant="danger" onClick={handleClearAll}>Eliminar</Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowClearConfirm(false)}>Cancelar</Button>
                </div>
              )}
            </section>
          </div>
        </main>

      </div>
    </div>
  );
}