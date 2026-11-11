import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const CHILD_PROCESS_MESSAGE =
  "Start tools through apps/service/src/platform: run() (platform/run.ts) to run one and read its output, spawnTool() (platform/launch.ts) to stream its output, launchTool() for the command and arguments.";
const RENAME_MESSAGE = "Replace files with replaceWith() from apps/service/src/platform/replace-file.ts, which waits for Windows to let go of a file another program holds open.";

/** Service code starts no process itself; a type import (e.g. ChildProcess) starts nothing. */
const processModules = () => ["node:child_process", "child_process"].map((name) => ({ name, message: CHILD_PROCESS_MESSAGE, allowTypeImports: true }));

/** Service code renames no file itself. */
const fileRenames = () => [
  ...["node:fs", "fs"].map((name) => ({ name, importNames: ["renameSync", "rename"], message: RENAME_MESSAGE })),
  ...["node:fs/promises", "fs/promises"].map((name) => ({ name, importNames: ["rename"], message: RENAME_MESSAGE })),
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "release/**", "test-results/**", ".cache/**", ".lavish/**", "research/**"] },
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
);
