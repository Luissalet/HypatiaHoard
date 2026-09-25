/**
 * mediaSessionController.ts
 *
 * Wrapper sobre la Media Session API para mostrar controles de reproducción
 * en la pantalla de bloqueo y la barra de notificaciones del móvil.
 *
 * En Android Chrome, la notificación de media SOLO aparece si hay un
 * HTMLMediaElement (<audio> o <video>) activamente reproduciendo.
 * Por eso este controlador acepta opcionalmente una referencia al
 * <audio> del keepalive para garantizar que la notificación se muestre.
 *
 * Degradación elegante: si el navegador no soporta Media Session,
 * todas las operaciones son no-ops silenciosos.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MediaSessionMetadata {
  /** Nombre del PDF o tema */
  title: string;
  /** Texto secundario, p.ej. nombre de la asignatura */
  artist?: string;
  /** Texto terciario, p.ej. "Bloque 5 de 42" */
  album?: string;
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onNextTrack?: () => void;
  onPreviousTrack?: () => void;
  onStop?: () => void;
  onSeekTo?: (time: number) => void;
}

export interface MediaSessionController {
  /** Actualiza la info mostrada en la notificación */
  updateMetadata(info: MediaSessionMetadata): void;
  /** Actualiza el estado del reproductor (playing/paused/none) */
  setPlaybackState(state: 'playing' | 'paused' | 'none'): void;
  /** Registra los handlers de los botones del lock screen */
  setHandlers(handlers: MediaSessionHandlers): void;
  /**
   * Actualiza la posición de reproducción mostrada en la notificación.
   * Esto permite que Android muestre una barra de progreso en la notificación.
   */
  setPositionState(currentBlock: number, totalBlocks: number): void;
  /** Limpia handlers y metadata */
  cleanup(): void;
}

// ─── Implementation ────────────────────────────────────────────────────────────

function isMediaSessionSupported(): boolean {
  return 'mediaSession' in navigator;
}

export function createMediaSessionController(): MediaSessionController {
  const supported = isMediaSessionSupported();

  // Construir URLs absolutas para artwork — las relativas pueden no resolver
  // correctamente en Android cuando la app está en segundo plano o en la
  // pantalla de bloqueo, causando que la notificación no muestre la imagen.
  const base = document.baseURI || window.location.origin + '/';
  const artwork192 = new URL('pwa-192x192.png', base).href;
  const artwork512 = new URL('pwa-512x512.png', base).href;

  return {
    updateMetadata(info: MediaSessionMetadata) {
      if (!supported) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: info.title,
          artist: info.artist ?? 'ExamCoach',
          album: info.album ?? '',
          artwork: [
            { src: artwork192, sizes: '192x192', type: 'image/png' },
            { src: artwork512, sizes: '512x512', type: 'image/png' },
          ],
        });
      } catch {
        // Algunos navegadores pueden fallar con artwork inválido
      }
    },

    setPlaybackState(state: 'playing' | 'paused' | 'none') {
      if (!supported) return;
      try {
        navigator.mediaSession.playbackState = state;
      } catch {
        // No-op
      }
    },

    setHandlers(handlers: MediaSessionHandlers) {
      if (!supported) return;
      const actions: Array<[MediaSessionAction, (() => void) | undefined]> = [
        ['play', handlers.onPlay],
        ['pause', handlers.onPause],
        ['nexttrack', handlers.onNextTrack],
        ['previoustrack', handlers.onPreviousTrack],
        ['stop', handlers.onStop],
      ];

      for (const [action, handler] of actions) {
        try {
          if (handler) {
            navigator.mediaSession.setActionHandler(action, handler);
          }
        } catch {
          // Acción no soportada en este navegador — ignorar
        }
      }

      // seekto handler para barra de progreso
      if (handlers.onSeekTo) {
        try {
          navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime != null) {
              handlers.onSeekTo!(details.seekTime);
            }
          });
        } catch {
          // seekto no soportado — ignorar
        }
      }
    },

    setPositionState(currentBlock: number, totalBlocks: number) {
      if (!supported) return;
      try {
        // Usamos "segundos ficticios" donde cada bloque = 1 segundo
        // para que la barra de progreso de la notificación funcione
        navigator.mediaSession.setPositionState({
          duration: totalBlocks,
          playbackRate: 1,
          position: Math.min(currentBlock, totalBlocks),
        });
      } catch {
        // setPositionState no soportado o parámetros inválidos
      }
    },

    cleanup() {
      if (!supported) return;
      const actions: MediaSessionAction[] = [
        'play', 'pause', 'nexttrack', 'previoustrack', 'stop',
      ];
      for (const action of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignorar
        }
      }
      try {
        navigator.mediaSession.setActionHandler('seekto', null);
      } catch { /* ignore */ }
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      } catch {
        // Ignorar
      }
    },
  };
}
