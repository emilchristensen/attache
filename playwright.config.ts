import { defineConfig } from "@playwright/test";
import { chromeEnv } from "./tests/e2e/fonts.ts";

/**
 * Browser journeys run against the real bundled service, the built web client
 * and the TEST-ONLY fixture remotes (see tests/e2e/stack.ts). They use the
 * installed Google Chrome, which on Linux draws Georgia with the bundled
 * Gelasio (tests/e2e/fonts.ts).
 */
export default defineConfig({
  testDir: "tests/e2e",
  // One temporary folder for the whole run, removed when it ends (scripts/test-run-folder.mjs).
  globalSetup: "./scripts/test-run-folder.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  outputDir: "test-results/e2e",
  use: {
    channel: "chrome",
    headless: true,
    launchOptions: { env: chromeEnv() },
    viewport: { width: 1360, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
