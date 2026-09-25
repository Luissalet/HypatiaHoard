/**
 * TtsControls.tsx
 *
 * Barra de controles de reproducción TTS estilo "mini-player".
 * Fijada en la parte inferior de la página.
 */

import type { TtsState, TtsVoiceInfo } from '@/utils/ttsEngine';

// ─── Speed steps ───────────────────────────────────────────────────────────────

const RATE_STEPS = [0.75, 1.0, 1.25, 1.5, 2.0];

/** Format seconds into a human-readable string like "~3 min" or "~1 h 12 min" */
function formatRemaining(secs: number): string {
  if (secs <= 0) return '';
  if (secs < 60) return `~${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h} h ${m} min` : `~${h} h`;
}

function nextRate(current: number): number {
  const idx = RATE_STEPS.indexOf(current);
  if (idx === -1 || idx === RATE_STEPS.length - 1) return RATE_STEPS[0];
  return RATE_STEPS[idx + 1];
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface TtsControlsProps {
  state: TtsState;
  currentBlock: number;
  totalBlocks: number;
  rate: number;
  voiceName: string;
  voices: TtsVoiceInfo[];
  /** Estimated seconds remaining (null = not yet available) */
  estimatedRemaining?: number | null;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onRateChange: (rate: number) => void;
  onVoiceChange: (voiceName: string) => void;
  onSkipTo: (block: number) => void;
}

export function TtsControls({
  state,
  currentBlock,
  totalBlocks,
  rate,
  voiceName,
  voices,
  onPlay,
  onPause,
  onResume,
  onStop,
  onNext,
  onPrevious,
  onRateChange,
  onVoiceChange,
  onSkipTo,
  estimatedRemaining,
}: TtsControlsProps) {
  const progress = totalBlocks > 0 ? ((currentBlock + 1) / totalBlocks) * 100 : 0;
  const isPlaying = state === 'playing';
  const isPaused = state === 'paused';
  const isIdle = state === 'idle';
  const isLoading = state === 'loading';

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    const blockIdx = Math.min(Math.floor(pct * totalBlocks), totalBlocks - 1);
    onSkipTo(blockIdx);
  };

  return (
    <div className="sticky bottom-0 z-30 bg-ink-900 border-t border-ink-700 px-4 py-3">
      <div className="flex items-center gap-3 max-w-4xl mx-auto">
        {/* Transport controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={onPrevious}
            disabled={isIdle && !isLoading}
            className="p-1.5 text-ink-300 hover:text-amber-400 disabled:text-ink-600 disabled:cursor-not-allowed transition-colors"
            title="Anterior (←)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="3" width="2" height="10" />
              <polygon points="14,3 6,8 14,13" />
            </svg>
          </button>

          {isIdle ? (
            <button
              onClick={onPlay}
              disabled={totalBlocks === 0}
              className="p-2 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300 disabled:bg-ink-800 disabled:text-ink-600 disabled:cursor-not-allowed rounded-full transition-all"
              title="Reproducir (Espacio)"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <polygon points="4,2 14,8 4,14" />
              </svg>
            </button>
          ) : isLoading ? (
            <button
              disabled
              className="p-2 bg-amber-500/20 text-amber-400 rounded-full transition-all animate-pulse"
              title="Cargando audio…"
            >
              {/* Spinner: tres puntos girando */}
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
                <circle cx="8" cy="2" r="1.5" opacity="1" />
                <circle cx="13" cy="8" r="1.5" opacity="0.6" />
                <circle cx="8" cy="14" r="1.5" opacity="0.3" />
                <circle cx="3" cy="8" r="1.5" opacity="0.15" />
              </svg>
            </button>
          ) : isPlaying ? (
            <button
              onClick={onPause}
              className="p-2 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300 rounded-full transition-all"
              title="Pausar (Espacio)"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="2" width="3.5" height="12" />
                <rect x="9.5" y="2" width="3.5" height="12" />
              </svg>
            </button>
          ) : (
            <button
              onClick={onResume}
              className="p-2 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300 rounded-full transition-all"
              title="Reanudar (Espacio)"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <polygon points="4,2 14,8 4,14" />
              </svg>
            </button>
          )}

          <button
            onClick={onNext}
            disabled={isIdle && !isLoading}
            className="p-1.5 text-ink-300 hover:text-amber-400 disabled:text-ink-600 disabled:cursor-not-allowed transition-colors"
            title="Siguiente (→)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <polygon points="2,3 10,8 2,13" />
              <rect x="12" y="3" width="2" height="10" />
            </svg>
          </button>

          <button
            onClick={onStop}
            disabled={isIdle && !isLoading}
            className="p-1.5 text-ink-300 hover:text-red-400 disabled:text-ink-600 disabled:cursor-not-allowed transition-colors"
            title="Detener (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div
          className="flex-1 h-2 bg-ink-700 rounded-full cursor-pointer group relative"
          onClick={handleProgressClick}
          title={`Bloque ${currentBlock + 1} de ${totalBlocks}`}
        >
          <div
            className="h-full bg-amber-500 rounded-full transition-all duration-300 relative"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-amber-400 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg" />
          </div>
        </div>

        {/* Block counter + time estimate */}
        <div className="flex flex-col items-center min-w-[4rem]">
          <span className="text-xs text-ink-400 font-mono">
            {currentBlock + 1}/{totalBlocks}
          </span>
          {estimatedRemaining != null && estimatedRemaining > 0 && !isIdle && (
            <span className="text-[10px] text-ink-500 font-mono leading-tight">
              {formatRemaining(estimatedRemaining)}
            </span>
          )}
        </div>

        {/* Speed control */}
        <button
          onClick={() => onRateChange(nextRate(rate))}
          className="text-xs bg-ink-800 text-ink-300 hover:text-amber-400 hover:bg-ink-700 px-2 py-1 rounded transition-colors font-mono min-w-[3rem]"
          title="Cambiar velocidad (+/-)"
        >
          {rate}x
        </button>

        {/* Voice selector */}
        {voices.length > 1 && (
          <select
            value={voiceName}
            onChange={(e) => onVoiceChange(e.target.value)}
            className="text-xs bg-ink-800 text-ink-300 border border-ink-700 rounded px-1.5 py-1 max-w-[8rem] truncate hover:border-ink-500 transition-colors"
            title="Seleccionar voz"
          >
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.quality === 'enhanced' ? '⭐ ' : ''}{v.name.replace(/^(Google|Microsoft)\s*/i, '')}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
