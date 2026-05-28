import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { version } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
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
