import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Deployed to GitHub Pages at aronecoff.github.io/tally/, so everything lives
// under the /tally/ base path. (For a root-domain host like Vercel, set base '/'.)
const base = '/tally/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      // Take over the moment a new build is installed. Without these a fresh
      // deploy sat waiting behind the old worker, so the app kept running the
      // previous bundle no matter how many times it was relaunched.
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // The display serif (Instrument Serif) comes from Google Fonts. Cache the
        // stylesheet and the font files so offline launches keep the hero figures.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Tally — Personal Finance',
        short_name: 'Tally',
        description: 'Track spending and stay inside your limits, offline-first.',
        // The approved canvas (#09090B), same as index.html and tokens.css --bg.
        theme_color: '#09090B',
        background_color: '#09090B',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  test: {
    // `.claude/worktrees/` holds full checkouts of this repo (agent worktrees),
    // so their copies of every *.test.ts would otherwise be discovered and run
    // alongside the real ones — doubling the suite and letting a stale worktree
    // fail `npm test` on main.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Vitest stubs every CSS import to '' unless told otherwise. Tests that pin
    // layout rules jsdom cannot apply read a stylesheet's text with `?raw`.
    css: { include: [/\.css\?raw$/] },
    // One tab per test file: no Dexie notices across files (see the file).
    setupFiles: ['./src/test-setup.ts'],
  },
})
