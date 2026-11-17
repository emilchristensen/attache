import type { Os } from "../platform/os.ts";
import { shellPath } from "../platform/shell-command.ts";

/**
 * How a Harness runs Attache's search from its shell. `line` is the same in a
 * POSIX shell, in Git Bash (Claude Code on Windows) and in cmd.exe. PowerShell
 * (Codex on Windows) reads a quoted program path as a string, not a command,
 * so it gets the same line after the call operator `&`; null where no Harness
 * runs PowerShell or the program is not quoted.
 */
export interface SearchCommand {
  line: string;
  powershell: string | null;
}

/** The search command pinned to this install's state folder, through the bundled runtime when Attache runs from its bundle. */
export function searchCommand(opts: { os: Os; execPath: string; entry: string; stateDir: string }): SearchCommand {
  const q = (s: string) => shellPath(s, opts.os);
  if (!/attache-service\.mjs$/.test(opts.entry)) return { line: `attache search --state-dir ${q(opts.stateDir)}`, powershell: null };
  const line = `${q(opts.execPath)} ${q(opts.entry)} search --state-dir ${q(opts.stateDir)}`;
  return { line, powershell: opts.os === "windows" ? `& ${line}` : null };
}
