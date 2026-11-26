import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const CHILD_PROCESS_MESSAGE =
  "Start tools through apps/service/src/platform: run() (platform/run.ts) to run one and read its output, spawnTool() (platform/launch.ts) to stream its output, launchTool() for the command and arguments.";
const RENAME_MESSAGE = "Replace files with replaceWith() from apps/service/src/platform/replace-file.ts, which waits for Windows to let go of a file another program holds open.";

const OLD_SCHEMA_MESSAGE =
  "Build an old install's database with databaseBefore() (apps/service/test/fixtures/old-database.ts). Migrations run a statement at a time wait for a disk flush per statement, which takes seconds on a busy Windows runner (#53).";

const WAIT_FOR_TIMEOUT_MESSAGE =
  "Wait for what the journey needs, not for a fixed time: a web-first assertion (expect(locator).toBeVisible(), toHaveText(), toHaveCount()), expect.poll(), page.waitForResponse() or dashboardAnswer(), page.waitForFunction(), settled() or nextFrames() from tests/e2e/browser.ts before a capture or a measurement, or the browser clock (page.clock) when the app waits for time to pass.";

/** Service code starts no process itself; a type import (e.g. ChildProcess) starts nothing. */
const processModules = () => ["node:child_process", "child_process"].map((name) => ({ name, message: CHILD_PROCESS_MESSAGE, allowTypeImports: true }));

/** Service code renames no file itself. */
const fileRenames = () => [
  ...["node:fs", "fs"].map((name) => ({ name, importNames: ["renameSync", "rename"], message: RENAME_MESSAGE })),
  ...["node:fs/promises", "fs/promises"].map((name) => ({ name, importNames: ["rename"], message: RENAME_MESSAGE })),
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "release/**", "test-results/**", ".cache/**", "research/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  {
    // platform/ is the one place that starts processes and replaces files, so Windows behaves:
    // npm .cmd shims, .mjs scripts, hidden console windows, files a virus scanner holds open.
    files: ["apps/service/src/**/*.ts"],
    ignores: ["apps/service/src/platform/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [...processModules(), ...fileRenames()] }],
      "no-restricted-syntax": ["error", { selector: "ImportExpression[source.value=/^(node:)?child_process$/]", message: CHILD_PROCESS_MESSAGE }],
    },
  },
  {
    files: ["**/test/**", "tests/**", "scripts/**", "**/*.mjs"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-console": "off" },
  },
  {
    // Tests run migrations through the service's own code, which gives each one a single transaction in WAL mode.
    files: ["**/test/**"],
    rules: { "no-restricted-syntax": ["error", { selector: "MemberExpression[object.name='MIGRATIONS'][property.name=/^(slice|forEach|map|entries|values)$/], ForOfStatement[right.name='MIGRATIONS']", message: OLD_SCHEMA_MESSAGE }] },
  },
  {
    // A fixed sleep is too short on a slow runner and wasted time on a fast one.
    files: ["tests/e2e/**"],
    rules: { "no-restricted-syntax": ["error", { selector: "CallExpression[callee.property.name='waitForTimeout']", message: WAIT_FOR_TIMEOUT_MESSAGE }] },
  },
);
