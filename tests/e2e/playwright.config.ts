import { defineConfig } from "@playwright/test";

const work = process.env.IT_WORK ?? "test-results";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Eén omgeving, één database: de specs bouwen op elkaar voort (op bestandsnaam).
  workers: 1,
  fullyParallel: false,
  timeout: 3 * 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: `${work}/report`, open: "never" }]],
  outputDir: `${work}/results`,
  use: {
    // localhost, niet 127.0.0.1: next dev blokkeert dev-resources (HMR) vanaf andere origins.
    baseURL: (process.env.IT_PANEL_URL ?? "http://127.0.0.1:3000").replace("127.0.0.1", "localhost"),
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    acceptDownloads: true,
  },
});
