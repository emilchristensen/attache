import { readFileSync } from "node:fs";
import { currentOs, type Os } from "./os.ts";
import { pathFor } from "./locations.ts";

/** A program and its arguments, ready for `spawn` without a shell. */
export interface Launch {
  command: string;
  args: string[];
}

/** Thrown when a tool on disk cannot be started safely; its message says what to do instead. */
export class UnlaunchableToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnlaunchableToolError";
  }
}

/**
 * The target of an npm command shim (`claude.cmd`), relative to the shim's
 * folder. npm writes `"%dp0%\node_modules\<package>\<entry>" %*` as the last
 * command line of every shim it creates.
 */
const NPM_SHIM_TARGET = /"%~?dp0%?\\([^"%]+)"\s*%\*/i;
const SCRIPT = /\.(?:c|m)?js$/i;

/**
 * How to start a command-line tool found on disk, without a shell.
 *
 * On Windows, npm installs tools as `.cmd` batch files, which Node starts only
 * through cmd.exe. cmd.exe cannot pass arguments with line breaks and expands
 * `%` inside them, so a shim is resolved to the script it wraps and that
 * script runs with this Node instead.
 */
export function launchTool(path: string, args: string[], os: Os = currentOs()): Launch {
  if (os !== "windows" || !/\.(?:cmd|bat)$/i.test(path)) return { command: path, args };
  const { dirname, join } = pathFor("windows");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new UnlaunchableToolError(`Jarvis could not read ${path}: ${(e as Error).message}`);
  }
  const target = NPM_SHIM_TARGET.exec(text)?.[1];
  if (!target) throw new UnlaunchableToolError(`${path} is a batch file that was not written by npm, so Jarvis cannot start it safely. Install the tool's native Windows version instead.`);
  const resolved = join(dirname(path), target);
  return SCRIPT.test(resolved) ? { command: process.execPath, args: [resolved, ...args] } : { command: resolved, args };
}
