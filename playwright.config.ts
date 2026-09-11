import { defineConfig } from "@playwright/test";

// P2 e2e suite (QUALITY_PLAN.md): full user flow against a real `next dev`
// server. The JSON file store (lib/store.ts) has no write mutex, so the suite
// runs serially (workers: 1) to avoid concurrent whole-file write loss.
export default defineConfig({
  testDir: "./tests/e2e",
  // 30s per test.
  timeout: 30_000,
  // Retry once on CI only; fail fast locally for quicker iteration.
  retries: process.env.CI ? 1 : 0,
  // Serial: lib/store.ts read-modify-writes data/articles.json with no lock,
  // so parallel workers saving articles concurrently can lose data (P1 risk).
  workers: 1,
  use: {
    baseURL: "http://localhost:3100",
  },
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100",
    // Reuse a manually started `npx next dev -p 3100` for local iteration;
    // CI always boots a fresh server.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
    },
  ],
});
