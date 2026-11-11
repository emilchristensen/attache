import { currentOs, type Os } from "./os.ts";

/** Characters a Windows command line cannot carry inside double quotes for both Git Bash and cmd.exe. */
const WINDOWS_UNQUOTABLE = /["%$`\r\n]/;

/**
 * Quote a path for a command line that a Harness runs through its shell.
 *
 * macOS and Linux Harnesses use a POSIX shell, so the path goes in single
 * quotes. On Windows, Claude Code runs hooks through Git Bash (cmd.exe when Git
 * is missing) and Codex through cmd.exe, so the path must mean the same in
 * both: double quotes, forward slashes (Git Bash would eat backslashes, and
 * Windows accepts either), and none of the characters either shell expands.
 */
export function shellPath(path: string, os: Os = currentOs()): string {
  if (os !== "windows") return `'${path.replace(/'/g, `'\\''`)}'`;
  if (WINDOWS_UNQUOTABLE.test(path)) throw new Error(`Jarvis cannot put ${path} in a command line on Windows, because it contains ", %, $, \` or a line break. Move Jarvis or its state folder to a path without them.`);
  return `"${path.replace(/\\/g, "/")}"`;
}
