/**
 * The failing tests in what one step wrote, and their first error lines.
 */

const MAX_LINE = 300;
// How far after a failing test's name its error is looked for.
const ERROR_WINDOW = 40;
const ERROR_LINE = /^\s*((?:[A-Z][\w.]*)?Error(?: \[[^\]]*\])?: .+)$/;

const shorten = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line);

/** The first error line after `from`, before the next failing test. */
function firstError(lines, from, isNextFailure) {
  for (let i = from + 1; i < Math.min(lines.length, from + ERROR_WINDOW); i++) {
    if (isNextFailure(lines[i])) break;
    if (lines[i].startsWith("##[")) continue;
    const m = ERROR_LINE.exec(lines[i]);
    if (m) return [shorten(m[1].trim())];
  }
  return [];
}

// Vitest's summary: ` FAIL  apps/x.test.ts > suite > test`.
const VITEST_FAIL = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?\b.*)$/;

function vitestFailures(lines) {
  return lines.flatMap((line, i) => {
    const m = VITEST_FAIL.exec(line);
    return m ? [{ test: m[1].trim(), errors: firstError(lines, i, (l) => VITEST_FAIL.test(l)) }] : [];
  });
}

// Playwright's list reporter: `  1) tests/e2e/x.spec.ts:12:1 › title`, padded with a rule when the title is short.
const PLAYWRIGHT_FAIL = /^\s*\d+\) (\S+:\d+:\d+ › .+?)[\s─]*$/;

function playwrightFailures(lines) {
  return lines.flatMap((line, i) => {
    const m = PLAYWRIGHT_FAIL.exec(line);
    return m ? [{ test: shorten(m[1]), errors: firstError(lines, i, (l) => PLAYWRIGHT_FAIL.test(l)) }] : [];
  });
}

// The install test (scripts/test-install.mjs): `FAIL [A02] check — what it found`.
const INSTALL_FAIL = /^FAIL (\[\w+\] .+?)(?: — (.+))?$/;

function installFailures(lines) {
  return lines.flatMap((line) => {
    const m = INSTALL_FAIL.exec(line);
    return m ? [{ test: shorten(m[1]), errors: m[2] ? [shorten(m[2])] : [] }] : [];
  });
}

// ESLint's stylish format: the file's absolute path, then `  12:7  error  message  rule` lines.
const ESLINT_FILE = /^(?:[A-Za-z]:\\|\/)\S.*\.[cm]?[jt]sx?$/;
const ESLINT_ERROR = /^\s+(\d+:\d+\s+error\s+.+)$/;
const ERRORS_PER_FILE = 3;

function eslintFailures(lines) {
  const byFile = new Map();
  let file = null;
  for (const line of lines) {
    if (ESLINT_FILE.test(line)) file = line;
    else if (line.trim() === "") file = null;
    const m = file && ESLINT_ERROR.exec(line);
    if (m) byFile.set(file, [...(byFile.get(file) ?? []), shorten(m[1])]);
  }
  return [...byFile].map(([test, errors]) => ({ test, errors: errors.slice(0, ERRORS_PER_FILE) }));
}

// The TypeScript compiler, behind pnpm's prefix: `apps/service typecheck: src/x.ts(3,7): error TS2322: ...`.
const TSC_ERROR = /(\S+\(\d+,\d+\)): (error TS\d+: .+)$/;

function typescriptFailures(lines) {
  return lines.flatMap((line) => {
    const m = TSC_ERROR.exec(line);
    return m ? [{ test: m[1], errors: [shorten(m[2])] }] : [];
  });
}

/** Unique by test name, first one wins: a reporter may name a failure twice. */
function unique(failures) {
  const seen = new Set();
  return failures.filter((f) => !seen.has(f.test) && seen.add(f.test));
}

/** The failing tests a step's output names. */
export function findFailures(lines) {
  return unique([...vitestFailures(lines), ...playwrightFailures(lines), ...installFailures(lines), ...eslintFailures(lines), ...typescriptFailures(lines)]);
}

const TAIL = 5;
const GITHUB_ERROR = "##[error]";

/**
 * What to show for a step that names no failing test: GitHub's own errors (a timeout, a cancel,
 * an action that failed), then the last lines the step printed.
 */
export function lastWords(lines) {
  const errors = lines.filter((l) => l.startsWith(GITHUB_ERROR)).map((l) => l.slice(GITHUB_ERROR.length).trim());
  const printed = lines.filter((l) => l.trim() !== "" && !l.startsWith("##["));
  const tail = printed.slice(-TAIL);
  // A script that crashed prints its error above a stack and details that can push it out of the tail.
  const firstError = printed.find((l) => ERROR_LINE.test(l));
  const lead = firstError && !tail.includes(firstError) ? [firstError] : [];
  return [...errors.flatMap(exitWords), ...lead, ...tail].map(shorten);
}

/** GitHub's "Process completed with exit code N." says nothing the step's output does not, except 124: `timeout` stopped a command. */
function exitWords(error) {
  const code = /^Process completed with exit code (\d+)\.$/.exec(error)?.[1];
  if (code === undefined) return [error];
  return code === "124" ? ["Process completed with exit code 124: a command hit its `timeout` limit."] : [];
}
