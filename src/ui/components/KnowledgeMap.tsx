import { useNavigate } from 'react-router-dom';
import { questionBelongsToTopic } from '@/utils/questionUtils';
import type { Question, Topic } from '@/domain/models';

interface Props {
  subjectId: string;
  topics: Topic[];
  questions: Question[];
}

const LEVEL_STYLES = {
  none:   { bg: 'bg-ink-800',       border: 'border-ink-700',      text: 'text-ink-500' },
  low:    { bg: 'bg-rose-500/15',   border: 'border-rose-500/30',  text: 'text-rose-400' },
  medium: { bg: 'bg-amber-500/15',  border: 'border-amber-500/30', text: 'text-amber-400' },
  high:   { bg: 'bg-sage-500/15',   border: 'border-sage-500/30',  text: 'text-sage-400' },
};

function calcMastery(questions: Question[]): number {
  if (questions.length === 0) return 0;
  const seen = questions.filter(q => q.stats.seen > 0);
  if (seen.length === 0) return 0;
  const correctRatio = seen.reduce((acc, q) => acc + q.stats.correct / q.stats.seen, 0) / seen.length;
  const coverage = seen.length / questions.length;
  return Math.round(correctRatio * coverage * 100);
}

function getLevel(mastery: number): keyof typeof LEVEL_STYLES {
  if (mastery === 0) return 'none';
  if (mastery < 40) return 'low';
  if (mastery < 70) return 'medium';
  return 'high';
}

export function KnowledgeMap({ subjectId, topics, questions }: Props) {
  const navigate = useNavigate();

  const topicData = topics.map(t => {
    const qs = questions.filter(q => questionBelongsToTopic(q, t.id));
    const mastery = calcMastery(qs);
    const seen = qs.filter(q => q.stats.seen > 0).length;
    return { topic: t, total: qs.length, seen, mastery, level: getLevel(mastery) };
  });

  const handleClick = (topicId: string) => {
    navigate(`/subject/${subjectId}?tab=practice&topic=${topicId}`);
  };

  return (
    <div>
      <h3 className="font-display text-ink-200 mb-3">Mapa de conocimiento</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {topicData.map(({ topic, total, seen, mastery, level }) => {
          const style = LEVEL_STYLES[level];
          return (
            <button
              key={topic.id}
              onClick={() => handleClick(topic.id)}
              className={`flex flex-col gap-1 p-3 rounded-xl border transition-all hover:scale-[1.02]
                ${style.bg} ${style.border}`}
            >
              <span className="text-xs text-ink-300 text-left line-clamp-2 leading-tight">
                {topic.title}
              </span>
              <span className={`text-lg font-bold ${style.text}`}>
                {mastery}%
              </span>
              <span className="text-xs text-ink-500">
                {seen}/{total} vistas
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-4 mt-3 text-xs text-ink-500 justify-center">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-ink-800 border border-ink-700" /> Sin ver</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-rose-500/30" /> {'<'}40%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-500/30" /> 40-70%</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-sage-500/30" /> {'>'}70%</span>
      </div>
    </div>
  );
}
