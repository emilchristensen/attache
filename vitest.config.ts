import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Only catches hangs. Connector contract tests start a fake Claude Code process for every session, one after another
    // (a paginated sync is a dozen sessions), so when several suites share the machine a test that takes 8 s alone can pass 30 s.
    testTimeout: 120_000,
    pool: "forks",
  },
});
