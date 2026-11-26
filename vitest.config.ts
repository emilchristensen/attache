import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // expect.poll waits for state the service settles in the background, such as the session context
    // it rewrites 300 ms after a save. Under a full run that takes 550 to 750 ms, too close to the
    // default 1 s. A poll still returns as soon as it matches, and the test's own timeout still applies.
    expect: { poll: { timeout: 10_000 } },
    pool: "forks",
    // One temporary folder for the whole run, removed when it ends (scripts/test-run-folder.mjs).
    globalSetup: ["scripts/test-run-folder.mjs"],
    setupFiles: ["apps/service/test/setup-env.ts"],
  },
});
