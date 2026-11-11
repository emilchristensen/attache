import { win32 } from "node:path";
import type { Env } from "./locations.ts";
import { run, type RunResult } from "./run.ts";

/** Windows PowerShell, which every Windows 10 and 11 has. `JARVIS_POWERSHELL_BIN` puts a stand-in in its place. */
export function powershellPath(env: Env = process.env): string {
  return env.JARVIS_POWERSHELL_BIN || win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Run a PowerShell script. The script goes in as `-EncodedCommand`, so no
 * quoting rule of the command line can touch it, and takes its inputs from
 * `vars` (environment variables), so values never become code. A failure is
 * reported as one plain line on stderr and exit code 1, not as PowerShell's
 * serialized error records.
 */
export function runPowerShell(script: string, vars: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  const guarded = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry {\n${script}\n} catch {\n[Console]::Error.WriteLine($_.Exception.Message)\nexit 1\n}\n`;
  const encoded = Buffer.from(guarded, "utf16le").toString("base64");
  return run(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: { ...process.env, ...vars }, timeoutMs: opts.timeoutMs ?? 60_000 });
}
