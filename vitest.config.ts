import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Teardown stops real services (several per test in the Replication tests), which is slow on Windows CI.
    hookTimeout: 30_000,
    pool: "forks",
    // One temporary folder for the whole run, removed when it ends (scripts/test-run-folder.mjs).
    globalSetup: ["scripts/test-run-folder.mjs"],
    setupFiles: ["apps/service/test/setup-env.ts"],
  },
});
