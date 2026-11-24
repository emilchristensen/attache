import { describe, expect, it } from "vitest";
import { parseRunRef } from "../ci-failures/gh.mjs";
import { formatRun } from "../ci-failures/format.mjs";
import { summarizeJob } from "../ci-failures/summarize.mjs";

const ESC = "\u001b";
const red = (s) => `${ESC}[31m${s}${ESC}[39m`;

/** A job log as GitHub serves it: a byte order mark, a timestamp on every line, ANSI colours, and CRLF on Windows. */
function jobLog(lines, { crlf = false } = {}) {
  const start = Date.parse("2026-11-11T18:46:11Z");
  const body = lines.map((line, i) => `${new Date(start + i * 10).toISOString().replace("Z", "0000Z")} ${line}`);
  return `﻿${body.join(crlf ? "\r\n" : "\n")}\n`;
}

const step = (number, name, conclusion = "success") => ({ number, name, conclusion, status: "completed" });

/** The steps of a `checks` job, as `gh run view --json jobs` lists them. */
const checksSteps = (failed, skipped = []) =>
  [
    "Set up job",
    "Run actions/checkout@v4",
    "Install dependencies",
    "Lint",
    "Unit and integration tests",
    "Browser journeys",
    "Upload test results",
    "Post Run actions/checkout@v4",
    "Complete job",
  ].map((name, i) => step(i + 1, name, failed.includes(name) ? "failure" : skipped.includes(name) ? "skipped" : "success"));

/** The log those steps write: one `Run` group per step that ran, with the given output. */
function checksLog(output, opts) {
  return jobLog(
    [
      "Current runner version: '2.338.2'",
      "##[group]Run actions/checkout@v4",
      "##[endgroup]",
      "##[group]Run pnpm install --frozen-lockfile",
      "##[endgroup]",
      "Done in 4.5s using pnpm v11.1.2",
      "##[group]Run pnpm lint --max-warnings 0",
      "##[endgroup]",
      ...(output.lint ?? []),
      "##[group]Run pnpm test",
      `${ESC}[36;1mpnpm test${ESC}[0m`,
      "##[endgroup]",
      ...(output.test ?? []),
      "##[group]Run pnpm e2e",
      "##[endgroup]",
      ...(output.e2e ?? []),
      "##[group]Run actions/upload-artifact@v4",
      "##[endgroup]",
      "Post job cleanup.",
    ],
    opts,
  );
}

describe("summarizeJob", () => {
  it("names the failed step, each failing Vitest test and its first error line, from a Windows log", () => {
    const job = { name: "checks (windows-latest)", conclusion: "failure", status: "completed", steps: checksSteps(["Unit and integration tests"]) };
    const log = checksLog(
      {
        test: [
          ` ${ESC}[32m✓${ESC}[39m apps/service/test/platform-git.test.ts (2 tests) 4ms`,
          "",
          `${red("⎯⎯⎯⎯⎯⎯⎯")}${ESC}[1m${ESC}[41m Failed Tests 2 ${ESC}[49m${ESC}[22m${red("⎯⎯⎯⎯⎯⎯⎯")}`,
          `${ESC}[2m Test Files ${ESC}[22m ${red("1 failed")} | 83 passed (87)`,
          `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m apps/service/test/windows-service.test.ts${ESC}[2m > ${ESC}[22mthe logon task${ESC}[2m > ${ESC}[22mstops with its console host`,
          `${ESC}[2m   Start at ${ESC}[22m 18:47:28`,
          `${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: expected '' to contain 'stopping'${ESC}[39m`,
          "",
          `${ESC}[32m- Expected${ESC}[39m`,
          `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m apps/service/test/integration/fact-merge.test.ts${ESC}[2m > ${ESC}[22mFact merge rule${ESC}[2m > ${ESC}[22mlets the newer date win`,
          `${ESC}[31m${ESC}[1mError${ESC}[22m: Test timed out in 30000ms.${ESC}[39m`,
          "##[error]AssertionError: expected '' to contain 'stopping'",
          "[ELIFECYCLE] Test failed. See above for more details.",
          "##[error]Process completed with exit code 1.",
        ],
      },
      { crlf: true },
    );

    expect(summarizeJob({ job, log, annotations: [] })).toEqual({
      name: "checks (windows-latest)",
      conclusion: "failure",
      steps: [
        {
          name: "Unit and integration tests",
          failures: [
            { test: "apps/service/test/windows-service.test.ts > the logon task > stops with its console host", errors: ["AssertionError: expected '' to contain 'stopping'"] },
            { test: "apps/service/test/integration/fact-merge.test.ts > Fact merge rule > lets the newer date win", errors: ["Error: Test timed out in 30000ms."] },
          ],
          output: [],
        },
      ],
    });
  });

  it("reads a failing browser journey from Playwright's list reporter, in the step that ran it", () => {
    const job = { name: "checks (ubuntu-latest)", conclusion: "failure", status: "completed", steps: checksSteps(["Browser journeys"]) };
    const log = checksLog({
      test: [" FAIL  apps/service/test/not-this-step.test.ts > is in another step", "Error: not this one"],
      e2e: [
        "Running 22 tests using 1 worker",
        "  ✓   1 tests/e2e/journeys.spec.ts:51:1 › onboarding: pair, choose folder (3.1s)",
        "  ✘  19 tests/e2e/journeys.spec.ts:589:1 › replication: set up in Settings (3.3s)",
        "",
        "  1) tests/e2e/journeys.spec.ts:589:1 › replication: set up in Settings, joined from another Machine's setup ",
        "",
        "    Error: ENOENT: no such file or directory, open '/tmp/attache-e2e æøå-6RhlNX/Attache/memory/self.md'",
        "",
        "      611 |     await second.getByRole(\"button\", { name: \"Join into this folder\" }).click();",
        "    Error Context: test-results/e2e/journeys-replication/error-context.md",
        "",
        "  2) tests/e2e/visual.spec.ts:76:1 › screens ───────────────────────────────────────────────",
        "",
        "    Error: The save did not go through",
        "  2 failed",
        "    tests/e2e/journeys.spec.ts:589:1 › replication: set up in Settings, joined from another Machine's setup ",
        "  19 passed (1.3m)",
        "##[error]Process completed with exit code 1.",
      ],
    });

    expect(summarizeJob({ job, log, annotations: [] }).steps).toEqual([
      {
        name: "Browser journeys",
        failures: [
          { test: "tests/e2e/journeys.spec.ts:589:1 › replication: set up in Settings, joined from another Machine's setup", errors: ["Error: ENOENT: no such file or directory, open '/tmp/attache-e2e æøå-6RhlNX/Attache/memory/self.md'"] },
          { test: "tests/e2e/visual.spec.ts:76:1 › screens", errors: ["Error: The save did not go through"] },
        ],
        output: [],
      },
    ]);
  });

  it("reads the install test's failed checks, with what each one found", () => {
    const steps = ["Set up job", "Run actions/checkout@v4", "Install test", "Upload install results", "Complete job"].map((name, i) => step(i + 1, name, name === "Install test" ? "failure" : "success"));
    const job = { name: "install (windows-latest)", conclusion: "failure", status: "completed", steps };
    const log = jobLog([
      "##[group]Run actions/checkout@v4",
      "##[endgroup]",
      "##[group]Run node scripts/test-install.mjs --from 0.1.0 --to 0.1.1",
      "##[endgroup]",
      "PASS [A02] clean-profile install starts the service — version 0.1.0",
      "FAIL [A14] uninstall --delete-data leaves no Attache file in the home folder — AppData\\Local\\Attache\\locks\\c2fa.lock",
      "FAIL [A02] service starts at login",
      "35/36 installation checks passed",
      "##[error]Process completed with exit code 1.",
      "##[group]Run actions/upload-artifact@v4",
      "##[endgroup]",
    ]);

    expect(summarizeJob({ job, log, annotations: [] }).steps).toEqual([
      {
        name: "Install test",
        failures: [
          { test: "[A14] uninstall --delete-data leaves no Attache file in the home folder", errors: ["AppData\\Local\\Attache\\locks\\c2fa.lock"] },
          { test: "[A02] service starts at login", errors: [] },
        ],
        output: [],
      },
    ]);
  });

  it("reads lint and type errors per file", () => {
    const job = { name: "checks (macos-latest)", conclusion: "failure", status: "completed", steps: checksSteps(["Lint", "Unit and integration tests"]) };
    const log = checksLog({
      lint: [
        "/Users/runner/work/attache/attache/apps/service/src/app.ts",
        "  12:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars",
        "  40:1  warning  Unexpected console statement  no-console",
        "",
        "✖ 2 problems (1 error, 1 warning)",
        "##[error]Process completed with exit code 1.",
      ],
      test: ["apps/service typecheck: src/http/server.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", "##[error]Process completed with exit code 2."],
    });

    expect(summarizeJob({ job, log, annotations: [] }).steps.map((s) => s.failures)).toEqual([
      [{ test: "/Users/runner/work/attache/attache/apps/service/src/app.ts", errors: ["12:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars"] }],
      [{ test: "src/http/server.ts(3,7)", errors: ["error TS2322: Type 'string' is not assignable to type 'number'."] }],
    ]);
  });

  it("shows the step's last lines and GitHub's own error when no test is named", () => {
    const job = { name: "checks (ubuntu-latest)", conclusion: "failure", status: "completed", steps: checksSteps(["Install dependencies"], ["Lint", "Unit and integration tests"]) };
    const lines = [
      "##[group]Run actions/checkout@v4",
      "##[endgroup]",
      "##[group]Run pnpm install --frozen-lockfile",
      "##[endgroup]",
      ...Array.from({ length: 12 }, (_, i) => `Progress: resolved ${i}`),
      "",
      "Your Node version is incompatible with \"/home/runner/work/attache/attache\".",
      "Expected version: >=24.22.0",
      "Got: v24.21.0",
      "##[error]The operation was canceled.",
      "##[error]Process completed with exit code 1.",
      "##[group]Run actions/upload-artifact@v4",
      "##[endgroup]",
    ];

    expect(summarizeJob({ job, log: jobLog(lines), annotations: [] }).steps).toEqual([
      {
        name: "Install dependencies",
        failures: [],
        output: ["The operation was canceled.", "Progress: resolved 10", "Progress: resolved 11", "Your Node version is incompatible with \"/home/runner/work/attache/attache\".", "Expected version: >=24.22.0", "Got: v24.21.0"],
      },
    ]);
  });
  it("says a command was stopped by its time limit when the step ends with timeout's exit code 124", () => {
    const steps = ["Set up job", "Linux desktop session tests", "Complete job"].map((name, i) => step(i + 1, name, name === "Linux desktop session tests" ? "failure" : "success"));
    const job = { name: "checks (ubuntu-latest, current Node)", conclusion: "failure", status: "completed", steps };
    const log = jobLog([
      "##[group]Run sudo timeout 3m apt-get -o Acquire::Retries=3 update",
      "##[endgroup]",
      "Get:30 http://archive.ubuntu.com/ubuntu resolute/main amd64v3 libnotify-bin amd64 0.8.8-1 [10.8 kB]",
      "Get:18 http://archive.ubuntu.com/ubuntu resolute-updates/main amd64v3 libgtk-4-1 amd64 4.22.4+ds-0ubuntu0.2 [3555 kB]",
      "##[error]Process completed with exit code 124.",
    ]);

    expect(summarizeJob({ job, log, annotations: [] }).steps[0].output[0]).toBe("Process completed with exit code 124: a command hit its `timeout` limit.");
  });

  it("says why a job never started, from its annotations", () => {
    const job = { name: "checks (macos-latest)", conclusion: "failure", status: "completed", steps: [] };
    const annotations = [
      { annotation_level: "failure", message: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings" },
      { annotation_level: "notice", message: "The ubuntu-latest label will migrate to Ubuntu 26" },
    ];

    expect(summarizeJob({ job, log: "", annotations })).toEqual({
      name: "checks (macos-latest)",
      conclusion: "failure",
      notStarted: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
      steps: [],
    });
  });

  it("says a job was cancelled before it started when GitHub gives no reason", () => {
    const job = { name: "install (ubuntu-latest)", conclusion: "cancelled", status: "completed", steps: [] };

    expect(summarizeJob({ job, log: "", annotations: [] }).notStarted).toBe("cancelled before it started");
  });

  it("leads with the first error a crashed script printed, before its last lines", () => {
    const steps = ["Set up job", "Install test", "Complete job"].map((name, i) => step(i + 1, name, name === "Install test" ? "failure" : "success"));
    const job = { name: "install (windows-latest)", conclusion: "failure", status: "completed", steps };
    const log = jobLog([
      "##[group]Run node scripts/test-install.mjs",
      "##[endgroup]",
      "PASS [A02] clean-profile install starts the service",
      "Error: Command failed: cmd.exe /d /s /c install.cmd",
      "    at genericNodeError (node:internal/errors:983:15)",
      "    at checkExecSyncError (node:child_process:925:11)",
      "    at execFileSync (node:child_process:961:15)",
      "  status: 1,",
      "  stderr: 'Attache install failed: a program is still using it'",
      "}",
      "##[error]Process completed with exit code 1.",
    ]);

    expect(summarizeJob({ job, log, annotations: [] }).steps[0].output).toEqual([
      "Error: Command failed: cmd.exe /d /s /c install.cmd",
      "    at checkExecSyncError (node:child_process:925:11)",
      "    at execFileSync (node:child_process:961:15)",
      "  status: 1,",
      "  stderr: 'Attache install failed: a program is still using it'",
      "}",
    ]);
  });
});

describe("formatRun", () => {
  const run = { databaseId: 43070983456, displayTitle: "fix: the watcher", headBranch: "retro/ci-tooling", conclusion: "failure", url: "https://github.com/o/r/actions/runs/43070983456" };

  it("prints each failed job with its failed step, failing tests and first error lines, and caps a long list", () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({ test: `a.test.ts > case ${i + 1}`, errors: i === 0 ? ["AssertionError: expected 1 to be 2"] : [] }));
    const text = formatRun(run, [
      { name: "checks (windows-latest)", conclusion: "failure", steps: [{ name: "Unit and integration tests", failures, output: [] }] },
      { name: "install (ubuntu-latest)", conclusion: "failure", steps: [{ name: "Install dependencies", failures: [], output: ["Got: v24.21.0"] }] },
      { name: "checks (macos-latest)", conclusion: "failure", notStarted: "The job was not started because recent account payments have failed.", steps: [] },
      { name: "install (windows-latest)", conclusion: "cancelled", notStarted: "cancelled before it started", steps: [] },
      { name: "checks (ubuntu-latest)", conclusion: "failure", notStarted: "The job was not started because recent account payments have failed.", steps: [] },
    ]);

    expect(text).toBe(
      [
        "Run 43070983456 failure: fix: the watcher (retro/ci-tooling)",
        "https://github.com/o/r/actions/runs/43070983456",
        "",
        "checks (windows-latest): Unit and integration tests failed",
        "  a.test.ts > case 1",
        "    AssertionError: expected 1 to be 2",
        ...Array.from({ length: 7 }, (_, i) => `  a.test.ts > case ${i + 2}`),
        "  … and 2 more",
        "",
        "install (ubuntu-latest): Install dependencies failed",
        "    Got: v24.21.0",
        "",
        "Not started: checks (macos-latest), checks (ubuntu-latest). The job was not started because recent account payments have failed.",
        "Not started: install (windows-latest). cancelled before it started",
        "",
      ].join("\n"),
    );
  });

  it("says so when no job failed", () => {
    expect(formatRun({ ...run, conclusion: "success" }, [])).toBe(["Run 43070983456 success: fix: the watcher (retro/ci-tooling)", "https://github.com/o/r/actions/runs/43070983456", "", "No job failed.", ""].join("\n"));
  });
});

describe("parseRunRef", () => {
  it("takes a run id, or a run or job URL with its repository", () => {
    expect(parseRunRef("43070983456")).toEqual({ runId: "43070983456", repo: null });
    expect(parseRunRef("https://github.com/emilchristensen/attache/actions/runs/43070983456")).toEqual({ runId: "43070983456", repo: "emilchristensen/attache" });
    expect(parseRunRef("https://github.com/o/r/actions/runs/1/job/2?pr=3")).toEqual({ runId: "1", repo: "o/r" });
  });

  it("refuses anything else", () => {
    expect(() => parseRunRef("main")).toThrow(/run id or a run URL/);
    expect(() => parseRunRef(undefined)).toThrow(/run id or a run URL/);
  });
});
