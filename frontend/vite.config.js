import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { version } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',      // new version auto-applies and reloads on next load
      injectRegister: false,           // we register manually in main.js
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'oRKLLM',
        short_name: 'oRKLLM',
        description: 'OpenAI-compatible local LLM inference for Rockchip NPU.',
        theme_color: '#7C3AED',
        background_color: '#0B0F19',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        navigateFallback: '/index.html',
        // Never serve the cached shell for API/WS paths — those stay network-only
        // (live inference/metrics; a cached/stale or HTML-for-JSON response would break them).
        navigateFallbackDenylist: [/^\/api/, /^\/v1/, /^\/ws/],
        cleanupOutdatedCaches: true,
        // No runtimeCaching: only the built app-shell is precached.
      },
      devOptions: { enabled: false },  // dev server (5173) stays plain — no SW
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router'],
          'vendor-vuetify': ['vuetify'],
          'views-dashboard': ['./src/views/Dashboard.vue'],
          'views-models': ['./src/views/Models.vue'],
          'views-chat': ['./src/views/Chat.vue'],
          'views-logs': ['./src/views/Logs.vue'],
          'views-bench': ['./src/views/Bench.vue'],
          'views-settings': ['./src/views/Settings.vue'],
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true
      }
    }
  }
});
