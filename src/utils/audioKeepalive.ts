/**
 * audioKeepalive.ts
 *
 * Mantiene la sesión de audio del navegador activa en segundo plano en Android.
 *
 * PROBLEMA en Android 16 (Pixel):
 *   Chrome es MUY agresivo matando tabs en segundo plano. Incluso con
 *   AudioContext + MediaStream, Android puede matar el tab si detecta
 *   que no hay "audio real" reproduciéndose.
 *
 * SOLUCIÓN — Triple capa:
 *
 *   1. <audio> element con WAV REAL en loop (NO silencio, NO MediaStream)
 *      → Un archivo WAV con un tono de 150Hz a -70dBFS (completamente inaudible
 *        pero con samples NO CERO). Android detecta que hay audio real y
 *        NO mata el tab. Esto es lo que diferencia nuestra app de YouTube/Rumble:
 *        ellos siempre tienen un stream de audio real, nunca silencio.
 *      → El WAV dura 5 segundos y se reproduce en loop infinito.
 *      → El elemento DEBE estar en el DOM para que Android lo reconozca.
 *
 *   2. AudioContext con oscilador como refuerzo
 *      → Mantiene el proceso de audio del navegador activo.
 *      → Si el WAV falla, el AudioContext es la red de seguridad.
 *
 *   3. Screen Wake Lock + monitoreo periódico en background
 *      → Wake Lock evita que la pantalla se apague.
 *      → Cada 5s verifica que el audio siga activo y lo re-resume si Android
 *        lo suspendió.
 *
 *   CLAVE: Usamos un WAV con contenido REAL (no Blob de silencio ni MediaStream)
 *   porque Android 16 detecta audio "falso" y lo ignora para decidir si
 *   mata el tab.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AudioKeepaliveManager {
  /** Inicia el audio keepalive + solicita Wake Lock */
  start(): Promise<void>;
  /** Detiene el audio y libera Wake Lock */
  stop(): void;
  /** Indica si el keep-alive está activo */
  isActive(): boolean;
  /** Devuelve el HTMLAudioElement interno (para vincular Media Session) */
  getAudioElement(): HTMLAudioElement | null;
  /** Limpieza completa (destruye todos los recursos) */
  destroy(): void;
}

// ─── WAV Generator — tono inaudible pero con datos reales ────────────────────

/**
 * Genera un WAV de 5 segundos con un tono de 150Hz a amplitud MUY baja.
 *
 * ¿Por qué NO silencio?
 *   Android 16 detecta WAVs de silencio (todos los samples = 0) y NO los
 *   cuenta como "audio activo". El tab se mata igual.
 *
 * ¿Por qué 150Hz?
 *   - Está en el rango audible (20Hz-20kHz) así que Android lo reconoce
 *   - Pero a -70dBFS (amplitude ~10/32767) es completamente inaudible
 *   - Incluso en auriculares a volumen máximo, está por debajo del piso de ruido
 *
 * ¿Por qué 5 segundos?
 *   - Loop más largo = menos overhead de loop processing
 *   - Android tiene más tiempo para "ver" el audio antes de que el loop reinicie
 */
function createKeepaliveToneWav(): Blob {
  const sampleRate = 22050;
  const duration = 5;
  const frequency = 150;
  // Amplitude ~10/32767 = -70dBFS — completamente inaudible
  // pero con samples NO CERO para que Android lo reconozca
  const amplitude = 0.0003;
  const numSamples = sampleRate * duration;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Generar tono sinusoidal a amplitud mínima
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(
      amplitude * 32767 * Math.sin(2 * Math.PI * frequency * i / sampleRate),
    );
    view.setInt16(headerSize + i * 2, sample, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── CSS ────────────────────────────────────────────────────────────────────────

const HIDDEN_STYLE =
  'position:fixed;top:-9999px;left:-9999px;width:0;height:0;opacity:0;pointer-events:none';

// ─── Implementation ────────────────────────────────────────────────────────────

export function createAudioKeepalive(): AudioKeepaliveManager {
  // Capa 1: <audio> element con WAV real
  let audio: HTMLAudioElement | null = null;
  let wavUrl: string | null = null;

  // Capa 2: AudioContext como refuerzo
  let audioCtx: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;

  // Capa 3: Wake Lock + monitoreo
  let wakeLock: WakeLockSentinel | null = null;
  let bgInterval: ReturnType<typeof setInterval> | null = null;
  let active = false;

  // ── Limpieza ────────────────────────────────────────────────────────────

  function teardown() {
    // Limpiar audio element
    if (audio) {
      try { audio.pause(); } catch { /* ignore */ }
      audio.removeAttribute('src');
      audio.srcObject = null;
      if (audio.parentNode) audio.remove();
      audio = null;
    }
    if (wavUrl) {
      URL.revokeObjectURL(wavUrl);
      wavUrl = null;
    }

    // Limpiar AudioContext
    if (oscillator) {
      try { oscillator.stop(); } catch { /* ignore */ }
      try { oscillator.disconnect(); } catch { /* ignore */ }
      oscillator = null;
    }
    if (gainNode) {
      try { gainNode.disconnect(); } catch { /* ignore */ }
      gainNode = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch { /* ignore */ }
    }
    audioCtx = null;

    // Limpiar intervalo
    if (bgInterval) {
      clearInterval(bgInterval);
      bgInterval = null;
    }
  }

  // ── Visibility handler ──────────────────────────────────────────────────

  function onVisibilityChange() {
    if (!active) return;

    if (document.visibilityState === 'visible') {
      // Volvimos al foreground — re-resumir todo
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => { /* ignore */ });
      }
      if (audio && audio.paused) {
        audio.play().catch(() => { /* ignore */ });
      }
      // Limpiar intervalo de background
      if (bgInterval) { clearInterval(bgInterval); bgInterval = null; }
    } else if (document.visibilityState === 'hidden') {
      // Background — monitoreo periódico cada 5s
      if (!bgInterval) {
        bgInterval = setInterval(() => {
          if (!active) {
            if (bgInterval) { clearInterval(bgInterval); bgInterval = null; }
            return;
          }
          if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => { /* ignore */ });
          }
          if (audio && audio.paused) {
            audio.play().catch(() => { /* ignore */ });
          }
        }, 5000);
      }
    }
  }

  // ── Setup ───────────────────────────────────────────────────────────────

  /** Capa 1: Audio element con WAV real (método principal) */
  function setupRealWavAudio() {
    const blob = createKeepaliveToneWav();
    wavUrl = URL.createObjectURL(blob);

    audio = document.createElement('audio');
    audio.src = wavUrl;
    audio.loop = true;
    audio.volume = 1.0; // Volume 1.0 — el contenido del WAV ya es inaudible (-70dBFS)
    audio.setAttribute('playsinline', '');
    // CLAVE: en el DOM para que Android lo reconozca
    audio.style.cssText = HIDDEN_STYLE;
    document.body.appendChild(audio);
  }

  /** Capa 2: AudioContext como refuerzo */
  function setupAudioContextReinforcement() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      audioCtx = new AudioCtx();

      oscillator = audioCtx.createOscillator();
      oscillator.frequency.setValueAtTime(150, audioCtx.currentTime);
      oscillator.type = 'sine';

      gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0.001, audioCtx.currentTime);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      // También conectar a MediaStreamDestination → refuerza la sesión de media
      if (audioCtx.createMediaStreamDestination) {
        const streamDest = audioCtx.createMediaStreamDestination();
        gainNode.connect(streamDest);
        // No necesitamos otro <audio> element — el WAV ya cubre eso
      }
    } catch {
      // AudioContext no disponible — el WAV sigue funcionando
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* no es crítico */ }
  }

  function releaseWakeLock() {
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  return {
    async start() {
      if (active) return;

      // Limpiar recursos anteriores
      teardown();

      // Capa 1: WAV real con tono (método principal)
      setupRealWavAudio();

      // Capa 2: AudioContext como refuerzo
      setupAudioContextReinforcement();

      // Iniciar oscilador
      if (oscillator && audioCtx) {
        try { oscillator.start(0); } catch { /* ya iniciado */ }
        if (audioCtx.state === 'suspended') {
          try { await audioCtx.resume(); } catch { /* ignore */ }
        }
      }

      // Play WAV — esto es lo que mantiene el tab vivo en Android
      if (audio) {
        try { await audio.play(); } catch { /* autoplay blocked */ }
      }

      active = true;
      await requestWakeLock();
      document.addEventListener('visibilitychange', onVisibilityChange);
    },

    stop() {
      if (!active) return;
      active = false;

      teardown();
      releaseWakeLock();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },

    isActive() {
      return active;
    },

    getAudioElement() {
      return audio;
    },

    destroy() {
      this.stop();
    },
  };
}
