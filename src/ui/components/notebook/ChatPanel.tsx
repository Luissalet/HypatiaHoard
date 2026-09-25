/**
 * ChatPanel.tsx
 *
 * Chat UI shared by the notebook's "Chat" tab (grounded Q&A over the sources,
 * POST /api/notebook/ask) and the "Tutor" tab (Socratic tutor,
 * POST /api/notebook/tutor). Answers carry [n] citations; without a model the
 * server returns passages + a note, which are shown instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Select } from '@/ui/components';
import {
  ask, tutorTurn, listChats, getChat, deleteChat,
  type Citation, type ChatSummary,
} from '@/data/hoardClient';
import { useNotebook } from './NotebookContext';
import { CitedMarkdown } from './CitedMarkdown';
import { CitationList } from './CitationChip';

type Mode = 'sources' | 'tutor';

interface UiMessage {
  role: 'user' | 'assistant';
  content: string | null;
  citations: Citation[];
  passages?: Citation[];
  note?: string;
  weak?: Record<string, unknown>[];
  model?: string;
}

interface ChatPanelProps {
  mode: Mode;
}

const COPY: Record<Mode, { placeholder: string; empty: string; emptyHint: string; starter?: string }> = {
  sources: {
    placeholder: 'Pregunta algo sobre las fuentes…',
    empty: 'Pregunta a tus apuntes',
    emptyHint: 'Las respuestas salen solo de las fuentes del cuaderno y citan la página de donde viene cada dato.',
  },
  tutor: {
    placeholder: 'Responde o pide una pista…',
    empty: 'Tutor socrático',
    emptyHint: 'Elige un tema. El tutor te guía con preguntas en lugar de darte la respuesta y se apoya en tus preguntas falladas.',
    starter: 'Quiero repasar este tema. Empieza con una pregunta.',
  },
};

function weakLabel(w: Record<string, unknown>): string {
  return String(w.prompt ?? w.text ?? w.title ?? w.id ?? '').slice(0, 140);
}

export function ChatPanel({ mode }: ChatPanelProps) {
  const { serverSubjectId, topics, caps, serverTopicId } = useNotebook();
  const copy = COPY[mode];

  const [topicId, setTopicId] = useState('');
  const [chatId, setChatId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const loadChats = useCallback(async () => {
    try {
      const all = await listChats(serverSubjectId);
      setChats(all.filter((c) => (c.mode || 'sources') === mode));
    } catch { /* history is optional */ }
  }, [serverSubjectId, mode]);

  useEffect(() => { void loadChats(); }, [loadChats]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  const newChat = () => {
    setChatId(undefined);
    setMessages([]);
    setError(null);
  };

  const openChat = async (id: string) => {
    if (!id) { newChat(); return; }
    setError(null);
    try {
      const { messages: msgs } = await getChat(id);
      setChatId(id);
      setMessages(msgs.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        citations: m.citations,
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeChat = async () => {
    if (!chatId || !confirm('¿Borrar esta conversación?')) return;
    try {
      await deleteChat(chatId);
      newChat();
      void loadChats();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async (textArg?: string) => {
    const text = (textArg ?? input).trim();
    if (!text || sending) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', content: text, citations: [] }]);
    setSending(true);
    const topic = topicId ? serverTopicId(topicId) : undefined;
    try {
      if (mode === 'sources') {
        const r = await ask({ subject: serverSubjectId, question: text, topic, chatId });
        if (r.chatId && r.chatId !== chatId) { setChatId(r.chatId); void loadChats(); }
        setMessages((m) => [...m, {
          role: 'assistant', content: r.answer, citations: r.citations,
          passages: r.passages, note: r.note, model: r.model,
        }]);
      } else {
        const r = await tutorTurn({ subject: serverSubjectId, message: text, topic, chatId });
        if (r.chatId && r.chatId !== chatId) { setChatId(r.chatId); void loadChats(); }
        setMessages((m) => [...m, {
          role: 'assistant', content: r.reply, citations: r.citations,
          passages: r.passages, note: r.note, weak: r.weak,
        }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col gap-3 min-h-[60vh]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-64">
          <Select className="w-full" value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Tema">
            <option value="">{mode === 'tutor' ? 'Toda la asignatura' : 'Todas las fuentes'}</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </Select>
        </div>
        {chats.length > 0 && (
          <div className="w-full sm:w-64">
            <Select className="w-full" value={chatId ?? ''} onChange={(e) => void openChat(e.target.value)} aria-label="Conversaciones">
              <option value="">Nueva conversación</option>
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.title || 'Conversación').slice(0, 60)}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex gap-1 ml-auto">
          {chatId && (
            <Button size="sm" variant="ghost" onClick={removeChat} title="Borrar conversación">Borrar</Button>
          )}
          {messages.length > 0 && (
            <Button size="sm" variant="secondary" onClick={newChat}>Nueva</Button>
          )}
        </div>
      </div>

      {!caps.llm && (
        <p className="text-xs text-ink-400 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2">
          Sin modelo de texto en Hypatia: se mostrarán los pasajes relevantes de las fuentes, sin respuesta redactada.
        </p>
      )}

      {/* Messages */}
      <div className="flex-1 flex flex-col gap-3">
        {messages.length === 0 && !sending && (
          <div className="flex flex-col items-center text-center py-12 gap-2">
            <p className="font-display text-lg text-ink-300">{copy.empty}</p>
            <p className="text-sm text-ink-500 max-w-md">{copy.emptyHint}</p>
            {copy.starter && (
              <Button size="sm" className="mt-2" onClick={() => void send(copy.starter)}>Empezar</Button>
            )}
          </div>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="self-end max-w-[85%] bg-amber-500/10 border border-amber-500/25 rounded-2xl rounded-br-md px-4 py-2.5">
              <p className="text-sm text-ink-100 whitespace-pre-wrap break-words">{m.content}</p>
            </div>
          ) : (
            <div key={i} className="self-start w-full sm:max-w-[92%] bg-ink-800 border border-ink-700 rounded-2xl rounded-bl-md px-4 py-3">
              {m.content ? (
                <>
                  <CitedMarkdown content={m.content} citations={m.citations} />
                  <CitationList citations={m.citations} />
                </>
              ) : (
                <>
                  {/* The server's `note` is written for the assistant (Faustus); show it only as a tooltip */}
                  <p className="text-xs text-ink-400 italic" title={m.note}>
                    {mode === 'tutor'
                      ? 'Sin modelo de texto no hay tutor. Repasa estos pasajes (o pídeselo a tu asistente):'
                      : 'Sin modelo de texto: estos son los pasajes más relevantes de tus fuentes.'}
                  </p>
                  {(m.passages?.length ?? 0) === 0 && (
                    <p className="text-sm text-ink-500 mt-2">No se encontraron pasajes en las fuentes.</p>
                  )}
                  <div className="flex flex-col gap-2 mt-2">
                    {m.passages?.map((p) => (
                      <div key={p.n} className="border-l-2 border-amber-500/40 pl-3">
                        <CitationList citations={[p]} />
                        {p.snippet && <p className="text-xs text-ink-300 mt-1 whitespace-pre-line line-clamp-4">{p.snippet}</p>}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {m.weak && m.weak.length > 0 && (
                <div className="mt-3 pt-2 border-t border-ink-700">
                  <p className="text-[11px] uppercase tracking-wider text-ink-500 mb-1">Preguntas que sueles fallar</p>
                  <ul className="list-disc pl-5 text-xs text-ink-300 flex flex-col gap-0.5">
                    {m.weak.slice(0, 5).map((w, j) => <li key={j}>{weakLabel(w)}</li>)}
                  </ul>
                </div>
              )}
              {m.model && <p className="text-[10px] text-ink-600 mt-2">{m.model}</p>}
            </div>
          ),
        )}

        {sending && (
          <div className="self-start flex items-center gap-2 text-xs text-ink-500 px-2">
            <svg className="animate-spin h-3.5 w-3.5 text-amber-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {mode === 'tutor' ? 'El tutor está pensando…' : 'Buscando en las fuentes…'}
          </div>
        )}
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 pt-2 pb-3">
        <div className="flex gap-2 items-end bg-ink-800 border border-ink-700 rounded-xl p-2 shadow-lg shadow-black/20">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={copy.placeholder}
            className="flex-1 bg-ink-900 border border-ink-700 text-ink-100 rounded-lg px-3 py-2 text-sm font-body placeholder:text-ink-500 resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all"
          />
          <Button onClick={() => void send()} loading={sending} disabled={!input.trim()}>
            Enviar
          </Button>
        </div>
      </div>
    </div>
  );
}
