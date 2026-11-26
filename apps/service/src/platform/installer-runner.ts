/**
 * The real installer runner (`updates/installer-runner.ts`): unpack the staged
 * archive next to it and start the release's own installer in unattended mode,
 * in a process that outlives this service.
 *
 * The installer stops this service as its first change, so it must not belong
 * to anything that stopping the service ends:
 * - Linux: systemd stops a unit by ending every process in its control group, children started with a new session
 *   included. The installer runs as a transient unit of its own (`systemd-run --user`), which has its own group.
 * - macOS: a process the service starts stays part of the service's launchd job, a new session or not: from there,
 *   the installer's own `launchctl bootstrap` of the new version left a service launchd no longer tracked (it
 *   survived `attache stop` and uninstall). The installer runs as a launchd job of its own, which removes itself.
 * - Windows: ending the logon task ends its console host only, never the processes below it (`service-manager/
 *   task-scheduler.ts`), so a process of the service's own is enough.
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
import { escapeXml } from "./xml.ts";

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
 * A script that runs the installer in this process's environment, with its output in `log`: systemd and launchd start
 * a job with their own environment (the user manager's XDG folders, for one), so the environment travels in the script.
 */
function launcherScript(installer: string, log: string, env: NodeJS.ProcessEnv, after?: string): string {
  // Exactly this environment, none of the job's own: `env -i` starts from nothing.
  const vars = Object.entries(env)
    .filter((e): e is [string, string] => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]) && typeof e[1] === "string" && !e[1].includes("\0"))
    .map(([k, v]) => `  ${shellWord(`${k}=${v}`)} \\`);
  const run = ["/usr/bin/env -i \\", ...vars, `  /bin/sh ${shellWord(installer)} >>${shellWord(log)} 2>&1`].join("\n");
  // `after` runs once the installer is done, whatever its outcome: on macOS it removes the installer's own job.
  return ["#!/bin/sh", after ? `${run}\n${after}` : `exec ${run}`, ""].join("\n");
}

/** The launchd job that runs the installer: started by `kickstart` only, never kept alive, its output in `log`. */
function installerJobPlist(label: string, launcher: string, log: string): string {
  const x = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${x(launcher)}</string></array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

/** Start the installer as a launchd job of its own in the owner's session; the job removes itself when the installer is done. */
async function startLaunchdJob(request: InstallRequest, installer: string, log: string, env: NodeJS.ProcessEnv): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const label = `dev.attache.update.${(env.ATTACHE_INSTANCE ?? "default").replace(/[^A-Za-z0-9.-]/g, "-")}`;
  const launcher = join(request.release, "run-installer.sh");
  writeFileSync(launcher, launcherScript(installer, log, env, `/bin/launchctl bootout ${shellWord(`${domain}/${label}`)}`), { mode: 0o700 });
  const plist = join(request.release, `${label}.plist`);
  writeFileSync(plist, installerJobPlist(label, launcher, log));
  // An earlier Update's job that did not remove itself would refuse the new one.
  await run("/bin/launchctl", ["bootout", `${domain}/${label}`]);
  const loaded = await run("/bin/launchctl", ["bootstrap", domain, plist], { timeoutMs: 60_000 });
  if (loaded.code !== 0) throw new Error(`launchd could not load the installer: ${loaded.stderr.trim() || `exit ${loaded.code}`}`);
  // Only an explicit start runs it, at once: launchd may put off a job that runs at load, and could start it again later.
  const started = await run("/bin/launchctl", ["kickstart", `${domain}/${label}`], { timeoutMs: 60_000 });
  if (started.code !== 0) throw new Error(`launchd could not start the installer: ${started.stderr.trim() || `exit ${started.code}`}`);
}

/** Whether this process runs as a systemd unit, whose stop would end a child too. */
const underSystemd = () => !!process.env.INVOCATION_ID;

/**
 * Start `command` on its own, its output in `log`; resolves once it runs. `detached` gives it a new session on macOS and
 * Linux. On Windows a detached process has no console at all, which Windows PowerShell needs, so there it is left
 * attached and gets a console without a window; Windows never ends a process when the one that started it exits.
 */
function startOnItsOwn(command: string, args: string[], env: NodeJS.ProcessEnv, log: string, detached: boolean): Promise<void> {
  const out = openSync(log, "a");
  try {
    const child = spawn(command, args, { env, detached, stdio: ["ignore", out, out], windowsHide: true });
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
    return startOnItsOwn(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], env, log, false);
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
  if (os === "macos") return startLaunchdJob(request, script, log, env);
  return startOnItsOwn("/bin/sh", [script], env, log, true);
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
