/**
 * The real installer runner (`updates/installer-runner.ts`): unpack the staged
 * archive next to it and start the release's own installer in unattended mode,
 * in a process that outlives this service.
 *
 * The installer stops this service as its first change, so it must not belong
 * to anything that stopping the service ends:
 * - Linux: systemd stops a unit by ending every process in its control group, children started with a new session
 *   included. The installer runs as a transient unit of its own (`systemd-run --user`), which has its own group.
 * - macOS: launchd ends the job's process group. The installer leads a new session, so it is in a group of its own.
 * - Windows: ending the logon task ends its console host only, never the processes below it (`service-manager/
 *   task-scheduler.ts`), so a detached process is enough.
 * Unattended mode (`ATTACHE_UNATTENDED=1`) never pairs or opens a browser, and writes the outcome record.
 * The installer's output goes to `<state>/logs/update-<version>.log`.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../core/log.ts";
import type { InstallerRunner, InstallRequest } from "../updates/installer-runner.ts";
import { currentOs, type Os } from "./os.ts";
import { powershellPath, runPowerShell } from "./powershell.ts";
import { run } from "./run.ts";
import { userManagerEnv } from "./service-manager/systemd.ts";

/** How long unpacking a release archive may take. */
const UNPACK_TIMEOUT_MS = 5 * 60_000;

const UNZIP_SCRIPT = String.raw`
function Invoke-Request($req) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($req.archive, $req.folder)
  return @{ ok = $true }
}
`;

/** Unpack the archive into the release folder, as the one-step installers do: `tar` on macOS and Linux, .NET's zip support on Windows. */
async function unpack(os: Os, request: InstallRequest): Promise<void> {
  if (os === "windows") {
    const r = await runPowerShell(UNZIP_SCRIPT, { archive: request.archive, folder: request.release }, { timeoutMs: UNPACK_TIMEOUT_MS });
    if (!r.ok) throw new Error(`could not unpack ${request.archive}: ${r.why}`);
    return;
  }
  const r = await run("/usr/bin/tar", ["-xzf", request.archive, "-C", request.release], { timeoutMs: UNPACK_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`could not unpack ${request.archive}: ${r.stderr.trim() || `tar exited with ${r.code}`}`);
}

/** The environment the installer runs in: the service's own, plus what makes it an unattended Update of this install. */
function installerEnv(request: InstallRequest): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ATTACHE_UNATTENDED: "1",
    ATTACHE_NO_OPEN: "1",
    ATTACHE_PREFIX: request.prefix,
    ATTACHE_STATE_DIR: request.stateDir,
    ATTACHE_PORT: String(request.port),
    ATTACHE_RELEASE_DIR: request.release,
  };
}

/** A value as one single-quoted POSIX shell word. */
const shellWord = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A script that sets the installer's environment and runs it with its output in `log`: systemd starts a transient unit
 * with the user manager's environment, not this process's, so the environment travels in the script.
 */
function launcherScript(installer: string, log: string, env: NodeJS.ProcessEnv): string {
  const exports = Object.entries(env)
    .filter((e): e is [string, string] => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) && typeof e[1] === "string" && !/[\0]/.test(e[1]))
    .map(([k, v]) => `export ${k}=${shellWord(v)}`);
  return ["#!/bin/sh", ...exports, `exec /bin/sh ${shellWord(installer)} >>${shellWord(log)} 2>&1`, ""].join("\n");
}

/** Whether this process runs as a systemd unit, whose stop would end a child too. */
const underSystemd = () => !!process.env.INVOCATION_ID;

/** Start `command` detached: a new session on macOS and Linux, no console window on Windows. Resolves once it runs. */
function startDetached(command: string, args: string[], env: NodeJS.ProcessEnv, log: string): Promise<void> {
  const out = openSync(log, "a");
  try {
    const child = spawn(command, args, { env, detached: true, stdio: ["ignore", out, out], windowsHide: true });
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    closeSync(out);
  }
}

async function startInstaller(os: Os, request: InstallRequest, log: string): Promise<void> {
  const folder = join(request.release, `attache-${request.version}`);
  const env = installerEnv(request);
  if (os === "windows") {
    const script = join(folder, "install.ps1");
    if (!existsSync(script)) throw new Error(`${script} is missing from the release`);
    return startDetached(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], env, log);
  }
  const script = join(folder, "install.sh");
  if (!existsSync(script)) throw new Error(`${script} is missing from the release`);
  if (os === "linux" && underSystemd()) {
    const launcher = join(request.release, "run-installer.sh");
    writeFileSync(launcher, launcherScript(script, log, env), { mode: 0o700 });
    const unit = `attache-update-${request.version.replace(/[^A-Za-z0-9]/g, "-")}-${Date.now()}`;
    const r = await run("systemd-run", ["--user", "--collect", "--quiet", `--unit=${unit}`, "/bin/sh", launcher], { env: userManagerEnv(), timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`systemd-run could not start the installer: ${r.stderr.trim() || `exit ${r.code}`}`);
    return;
  }
  return startDetached("/bin/sh", [script], env, log);
}

export function platformInstallerRunner(log: Logger, os: Os = currentOs()): InstallerRunner {
  return {
    async start(request) {
      await unpack(os, request);
      const logs = join(request.stateDir, "logs");
      mkdirSync(logs, { recursive: true });
      const logFile = join(logs, `update-${request.version}.log`);
      await startInstaller(os, request, logFile);
      log.info("started the installer of an Update", { version: request.version, log: logFile });
    },
  };
}
