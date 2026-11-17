import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
 * A Node script runs with this Node, so it needs no executable bit or `#!`
 * line, which Windows ignores. On Windows, npm installs tools as `.cmd` batch
 * files, which Node starts only through cmd.exe; cmd.exe cannot pass
 * arguments with line breaks and expands `%` inside them, so a shim is
 * resolved to the script it wraps and that script runs with this Node instead.
 */
export function launchTool(path: string, args: string[], os: Os = currentOs()): Launch {
  if (SCRIPT.test(path)) return { command: process.execPath, args: [path, ...args] };
  if (os !== "windows" || !/\.(?:cmd|bat)$/i.test(path)) return { command: path, args };
  const { dirname, join } = pathFor("windows");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new UnlaunchableToolError(`Attache could not read ${path}: ${(e as Error).message}`);
  }
  const target = NPM_SHIM_TARGET.exec(text)?.[1];
  if (!target) throw new UnlaunchableToolError(`${path} is a batch file that was not written by npm, so Attache cannot start it safely. Install the tool's native Windows version instead.`);
  const resolved = join(dirname(path), target);
  return SCRIPT.test(resolved) ? { command: process.execPath, args: [resolved, ...args] } : { command: resolved, args };
}

/**
 * Start a tool found on disk (see `launchTool`) with its streams piped. On
 * Windows it gets no console window: the service runs in the background, so a
 * console program it starts would otherwise flash one on the owner's screen.
 * Throws `UnlaunchableToolError` when the tool cannot be started safely.
 */
export function spawnTool(path: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const launch = launchTool(path, args);
  return spawn(launch.command, launch.args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}
