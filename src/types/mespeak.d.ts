/**
 * Type declarations for meSpeak.js
 * Based on meSpeak v1.9.6 API
 */
declare module 'mespeak' {
  interface SpeakOptions {
    /** Velocidad: 80–450, default 175 */
    speed?: number;
    /** Tono: 0–99, default 50 */
    pitch?: number;
    /** Amplitud: 0–200, default 100 */
    amplitude?: number;
    /** Voz: código de idioma, p.ej. 'es', 'en' */
    voice?: string;
    /** Variante de voz, p.ej. 'f2', 'm3' */
    variant?: string;
    /** Word gap en unidades de 10ms */
    wordgap?: number;
    /** Si true, retorna datos en vez de reproducir */
    rawdata?: boolean | string;
    /** Volumen de reproducción */
    volume?: number;
    /** Si true, habilita SSML */
    ssml?: boolean;
    /** Log de argumentos a consola */
    log?: boolean;
    /** Callback al terminar */
    callback?: () => void;
    // Aliases cortos
    s?: number;
    p?: number;
    a?: number;
    v?: string;
    g?: number;
    b?: number;
    l?: number;
    k?: number;
    z?: boolean;
    m?: boolean;
    markup?: boolean;
    punct?: string | boolean;
    utf16?: boolean;
    nostop?: boolean;
    linebreak?: number;
    capitals?: number;
  }

  interface MeSpeak {
    speak(text: string, options?: SpeakOptions, callback?: () => void): ArrayBuffer | number | null;
    speakMultipart(parts: Array<{ text: string } & SpeakOptions>, options?: SpeakOptions, callback?: () => void): ArrayBuffer | number | null;
    loadConfig(config: object): void;
    loadVoice(voice: object, callback?: (success: boolean, voiceId: string) => void): void;
    setDefaultVoice(voice: string): void;
    getDefaultVoice(): string;
    setVolume(volume: number): void;
    getVolume(): number;
    play(stream: ArrayBuffer | number[], volume?: number, callback?: () => void): number;
    isConfigLoaded(): boolean;
    isVoiceLoaded(voice: string): boolean;
    resetQueue(): void;
    canPlay(): boolean;
    stop(): void;
  }

  const meSpeak: MeSpeak;
  export default meSpeak;
}

declare module 'mespeak/src/mespeak_config.json' {
  const config: object;
  export default config;
}

declare module 'mespeak/voices/es.json' {
  const voice: object;
  export default voice;
}

declare module 'mespeak/voices/es-la.json' {
  const voice: object;
  export default voice;
}
