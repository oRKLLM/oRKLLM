import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';

// Load .env for local development (GitHub Actions passes secrets directly as env vars)
config();

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Always start a fresh server on a dedicated test port so globalSetup's
  // deletion of test_auth.db takes effect (no stale in-memory credentials).
  webServer: {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:18000',
    reuseExistingServer: false,
    timeout: 15000,
    env: {
      ORKLLM_DB_PATH: './test_auth.db',
      ORKLLM_PORT: '18000',
      ORKLLM_HOST: '127.0.0.1',
      ORKLLM_MOCK: '1',
    }
  },
});
