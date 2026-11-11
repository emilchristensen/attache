/**
 * What the install test needs to know about the operating system it runs on:
 * where the release installs in a clean home folder, how to run its scripts
 * and a Harness's hook commands, and how to ask the service manager about the
 * Jarvis service (launchd on macOS, the systemd user manager on Linux, Task
 * Scheduler on Windows).
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { locationsForHome, serviceName } from "../../apps/service/src/platform/locations.ts";
import { currentOs } from "../../apps/service/src/platform/os.ts";
import { hostTarget, RELEASE_TARGETS } from "../release-targets.mjs";

const succeeds = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const output = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

/** macOS and Linux run scripts with /bin/sh, and a Harness runs hook commands through a login shell. */
function posix(home) {
  return {
    runtime: (prefix) => join(prefix, "current", "runtime", "node"),
    command: (binDir, name) => join(binDir, name),
    runScript: (file, args, env) => execFileSync("/bin/sh", [file, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    runHook: (command, input, env) => execFileSync("/bin/sh", ["-lc", command], { input, env, encoding: "utf8" }),
    /** How a path appears in a command line Jarvis writes into a Harness's settings. */
    commandPath: (p) => p,
    /** A clean profile: this home folder and a PATH with no developer tools. */
    cleanEnv: (vars) => ({ HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...vars }),
  };
}

function macos(loc, name) {
  const domain = `gui/${process.getuid()}`;
  const definition = join(loc.serviceDefinitionDir, `${name}.plist`);
  return {
    ...posix(loc.home),
    serviceKind: "launchd session",
    definition,
    loaded: () => succeeds("/bin/launchctl", ["print", `${domain}/${name}`]),
    /** launchd starts a LaunchAgent with RunAtLoad when the owner logs in. */
    startsAtLogin: () => existsSync(definition) && /<key>RunAtLoad<\/key><true\/>/.test(readFileSync(definition, "utf8")),
    runsBundledRuntime: (prefix) => readFileSync(definition, "utf8").includes(`${prefix}/current/runtime/node`),
    /** Whether the service manager still knows the service at all. */
    known: () => existsSync(definition) || succeeds("/bin/launchctl", ["print", `${domain}/${name}`]),
    cleanup: () => succeeds("/bin/launchctl", ["bootout", `${domain}/${name}`]),
    /** Service definitions of this instance in the owner's LaunchAgents folder. */
    definitions: () => (existsSync(loc.serviceDefinitionDir) ? readdirSync(loc.serviceDefinitionDir).filter((f) => f.startsWith(`${name}.`)) : []),
    ownerFiles: { "Library/LaunchAgents/com.example.owner.plist": "<plist><dict><key>Label</key><string>com.example.owner</string></dict></plist>\n" },
    /** The owner's own brains and schedules on this Mac must not change while the test runs. */
    machineFingerprint: () => {
      const git = (dir, args) => output("/usr/bin/git", ["-C", dir, ...args]) || "n/a";
      const brain = (dir) => `${git(dir, ["rev-parse", "HEAD"])} ${createHash("sha256").update(git(dir, ["status", "--porcelain"])).digest("hex").slice(0, 12)}`;
      const agents = output("/bin/launchctl", ["list"]).split("\n").filter((l) => /second-?brain/i.test(l)).map((l) => l.split("\t").pop()).sort().join(",");
      const plistDir = join(homedir(), "Library/LaunchAgents");
      const plists = existsSync(plistDir) ? readdirSync(plistDir).filter((f) => /second-?brain|brain/i.test(f)).map((f) => `${f}:${createHash("sha256").update(readFileSync(join(plistDir, f))).digest("hex").slice(0, 12)}`).sort().join(",") : "";
      return { newBrain: brain(join(homedir(), "old-notes")), oldBrain: brain(join(homedir(), "OldNotes")), agents, plists };
    },
  };
}

function linux(loc, name) {
  const definition = join(loc.serviceDefinitionDir, name);
  // The test's clean profile has no XDG_RUNTIME_DIR; the owner's user manager lives at the standard place.
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` };
  const systemctl = (args) => {
    try {
      return { ok: true, out: execFileSync("systemctl", ["--user", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? "").trim() };
    }
  };
  return {
    ...posix(loc.home),
    serviceKind: "systemd user manager",
    definition,
    loaded: () => ["active", "activating", "reloading"].includes(systemctl(["show", name, "--property=ActiveState", "--value"]).out),
    /** A user unit enabled for default.target starts when the owner's user manager starts, at login. */
    startsAtLogin: () => systemctl(["is-enabled", name]).out === "enabled" && systemctl(["show", name, "--property=WantedBy", "--value"]).out.split(/\s+/).includes("default.target"),
    runsBundledRuntime: (prefix) => readFileSync(definition, "utf8").includes(`${prefix}/current/runtime/node`),
    known: () => existsSync(definition) || !["", "not-found"].includes(systemctl(["is-enabled", name]).out),
    cleanup: () => {
      systemctl(["stop", name]);
      systemctl(["disable", name]);
    },
    definitions: () => (existsSync(loc.serviceDefinitionDir) ? readdirSync(loc.serviceDefinitionDir).filter((f) => f === name || f.startsWith(`${name}.`)) : []),
    ownerFiles: { ".config/systemd/user/owner-backup.service": "[Service]\nExecStart=/bin/true\n" },
    machineFingerprint: () => ({}),
  };
}

/** The variables a Windows program needs from the system, whatever the profile. */
const WINDOWS_SYSTEM_VARS = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "USERNAME", "USERDOMAIN", "COMPUTERNAME"];

/** Run a Windows PowerShell script and return what it printed, read as UTF-8. */
function powershell(script, vars = {}) {
  const full = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n${script}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { env: { ...process.env, ...vars }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function windows(loc, name) {
  const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const task = (script) => JSON.parse(powershell(`$t = Get-ScheduledTask -TaskPath '\\' -TaskName $env:N -ErrorAction SilentlyContinue\n${script} | ConvertTo-Json -Compress -Depth 3`, { N: name }));
  const gitBash = join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
  return {
    runtime: (prefix) => join(prefix, "current", "runtime", "node.exe"),
    command: (binDir, name) => join(binDir, `${name}.cmd`),
    // As a terminal runs them: through cmd.exe (Node uses `cmd.exe /d /s /c "<command>"`).
    runScript: (file, args, env) => execSync([`"${file}"`, ...args].join(" "), { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    // Claude Code runs hook commands through Git Bash on Windows.
    runHook: (command, input, env) => execFileSync(gitBash, ["-c", command], { input, env, encoding: "utf8" }),
    commandPath: (p) => p.replace(/\\/g, "/"),
    cleanEnv: (vars) => ({
      ...Object.fromEntries(WINDOWS_SYSTEM_VARS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      USERPROFILE: loc.home,
      HOME: loc.home,
      LOCALAPPDATA: join(loc.home, "AppData", "Local"),
      APPDATA: join(loc.home, "AppData", "Roaming"),
      TEMP: vars.TMPDIR,
      TMP: vars.TMPDIR,
      PATH: [system, process.env.SystemRoot, join(system, "Wbem"), join(system, "WindowsPowerShell", "v1.0")].join(";"),
      ...vars,
    }),
    serviceKind: "logon task",
    definition: null,
    loaded: () => ["Running", "Queued"].includes(task("[string]$t.State")),
    /** A logon trigger for the owner's own account starts the task when the owner logs on. */
    startsAtLogin: () => {
      const t = task("$me = [Security.Principal.WindowsIdentity]::GetCurrent(); @{ trigger = [string]$t.Triggers[0].CimClass.CimClassName; enabled = [bool]$t.Triggers[0].Enabled; user = [string]$t.Triggers[0].UserId; me = @($me.Name.ToLower(), $me.User.Value.ToLower()) }");
      return t.trigger === "MSFT_TaskLogonTrigger" && t.enabled && t.me.includes(t.user.toLowerCase());
    },
    runsBundledRuntime: (prefix) => task("[string]$t.Actions[0].Arguments").includes(`"${join(prefix, "current", "runtime", "node.exe")}"`),
    known: () => task("[bool]$t") === true,
    cleanup: () => {
      try {
        powershell("if (Get-ScheduledTask -TaskName $env:N -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $env:N; Unregister-ScheduledTask -TaskName $env:N -Confirm:$false }", { N: name });
      } catch {
        // Nothing left to clean up.
      }
    },
    /** Logon tasks of this instance. */
    definitions: () => [].concat(JSON.parse(powershell("@(Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $env:N -or $_.TaskName -like \"$env:N.*\" } | ForEach-Object { $_.TaskName }) | ConvertTo-Json -Compress", { N: name }) || "[]")),
    ownerFiles: { "AppData/Local/OwnerApp/settings.ini": "[owner]\ntheme=dark\n", "AppData/Roaming/OwnerApp/notes.txt": "mine\n" },
    /** The owner's own Jarvis logon tasks on this computer must not change while the test runs. */
    machineFingerprint: () => ({ tasks: powershell("(@(Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -like 'Jarvis*' -and $_.TaskName -ne $env:N } | ForEach-Object { $_.TaskName }) | Sort-Object) -join ','", { N: name }) }),
  };
}

/** The install test's view of this computer, for a clean home folder and a test-only service instance. */
export function installTestPlatform(home, instance) {
  const target = hostTarget();
  if (!target) throw new Error(`The install test runs where Jarvis has a release; this is ${process.platform}/${process.arch}.`);
  const os = currentOs();
  const loc = locationsForHome(home, os, {});
  const name = serviceName(os, instance);
  const service = os === "macos" ? macos(loc, name) : os === "linux" ? linux(loc, name) : windows(loc, name);
  return {
    os,
    target,
    serviceName: name,
    prefix: loc.installPrefix,
    state: loc.stateDir,
    binDir: loc.binDir,
    artifact: (root, version) => join(root, "release", version, RELEASE_TARGETS[target].installer(version)),
    ...service,
  };
}
