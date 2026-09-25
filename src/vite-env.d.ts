/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' only in the build served by the local Hypatia's Hoard server (npm run build:hoard). */
  readonly VITE_HOARD?: string;
}
