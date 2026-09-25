import type { Question } from '@/domain/models';

/** Check if question belongs to a topic (supports multi-topic via topicIds) */
export function questionBelongsToTopic(q: Question, topicId: string): boolean {
  if (q.topicId === topicId) return true;
  if (q.topicIds && q.topicIds.includes(topicId)) return true;
  return false;
}
