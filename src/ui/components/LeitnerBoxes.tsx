import { useNavigate } from 'react-router-dom';
import { sessionRepo } from '@/data/repos';
import type { Question } from '@/domain/models';

interface Props {
  subjectId: string;
  questions: Question[];
}

function getLeitnerBox(q: Question): number {
  const reps = q.stats.repetitions ?? 0;
  const interval = q.stats.interval ?? 0;
  if (q.stats.seen === 0) return 0;
  if (reps === 0 || interval <= 1) return 1;
  if (interval <= 6) return 2;
  if (interval <= 21) return 3;
  return 4;
}

const BOX_CONFIG = [
  { label: 'Sin ver',     color: 'text-ink-400',   bg: 'bg-ink-800',       border: 'border-ink-600' },
  { label: 'Aprendiendo', color: 'text-rose-400',  bg: 'bg-rose-500/10',   border: 'border-rose-500/30' },
  { label: 'Repasando',   color: 'text-amber-400', bg: 'bg-amber-500/10',  border: 'border-amber-500/30' },
  { label: 'Casi listo',  color: 'text-blue-400',  bg: 'bg-blue-500/10',   border: 'border-blue-500/30' },
  { label: 'Dominado',    color: 'text-sage-400',  bg: 'bg-sage-500/10',   border: 'border-sage-500/30' },
];

const BAR_COLORS = ['bg-ink-600', 'bg-rose-500', 'bg-amber-500', 'bg-blue-500', 'bg-sage-500'];

export function LeitnerBoxes({ subjectId, questions }: Props) {
  const navigate = useNavigate();

  const boxes: Question[][] = [[], [], [], [], []];
  for (const q of questions) {
    boxes[getLeitnerBox(q)].push(q);
  }

  const handlePracticeBox = async (boxIndex: number) => {
    const pool = boxes[boxIndex];
    if (pool.length === 0) return;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(20, shuffled.length));
    const session = await sessionRepo.create({
      subjectId,
      mode: 'smart',
      questionIds: selected.map(q => q.id),
    });
    navigate(`/practice/${session.id}`);
  };

  return (
    <div>
      <h3 className="font-display text-ink-200 mb-3">Cajas de Leitner</h3>
      <div className="grid grid-cols-5 gap-2">
        {BOX_CONFIG.map((cfg, i) => {
          const count = boxes[i].length;
          const pct = questions.length > 0
            ? Math.round((count / questions.length) * 100)
            : 0;
          return (
            <button
              key={i}
              onClick={() => handlePracticeBox(i)}
              disabled={count === 0}
              className={`flex flex-col items-center gap-1 p-3 rounded-xl border transition-all
                ${cfg.bg} ${cfg.border}
                ${count > 0 ? 'hover:scale-105 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
            >
              <span className={`text-2xl font-bold ${cfg.color}`}>{count}</span>
              <span className="text-xs text-ink-400">{cfg.label}</span>
              <span className="text-xs text-ink-600">{pct}%</span>
            </button>
          );
        })}
      </div>
      <div className="flex h-2 rounded-full overflow-hidden mt-3 bg-ink-800">
        {boxes.map((box, i) => {
          const pct = questions.length > 0 ? (box.length / questions.length) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={i}
              className={`${BAR_COLORS[i]} transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${BOX_CONFIG[i].label}: ${box.length}`}
            />
          );
        })}
      </div>
    </div>
  );
}
