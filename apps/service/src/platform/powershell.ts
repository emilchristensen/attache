import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { Env } from "./locations.ts";
import { launchTool } from "./launch.ts";
import { run } from "./run.ts";

/**
 * Windows PowerShell 5.1, which every Windows 10 and 11 installation has, so
 * Jarvis reaches Windows APIs (Credential Manager, notifications) without a
 * native module. `JARVIS_POWERSHELL_BIN` puts a stand-in in its place.
 */
export function powershellPath(env: Env = process.env): string {
  return env.JARVIS_POWERSHELL_BIN || win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** A request to a PowerShell script: plain JSON values only. */
export type PowerShellRequest = Readonly<Record<string, string | number | boolean | null>>;

/** What a script answered: `ok` and its own fields, or why it gave no answer. */
export type PowerShellReply = { ok: true; reply: Readonly<Record<string, unknown>> } | { ok: false; why: string };

/**
 * Runs before every script: reads the request as JSON from stdin, calls the
 * script's `Invoke-Request`, and writes its answer as one line of JSON to
 * stdout. Both directions are ASCII only (anything else as `\uXXXX`), so no
 * console code page can garble them. A failure becomes `{ ok: false, error }`.
 */
const RUNNER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Send-Reply($reply) {
  $json = ConvertTo-Json -InputObject $reply -Compress -Depth 4
  [Console]::Out.Write([regex]::Replace($json, '[^\x00-\x7f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
}
try {
  Send-Reply (Invoke-Request ([Console]::In.ReadToEnd() | ConvertFrom-Json))
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  Send-Reply @{ ok = $false; error = $e.Message }
}
`;

/** JSON with every character outside ASCII escaped, which ConvertFrom-Json reads back unchanged. */
export const asciiJson = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * The script travels as `-EncodedCommand` (UTF-16LE, base64), which needs no
 * script file and so no execution policy allowing one. Requests, and with them
 * any secret, travel on stdin, never in the process arguments.
 */
function powershellArgs(script: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`${script}\n${RUNNER}`, "utf16le").toString("base64")];
}

function interpret(out: { stdout: string; stderr: string; code: number | null; timedOutAfterMs?: number; error?: string }): PowerShellReply {
  if (out.timedOutAfterMs !== undefined) return { ok: false, why: `Windows PowerShell did not answer within ${out.timedOutAfterMs / 1000} seconds` };
  if (out.error) return { ok: false, why: out.error };
  let reply: unknown;
  try {
    reply = JSON.parse(out.stdout.trim());
  } catch {
    const said = out.stderr.trim().split(/\r?\n/)[0];
    return { ok: false, why: said || `Windows PowerShell exited with ${out.code} without an answer` };
  }
  if (!reply || typeof reply !== "object") return { ok: false, why: "Windows PowerShell gave an answer Jarvis does not understand" };
  const r = reply as Record<string, unknown>;
  if (r.ok === true) return { ok: true, reply: r };
  // Some failures (a compiler error, for one) run over several lines; the first says what happened.
  const said = typeof r.error === "string" ? r.error.trim().split(/\r?\n/)[0] : "";
  return { ok: false, why: said || "Windows PowerShell reported a failure without a reason" };
}

function missing(path: string): PowerShellReply | null {
  return existsSync(path) ? null : { ok: false, why: `Windows PowerShell is missing (${path})` };
}

export interface PowerShellOptions {
  env?: Env;
  timeoutMs: number;
}

/** Run `script` (which defines `Invoke-Request($req)`) with one request. Never rejects. */
export async function runPowerShell(script: string, request: PowerShellRequest, opts: PowerShellOptions): Promise<PowerShellReply> {
  const exe = powershellPath(opts.env);
  const absent = missing(exe);
  if (absent) return absent;
  const r = await run(exe, powershellArgs(script), { input: asciiJson(request), timeoutMs: opts.timeoutMs });
  return interpret({ ...r, ...(r.timedOut ? { timedOutAfterMs: opts.timeoutMs } : {}) });
}

/** As `runPowerShell`, synchronously, for choices made once as the service starts. */
export function runPowerShellSync(script: string, request: PowerShellRequest, opts: PowerShellOptions): PowerShellReply {
  const exe = powershellPath(opts.env);
  const absent = missing(exe);
  if (absent) return absent;
  let launch;
  try {
    launch = launchTool(exe, powershellArgs(script));
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  const r = spawnSync(launch.command, launch.args, { encoding: "utf8", input: asciiJson(request), timeout: opts.timeoutMs, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return interpret({
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
    ...(code === "ETIMEDOUT" ? { timedOutAfterMs: opts.timeoutMs } : r.error ? { error: r.error.message } : {}),
  });
}
