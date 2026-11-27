import { defineConfig } from "@playwright/test";

// Visuele controles tegen de mock (geen daemon of database nodig): `pnpm e2e:mock`.
const port = Number(process.env.MOCK_PORT ?? 3931);
export default defineConfig({
  testDir: ".",
  testMatch: "*.mock.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.MOCK_OUT ?? "test-results-mock",
  webServer: {
    command: `node apps/web/copy-monaco.mjs && pnpm --filter @panel/web exec next dev -p ${port}`,
    cwd: "../..",
    url: `http://localhost:${port}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PANEL_MOCK: "1", NEXT_PUBLIC_PANEL_MOCK: "1", MOCK_ROLE: "admin" },
  },
  use: { baseURL: `http://localhost:${port}`, browserName: "chromium", headless: true, locale: "en-US" },
});
