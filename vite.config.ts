import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { initResourcesPlugin } from './vite-plugin-init-resources'

// Base URL configurable: se puede sobreescribir con la variable de entorno VITE_BASE_URL.
// Útil para forks o despliegues en rutas distintas a /ExamCoach/.
// En GitHub Actions se puede pasar: VITE_BASE_URL=/${{ github.event.repository.name }}/
const BASE_URL = process.env.VITE_BASE_URL ?? '/'
// Hypatia's Hoard always runs behind its local server (hoard mode on).
process.env.VITE_HOARD ??= '1'

export default defineConfig({
  plugins: [
    react(),
    initResourcesPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      // injectManifest, not generateSW: workbox-build's generateSW writes absolute module
      // paths into a JS template, and this folder's name ("Hypatia's Hoard") has an
      // apostrophe that breaks it. src/sw.ts is the whole worker (precache + SPA shell).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB — bundle includes pdfjs
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
      manifest: {
        name: "Hypatia's Hoard",
        short_name: 'Hypatia',
        description: 'Exam Coach 2: estudio para exámenes con tus fuentes y modelos locales, conectado a Faustus',
        theme_color: '#0a0907',
        background_color: '#0a0907',
        display: 'standalone',
        orientation: 'any',
        scope: BASE_URL,
        start_url: BASE_URL,
        lang: 'es',
        categories: ['education'],
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  base: BASE_URL,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  worker: {
    format: 'es',
  },
})