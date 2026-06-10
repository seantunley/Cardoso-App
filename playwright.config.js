// E2E smoke tests for the operator money paths. Runs the REAL stack:
// the express API on :3101 against a scratch SQLite DB (deleted before each
// run by e2e/global-setup.js, then recreated by the app's own migrations +
// bootstrap-admin seeding), and the vite dev server on :5173 proxying /api.
// Non-production mode seeds the deterministic bootstrap admin
// (admin@example.com / admin123, must_change_password=1) — the login smoke
// exercises that whole path end-to-end, no fixture infra needed.
//
// Run locally: npx playwright install chromium (once), then npm run test:e2e.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The password-change smoke mutates the seeded admin — keep runs serial so
  // tests never race each other's auth state.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Scratch DB + HUB_MODE off + non-production (deterministic admin123).
      command: 'cross-env PORT=3101 DB_PATH=./database/e2e-cardoso.db HUB_MODE=false node e2e/start-server.mjs',
      // /api/auth/me answers 401 unauthenticated — Playwright treats any
      // 2xx-4xx as "server ready".
      url: 'http://localhost:3101/api/auth/me',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
