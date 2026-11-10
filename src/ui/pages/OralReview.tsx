/**
 * OralReview.tsx
 *
 * Repaso oral: Hypatia lee la pregunta en voz alta, se graba la respuesta, el servidor la
 * transcribe y la compara por significado con la respuesta esperada, dice qué se acertó y qué
 * faltó, y la nota entra en la repetición espaciada. Una tarjeta tras otra sin tocar el ratón.
 *
 * URL: /oral (todas las asignaturas) o /oral/:subjectId. Solo en modo hoard.
 *
 * Teclado:
 *   Espacio  → he terminado de responder / responder ahora
 *   R        → repetir la pregunta
 *   S        → saltar la tarjeta
 *   1-4      → nota (cuando se pide)      Enter → aceptar y seguir
 *   Esc      → terminar el repaso
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '@/ui/store';
import { Button } from '@/ui/components';
import { MdContent } from '../components/MdContent';
import { useHoardDetection } from '@/data/hoardMode';
import { serverIdFor, syncNow } from '@/data/hoardSync';
import { reviewQuestion, type ReviewGrade } from '@/data/lessonsClient';
import {
  answerOralAudio, answerOralText, getOralStatus, nextOralCard, oralAudioSrc,
  type OralAudio, type OralCard, type OralNext, type OralResult, type OralStatus,
} from '@/data/oralClient';

type Stage = 'setup' | 'loading' | 'asking' | 'listening' | 'waiting' | 'thinking' | 'result' | 'done';
type Heard = { blob: Blob | null; reason: 'speech' | 'silence' | 'nomic' | 'cancelled' };

const SILENCE_MS = 1800;      // quiet after speech: the answer is over
const NO_SPEECH_MS = 9000;    // nothing said at all
const MAX_ANSWER_MS = 90000;

const GRADES: { id: ReviewGrade; label: string; cls: string }[] = [
  { id: 'again', label: 'Otra vez', cls: 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20' },
  { id: 'hard', label: 'Difícil', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' },
  { id: 'good', label: 'Bien', cls: 'border-sage-500/30 bg-sage-500/10 text-sage-400 hover:bg-sage-500/20' },
  { id: 'easy', label: 'Fácil', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20' },
];

const VERDICT: Record<string, { label: string; cls: string }> = {
  correct: { label: 'Correcto', cls: 'border-sage-500/40 bg-sage-500/10 text-sage-300' },
  partial: { label: 'Casi', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  wrong: { label: 'No es correcto', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
};

const STAGE_TEXT: Record<Stage, string> = {
  setup: '', loading: 'Buscando tarjetas…', asking: 'Hypatia pregunta…', listening: 'Te escucho…',
  waiting: 'En pausa', thinking: 'Comparando tu respuesta…', result: 'Resultado', done: 'Repaso terminado',
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}

export function OralReviewPage() {
  const { subjectId: routeSubject = '' } = useParams<{ subjectId?: string }>();
  const navigate = useNavigate();
  const detection = useHoardDetection();
  const { subjects, loadSubjects } = useStore();

  const [subject, setSubject] = useState(routeSubject);
  const [stage, setStage] = useState<Stage>('setup');
  const [card, setCard] = useState<OralCard | null>(null);
  const [result, setResult] = useState<OralResult | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [status, setStatus] = useState<OralStatus | null>(null);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [typed, setTyped] = useState('');
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [confirmGrade, setConfirmGrade] = useState(false);
  const [tally, setTally] = useState({ correct: 0, partial: 0, wrong: 0, skipped: 0 });
  const [grading, setGrading] = useState(false);

  const token = useRef(0);                         // every new step invalidates the ones still pending
  const exclude = useRef<string[]>([]);
  const pendingNext = useRef<OralNext | null>(null);
  const silences = useRef(0);
  const player = useRef<HTMLAudioElement | null>(null);
  const stopPlayback = useRef<(() => void) | null>(null);
  const stopListening = useRef<((send: boolean) => void) | null>(null);
  const options = useRef({ autoAdvance, confirmGrade, subject });
  options.current = { autoAdvance, confirmGrade, subject };
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const cardRef = useRef(card);
  cardRef.current = card;
  const resultRef = useRef(result);
  resultRef.current = result;
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => { void loadSubjects(); }, [loadSubjects]);
  useEffect(() => {
    if (detection !== 'on') return;
    getOralStatus().then(setStatus).catch(() => setStatus(null));
  }, [detection]);

  const scope = useCallback(() => ({
    subject: options.current.subject ? serverIdFor('subject', options.current.subject) : undefined,
    exclude: [...exclude.current],
    record: !options.current.confirmGrade,
  }), []);

  // ── Voz ──────────────────────────────────────────────────────────────────

  const silence = useCallback(() => {
    stopPlayback.current?.();
    stopPlayback.current = null;
  }, []);

  /** Plays the server's audio; without one, the browser's own voice reads the text. */
  const say = useCallback((audio: OralAudio | null | undefined, text: string) => new Promise<void>((resolve) => {
    silence();
    let finished = false;
    const done = () => { if (!finished) { finished = true; stopPlayback.current = null; resolve(); } };
    if (audio) {
      const el = player.current ?? (player.current = new Audio());
      el.onended = done;
      el.onerror = done;
      el.src = oralAudioSrc(audio);
      stopPlayback.current = () => { el.onended = null; el.onerror = null; el.pause(); done(); };
      el.play().catch(done);
      return;
    }
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!text || !synth) { setTimeout(done, 200); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.onend = done;
    utterance.onerror = done;
    // A browser with no voice installed never says it has finished: do not wait for it forever.
    const giveUp = window.setTimeout(done, Math.min(60000, 2500 + text.length * 90));
    stopPlayback.current = () => { window.clearTimeout(giveUp); synth.cancel(); done(); };
    synth.cancel();
    synth.speak(utterance);
  }), [silence]);

  // ── Micrófono ────────────────────────────────────────────────────────────

  /** Records until the speaker goes quiet (or Espacio). The microphone is open only while listening. */
  const listen = useCallback(async (): Promise<Heard> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return { blob: null, reason: 'nomic' };
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    return new Promise<Heard>((resolve) => {
      const started = performance.now();
      let floor = 0;
      let floorFrames = 0;
      let voiced = 0;
      let lastVoice = 0;
      let lastTick = started;
      let lastPaint = 0;
      let timer = 0;
      let reason: Heard['reason'] | null = null;

      const finish = (why: Heard['reason']) => {
        if (reason) return;
        reason = why;
        window.clearInterval(timer);
        stopListening.current = null;
        setLevel(0);
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          void context.close();
          const blob = why === 'speech' && chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null;
          resolve({ blob, reason: blob ? 'speech' : why === 'speech' ? 'silence' : why });
        };
        if (recorder.state !== 'inactive') recorder.stop();
        else recorder.onstop?.(new Event('stop'));
      };

      stopListening.current = (send) => finish(send ? 'speech' : 'cancelled');
      recorder.start(250);
      timer = window.setInterval(() => {
        const now = performance.now();
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        if (now - started < 300) { floor += rms; floorFrames += 1; }
        const threshold = Math.max(0.012, (floorFrames ? floor / floorFrames : 0) * 2.5);
        if (rms > threshold) { voiced += now - lastTick; lastVoice = now; }
        lastTick = now;
        if (now - lastPaint > 90) { lastPaint = now; setLevel(Math.min(1, rms * 9)); }
        const spoke = voiced > 150;
        if (spoke && now - lastVoice > SILENCE_MS) finish('speech');
        else if (!spoke && now - started > NO_SPEECH_MS) finish('silence');
        else if (now - started > MAX_ANSWER_MS) finish(spoke ? 'speech' : 'silence');
      }, 40);
    });
  }, []);

  // ── El bucle ─────────────────────────────────────────────────────────────

  const finishSession = useCallback(() => {
    token.current += 1;
    silence();
    stopListening.current?.(false);
    setStage('done');
    void syncNow();
  }, [silence]);

  const count = useCallback((verdictOrGrade: string | null | undefined) => {
    const key = verdictOrGrade === 'correct' || verdictOrGrade === 'good' || verdictOrGrade === 'easy' ? 'correct'
      : verdictOrGrade === 'partial' || verdictOrGrade === 'hard' ? 'partial'
        : verdictOrGrade === 'wrong' || verdictOrGrade === 'again' ? 'wrong' : null;
    if (key) setTally((t) => ({ ...t, [key]: t[key] + 1 }));
  }, []);

  // The steps call each other; refs break the cycle for the hooks.
  const askRef = useRef<(next: OralCard, replay?: boolean) => Promise<void>>(async () => {});
  const advanceRef = useRef<() => Promise<void>>(async () => {});

  const noAnswer = useCallback(async (current: OralCard, message?: string) => {
    silences.current += 1;
    if (silences.current <= 1 && !message) {
      setHint('No te he oído. Repito la pregunta.');
      await askRef.current(current);
      return;
    }
    setHint(message ?? 'Sigo sin oírte. Pulsa Espacio para responder, S para saltar, o sube un audio.');
    setStage('waiting');
  }, []);

  const submit = useCallback(async (current: OralCard, send: () => Promise<OralResult>) => {
    const mine = ++token.current;
    silence();
    stopListening.current?.(false);
    setError('');
    setStage('thinking');
    let res: OralResult;
    try {
      res = await send();
    } catch (e) {
      if (mine !== token.current) return;
      setError(errText(e));
      setStage('waiting');
      return;
    }
    if (mine !== token.current) return;
    if (res.error === 'stt_unavailable') { setError(res.note ?? 'No se pudo transcribir la respuesta.'); setStage('waiting'); return; }
    const via = res.transcription?.via;
    if (via === 'funes' || via === 'prospero' || via === 'local') setStatus((s) => (s ? { ...s, stt: via } : s));
    if (!res.heard) { await noAnswer(current); return; }
    silences.current = 0;
    if (res.action === 'repeat') { await askRef.current(current); return; }
    if (res.action === 'stop') { finishSession(); return; }
    exclude.current.push(current.id);
    pendingNext.current = res.next ?? null;
    if (res.action === 'skip') { setTally((t) => ({ ...t, skipped: t.skipped + 1 })); await advanceRef.current(); return; }
    setResult(res);
    setTyped('');
    setStage('result');
    await say(res.feedbackAudio, res.feedbackSpoken ?? '');
    if (mine !== token.current) return;
    if (!res.recorded) return;                       // the grade is asked for: 1-4 or Enter
    count(res.verdict);
    if (options.current.autoAdvance) {
      await sleep(700);
      if (mine === token.current) await advanceRef.current();
    }
  }, [silence, noAnswer, finishSession, say, count]);

  const hear = useCallback(async (current: OralCard) => {
    const mine = ++token.current;
    silence();
    setStage('listening');
    const heard = await listen();
    if (mine !== token.current || heard.reason === 'cancelled') return;
    if (heard.reason === 'nomic') {
      setHint('No hay micrófono disponible. Sube un audio o escribe la respuesta.');
      setStage('waiting');
      return;
    }
    if (!heard.blob) { await noAnswer(current); return; }
    const blob = heard.blob;
    await submit(current, () => answerOralAudio(current.id, blob, 'respuesta.webm', scope()));
  }, [silence, listen, noAnswer, submit, scope]);

  const ask = useCallback(async (next: OralCard) => {
    const mine = ++token.current;
    stopListening.current?.(false);
    setCard(next);
    setResult(null);
    setError('');
    setStage('asking');
    if (next.audio) setStatus((s) => (s ? { ...s, tts: true } : s));      // what just worked is the best evidence
    await say(next.audio, next.spoken);
    if (mine !== token.current) return;
    setHint('');
    await hear(next);
  }, [say, hear]);
  askRef.current = ask;

  const advance = useCallback(async () => {
    const mine = ++token.current;
    silence();
    stopListening.current?.(false);
    silences.current = 0;
    let next = pendingNext.current;
    pendingNext.current = null;
    if (!next) {
      setStage('loading');
      try {
        next = await nextOralCard(scope());
      } catch (e) {
        if (mine !== token.current) return;
        setError(errText(e));
        setStage(cardRef.current ? 'waiting' : 'setup');
        return;
      }
      if (mine !== token.current) return;
    }
    setRemaining(next.remaining);
    if (!next.card) { finishSession(); return; }
    await ask(next.card);
  }, [silence, scope, finishSession, ask]);
  advanceRef.current = advance;

  const start = useCallback(() => {
    exclude.current = [];
    pendingNext.current = null;
    setTally({ correct: 0, partial: 0, wrong: 0, skipped: 0 });
    setHint('');
    setError('');
    void advance();
  }, [advance]);

  const skip = useCallback(() => {
    const current = cardRef.current;
    if (!current) return;
    if (!exclude.current.includes(current.id)) {
      exclude.current.push(current.id);
      setTally((t) => ({ ...t, skipped: t.skipped + 1 }));
    }
    void advance();
  }, [advance]);

  const gradeNow = useCallback(async (grade: ReviewGrade) => {
    const current = cardRef.current;
    if (!current || grading) return;
    token.current += 1;
    silence();
    setGrading(true);
    try {
      await reviewQuestion(current.id, grade);
      count(grade);
      await advance();
    } catch (e) {
      setError(errText(e));
    } finally {
      setGrading(false);
    }
  }, [grading, silence, count, advance]);

  const onUpload = useCallback((file: File | undefined) => {
    const current = cardRef.current;
    if (!file || !current) return;
    void submit(current, () => answerOralAudio(current.id, file, file.name, scope()));
  }, [submit, scope]);

  const onTyped = useCallback(() => {
    const current = cardRef.current;
    const text = typed.trim();
    if (!text || !current) return;
    void submit(current, () => answerOralText(current.id, text, scope()));
  }, [typed, submit, scope]);

  // ── Teclado ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = stageRef.current;
      const current = cardRef.current;
      const res = resultRef.current;
      const key = e.key.toLowerCase();
      if (now === 'setup' || now === 'done') {
        if (key === 'enter') { e.preventDefault(); start(); }
        return;
      }
      if (key === 'escape') { e.preventDefault(); finishSession(); return; }
      if (!current) return;
      if (key === ' ') {
        e.preventDefault();
        if (now === 'listening') stopListening.current?.(true);
        else if (now === 'waiting' || now === 'asking') void hear(current);
      } else if (key === 'r' && now !== 'thinking' && !(now === 'result' && res?.recorded)) {
        e.preventDefault();
        void ask(current);
      } else if (key === 's' && now !== 'thinking' && !(now === 'result' && res?.recorded)) {
        e.preventDefault();
        skip();
      } else if (now === 'result' && res) {
        const wanted = !res.recorded;
        if (wanted && ['1', '2', '3', '4'].includes(key)) { e.preventDefault(); void gradeNow(GRADES[Number(key) - 1].id); }
        else if (key === 'enter') {
          e.preventDefault();
          if (wanted && res.grade) void gradeNow(res.grade);
          else if (!wanted) void advance();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start, finishSession, hear, ask, skip, gradeNow, advance]);

  useEffect(() => () => {
    token.current += 1;
    stopPlayback.current?.();
    stopListening.current?.(false);
    void syncNow();
  }, []);

  // ── Vista ────────────────────────────────────────────────────────────────

  const subjectName = subjects.find((s) => s.id === subject)?.name ?? 'Todas las asignaturas';
  const running = stage !== 'setup' && stage !== 'done';
  const answered = tally.correct + tally.partial + tally.wrong;
  const wantsGrade = stage === 'result' && result !== null && !result.recorded;
  const settled = stage === 'result' && result !== null && result.recorded;      // graded: only «Siguiente» is left

  if (detection !== 'on') {
    return (
      <div className="min-h-screen bg-ink-950 text-ink-300 flex items-center justify-center p-6 text-sm">
        {detection === 'pending' ? 'Conectando con Hypatia…' : 'El repaso oral necesita el servidor local de Hypatia.'}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex flex-col" data-testid="oral-page">
      <header className="border-b border-ink-800 bg-ink-900/80 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(routeSubject ? `/subject/${routeSubject}` : '/')} aria-label="Volver"
            className="text-ink-400 hover:text-ink-100 text-lg leading-none px-1">←</button>
          <div className="min-w-0">
            <h1 className="font-display text-lg text-ink-100 leading-tight">Repaso oral</h1>
            <p className="text-xs text-ink-500 truncate">{subjectName}</p>
          </div>
          <div className="ml-auto flex flex-wrap justify-end gap-1.5 text-[11px]" data-testid="oral-status">
            {status === null ? (
              <span className="rounded-full border border-ink-700 text-ink-500 px-2 py-0.5">Comprobando voz y transcripción…</span>
            ) : (
              <>
                <Chip ok={status.tts} on="Voz de la familia" off="Voz del navegador" />
                <Chip ok={Boolean(status.stt)} on={`Transcripción: ${status.stt ?? ''}`} off="Sin transcripción" />
                <Chip ok={status.llm} on="Comparación por significado" off="Sin modelo: nota a mano" />
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 flex flex-col gap-4">
        {(stage === 'setup' || stage === 'done') && (
          <section className="rounded-2xl bg-ink-900 border border-ink-700 p-6 flex flex-col gap-4">
            {stage === 'done' && (
              <div data-testid="oral-summary">
                <h2 className="font-display text-xl text-ink-100 mb-1">Repaso terminado</h2>
                <p className="text-sm text-ink-300">
                  {answered === 0 && tally.skipped === 0
                    ? 'No quedan tarjetas para repasar de viva voz.'
                    : `${answered} tarjeta${answered === 1 ? '' : 's'}: ${tally.correct} bien, ${tally.partial} a medias, ${tally.wrong} para repetir`
                      + (tally.skipped ? ` · ${tally.skipped} saltada${tally.skipped === 1 ? '' : 's'}` : '')}
                </p>
              </div>
            )}
            {stage === 'setup' && (
              <p className="text-sm text-ink-300">
                Hypatia lee cada pregunta, tú respondes en voz alta y la nota entra en tu repaso espaciado.
                Al callarte se da la respuesta por terminada.
              </p>
            )}
            <label className="flex flex-col gap-1 text-xs text-ink-400">
              Asignatura
              <select value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="oral-subject"
                className="bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100">
                <option value="">Todas las asignaturas</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
              Pasar sola a la siguiente tarjeta
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input type="checkbox" checked={confirmGrade} onChange={(e) => setConfirmGrade(e.target.checked)} data-testid="oral-confirm" />
              Confirmar la nota antes de guardarla
            </label>
            {status && !status.stt && (
              <p className="text-xs text-amber-300">
                No hay transcripción disponible ahora: arranca Prospero's Hoard desde el Hub, o escribe las respuestas.
              </p>
            )}
            <div>
              <Button onClick={start} data-testid="oral-start">{stage === 'done' ? 'Otra tanda' : 'Empezar'} <span className="opacity-60 text-xs">[Enter]</span></Button>
            </div>
            {error && <p className="text-sm text-rose-400" role="alert">{error}</p>}
          </section>
        )}

        {running && (
          <>
            <div className="flex items-center gap-3 text-xs text-ink-400">
              <span className="inline-flex items-center gap-2" data-testid="oral-stage" data-stage={stage} aria-live="polite">
                <span className={`w-2.5 h-2.5 rounded-full ${stage === 'listening' ? 'bg-rose-500 animate-pulse' : stage === 'asking' ? 'bg-amber-500 animate-pulse' : stage === 'thinking' || stage === 'loading' ? 'bg-sky-500 animate-pulse' : 'bg-ink-500'}`} aria-hidden="true" />
                {STAGE_TEXT[stage]}
              </span>
              <span className="ml-auto">
                {answered + tally.skipped > 0 && `${answered + tally.skipped} hecha${answered + tally.skipped === 1 ? '' : 's'} · `}
                {remaining !== null && remaining > 1 && `${remaining - 1} más en cola`}
              </span>
            </div>

            {card && (
              <section className="rounded-2xl bg-ink-900 border border-ink-700 p-6 flex flex-col gap-4" data-testid="oral-card">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  {card.subject && <span className="text-ink-400 bg-ink-800 rounded px-2 py-0.5">{card.subject}</span>}
                  {card.topic && <span className="text-ink-500 bg-ink-800 rounded px-2 py-0.5">{card.topic}</span>}
                </div>
                <MdContent content={card.prompt} className="prose prose-invert max-w-none text-ink-100 text-lg" />
                {card.clozeText && <p className="text-ink-300">{card.clozeText.replace(/\{\{[^}]*\}\}/g, '_____')}</p>}
                {card.options && (
                  <ol className="flex flex-col gap-1.5 text-sm text-ink-200">
                    {card.options.map((o) => (
                      <li key={o.id} className="flex gap-2"><span className="text-amber-400 font-medium">{o.letter})</span><span>{o.text}</span></li>
                    ))}
                  </ol>
                )}

                {stage === 'listening' && (
                  <div className="h-2 rounded-full bg-ink-800 overflow-hidden" aria-hidden="true">
                    <div className="h-full bg-rose-500 transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
                  </div>
                )}
                {hint && <p className="text-sm text-amber-300" data-testid="oral-hint">{hint}</p>}
                {error && <p className="text-sm text-rose-400" role="alert" data-testid="oral-error">{error}</p>}

                {stage === 'result' && result && (
                  <div className="flex flex-col gap-3 border-t border-ink-800 pt-4" data-testid="oral-result">
                    <p className="text-sm text-ink-300">
                      <span className="text-ink-500">Has dicho: </span>
                      <span data-testid="oral-transcript">«{result.transcript}»</span>
                    </p>
                    {result.verdict && (
                      <span className={`self-start rounded-lg border px-3 py-1 text-sm font-medium ${VERDICT[result.verdict].cls}`} data-testid="oral-verdict" data-verdict={result.verdict}>
                        {VERDICT[result.verdict].label}
                      </span>
                    )}
                    {result.feedback && <p className="text-sm text-ink-200">{result.feedback}</p>}
                    {(result.covered?.length ?? 0) > 0 && (
                      <div data-testid="oral-covered">
                        <p className="text-xs uppercase tracking-widest text-sage-400 mb-1">Has acertado</p>
                        <ul className="list-disc pl-5 text-sm text-ink-200">{result.covered!.map((c, i) => <li key={i}>{c}</li>)}</ul>
                      </div>
                    )}
                    {(result.missing?.length ?? 0) > 0 && (
                      <div data-testid="oral-missing">
                        <p className="text-xs uppercase tracking-widest text-rose-400 mb-1">Te ha faltado</p>
                        <ul className="list-disc pl-5 text-sm text-ink-200">{result.missing!.map((c, i) => <li key={i}>{c}</li>)}</ul>
                      </div>
                    )}
                    {result.expected && (
                      <div>
                        <p className="text-xs uppercase tracking-widest text-ink-500 mb-1">Respuesta esperada</p>
                        <p className="text-sm text-ink-300">{result.expected}</p>
                      </div>
                    )}
                    {result.recorded && result.review && (
                      <p className="text-xs text-ink-500" data-testid="oral-review">
                        Nota guardada: {GRADES.find((g) => g.id === result.grade)?.label ?? result.grade}
                        {result.review.nextReviewAt && ` · próximo repaso el ${formatDay(result.review.nextReviewAt)}`}
                      </p>
                    )}
                    {wantsGrade && (
                      <div data-testid="oral-grade">
                        <p className="text-xs text-ink-400 mb-2">
                          {result.grade ? 'Nota propuesta marcada. Enter la acepta; 1-4 la cambia.' : 'Compara con la respuesta esperada y ponte nota.'}
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {GRADES.map((g, i) => (
                            <button key={g.id} disabled={grading} onClick={() => void gradeNow(g.id)} data-testid={`oral-grade-${g.id}`}
                              className={`py-2.5 rounded-xl border text-sm font-medium transition-colors ${g.cls} ${result.grade === g.id ? 'ring-2 ring-amber-400' : ''}`}>
                              {g.label}<span className="text-xs opacity-60 ml-1">[{i + 1}]</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {card && (
              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {stage === 'listening' && (
                    <Button onClick={() => stopListening.current?.(true)} data-testid="oral-done-speaking">He terminado <span className="opacity-60 text-xs">[Espacio]</span></Button>
                  )}
                  {(stage === 'waiting' || stage === 'asking') && (
                    <Button onClick={() => void hear(card)} data-testid="oral-answer-now">Responder ahora <span className="opacity-60 text-xs">[Espacio]</span></Button>
                  )}
                  {stage === 'result' && result?.recorded && (
                    <Button onClick={() => void advance()} data-testid="oral-next">Siguiente <span className="opacity-60 text-xs">[Enter]</span></Button>
                  )}
                  {!settled && (
                    <>
                      <Button variant="secondary" disabled={stage === 'thinking'} onClick={() => void ask(card)} data-testid="oral-repeat">Repetir pregunta <span className="opacity-60 text-xs">[R]</span></Button>
                      <Button variant="secondary" disabled={stage === 'thinking'} onClick={skip} data-testid="oral-skip">Saltar <span className="opacity-60 text-xs">[S]</span></Button>
                      <Button variant="secondary" disabled={stage === 'thinking' || stage === 'result'} onClick={() => fileInput.current?.click()}>Subir audio</Button>
                    </>
                  )}
                  <input ref={fileInput} type="file" accept="audio/*,video/webm,.wav,.mp3,.m4a,.ogg,.webm,.flac" className="hidden" data-testid="oral-upload"
                    onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />
                  <Button variant="ghost" onClick={finishSession} data-testid="oral-finish">Terminar <span className="opacity-60 text-xs">[Esc]</span></Button>
                </div>
                {stage !== 'result' && stage !== 'thinking' && (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onTyped(); }}>
                    <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="O escribe la respuesta" data-testid="oral-typed"
                      aria-label="Escribir la respuesta"
                      className="flex-1 bg-ink-800 border border-ink-700 rounded-lg px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600" />
                    <Button type="submit" variant="secondary" disabled={!typed.trim()}>Enviar</Button>
                  </form>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Chip({ ok, on, off }: { ok: boolean; on: string; off: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 ${ok ? 'border-sage-500/40 text-sage-300' : 'border-ink-700 text-ink-500'}`}>
      {ok ? on : off}
    </span>
  );
}
