import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPowerShell } from "../src/platform/powershell.ts";
import { tempDir } from "./helpers.ts";
import { childEnv, FAKE_PLATFORM, jarvisCli, MAIN } from "./fixtures/jarvis-child.ts";

// These tests start the service from source, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll `check` until it returns a value, or fail after `ms`. */
async function eventually<T>(what: string, check: () => Promise<T | null> | T | null, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** The running service in a state folder, once it answers: its pid and address. */
async function healthyService(stateDir: string, notPid?: number) {
  return eventually("a healthy service", async () => {
    const file = join(stateDir, "runtime.json");
    if (!existsSync(file)) return null;
    const rt = JSON.parse(readFileSync(file, "utf8")) as { pid: number; url: string };
    if (rt.pid === notPid) return null;
    const ok = await fetch(`${rt.url}/api/v1/health`).then((r) => r.ok, () => false);
    return ok ? rt : null;
  });
}

const supervisors: ChildProcess[] = [];
afterEach(() => {
  for (const s of supervisors.splice(0)) s.kill("SIGKILL");
});

describe("the background service on Windows", () => {
  const HOME = "C:\\Users\\Søren & Ærø";
  const PREFIX = `${HOME}\\AppData\\Local\\Jarvis`;
  const FAKE = join(import.meta.dirname, "fixtures", "fake-task-powershell.mjs");

  function windows() {
    const dir = tempDir("jarvis-fake-task-scheduler-");
    const env = { JARVIS_TEST_FAKE_PLATFORM: "win32", USERPROFILE: HOME, LOCALAPPDATA: `${HOME}\\AppData\\Local`, APPDATA: `${HOME}\\AppData\\Roaming`, JARVIS_INSTANCE: "svctest", JARVIS_POWERSHELL_BIN: FAKE, FAKE_TASK_SCHEDULER_DIR: dir, JARVIS_STATE_DIR: undefined };
    return {
      jarvis: (args: string[]) => jarvisCli(args, env),
      tasks: (): Record<string, { xml: string; state: string }> => (existsSync(join(dir, "tasks.json")) ? JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) : {}),
    };
  }

  it("is a task of the owner's that starts at logon, with no window, running the bundled runtime through the stable `current` link", () => {
    const w = windows();
    const r = w.jarvis(["service", "install", "--prefix", PREFIX, "--state-dir", `${PREFIX}\\state`, "--port", "7998"]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("Jarvis background service Jarvis-svctest set up.\n");
    const { xml, state } = w.tasks()["Jarvis-svctest"]!;
    expect(state).toBe("Ready");
    // Only the owner's own logon starts it, and it runs as the owner, without raised rights.
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1000<\/UserId>\s*<\/LogonTrigger>/);
    expect(xml).toMatch(/<Principal id="Owner">\s*<UserId>S-1-5-21-1000<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/);
    // It keeps running however long, on battery too, and is never started twice.
    for (const setting of ["<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"]) expect(xml).toContain(setting);
    // A console program started by a task opens a window; a headless console host gives it none.
    expect(xml).toContain("<Command>%SystemRoot%\\System32\\conhost.exe</Command>");
    const home = "C:\\Users\\Søren &amp; Ærø";
    const prefix = `${home}\\AppData\\Local\\Jarvis`;
    expect(xml).toContain(
      `<Arguments>--headless "${prefix}\\current\\runtime\\node.exe" "${prefix}\\current\\service\\jarvis-service.mjs" service run --port 7998 --state-dir "${prefix}\\state" --instance svctest --home "${home}" --local-app-data "${home}\\AppData\\Local" --app-data "${home}\\AppData\\Roaming"</Arguments>`,
    );
  });

  it("starts, stops and is removed again; stopping a service that was never set up succeeds", () => {
    const w = windows();
    expect(w.jarvis(["stop"]).stderr).toBe("");
    expect(w.jarvis(["start"]).stderr).toBe("jarvis: Jarvis is not set up as a background service here: the logon task Jarvis-svctest is missing. Run the Jarvis installer again.\n");
    w.jarvis(["service", "install", "--prefix", PREFIX, "--port", "7998"]);
    expect(JSON.parse(w.jarvis(["service", "status"]).stdout)).toEqual({ name: "Jarvis-svctest", definition: null, loaded: false });
    expect(w.jarvis(["start"]).stderr).toBe("");
    expect(JSON.parse(w.jarvis(["service", "status"]).stdout)).toMatchObject({ loaded: true });
    expect(w.jarvis(["stop"]).stderr).toBe("");
    expect(JSON.parse(w.jarvis(["service", "status"]).stdout)).toMatchObject({ loaded: false });
    w.jarvis(["start"]);
    const removed = w.jarvis(["service", "uninstall"]);
    expect(removed.stderr).toBe("");
    expect(removed.stdout).toBe("Jarvis background service Jarvis-svctest removed.\n");
    expect(w.tasks()).toEqual({});
  });
});

describe.runIf(process.platform === "win32")("the logon task in Task Scheduler", () => {
  const inspect = async (script: string, vars: Record<string, string>) => {
    const r = await runPowerShell(script, vars);
    expect(r.stderr).toBe("");
    return r.stdout.trim();
  };

  it("starts the bundled runtime from a folder named with æøå without a window, stops with everything it started, and is removed again", async () => {
    const home = tempDir("jarvis-task-home æøå-");
    const prefix = join(home, "AppData", "Local", "Jarvis");
    const current = join(prefix, "current");
    mkdirSync(join(current, "runtime"), { recursive: true });
    mkdirSync(join(current, "service"), { recursive: true });
    copyFileSync(process.execPath, join(current, "runtime", "node.exe"));
    // A stand-in release that records how the task started it, and keeps running like the service.
    const report = join(home, "started.json");
    writeFileSync(join(current, "service", "jarvis-service.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\nsetInterval(() => {}, 1000);\n`);
    const instance = `tasktest${process.pid}`;
    const task = `Jarvis-${instance}`;
    const env = { JARVIS_INSTANCE: instance, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), JARVIS_STATE_DIR: undefined };
    const jarvis = (args: string[]) => jarvisCli(args, env);
    try {
      expect(jarvis(["service", "install", "--prefix", prefix, "--state-dir", join(prefix, "state"), "--port", "7997"]).stderr).toBe("");
      const definition = JSON.parse(
        await inspect(
          "$t = Get-ScheduledTask -TaskName $env:N; $me = [Security.Principal.WindowsIdentity]::GetCurrent(); @{ trigger = $t.Triggers[0].CimClass.CimClassName; triggerUser = $t.Triggers[0].UserId; logonType = [string]$t.Principal.LogonType; runLevel = [string]$t.Principal.RunLevel; me = @($me.Name, $me.User.Value) } | ConvertTo-Json -Compress",
          { N: task },
        ),
      );
      expect(definition).toMatchObject({ trigger: "MSFT_TaskLogonTrigger", logonType: "Interactive", runLevel: "Limited" });
      expect(definition.me.map((m: string) => m.toLowerCase())).toContain(definition.triggerUser.toLowerCase());

      expect(jarvis(["start"]).stderr).toBe("");
      const started = await eventually("the task to start the release", () => (existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null));
      expect(started.args).toEqual(["service", "run", "--port", "7997", "--state-dir", join(prefix, "state"), "--instance", instance, "--home", home, "--local-app-data", join(home, "AppData", "Local"), "--app-data", join(home, "AppData", "Roaming")]);
      expect(JSON.parse(jarvis(["service", "status"]).stdout)).toEqual({ name: task, definition: null, loaded: true });

      expect(jarvis(["stop"]).stderr).toBe("");
      expect(JSON.parse(jarvis(["service", "status"]).stdout)).toMatchObject({ loaded: false });
      await eventually("the release the task started to stop", () => (alive(started.pid) ? null : true), 15_000);

      expect(jarvis(["service", "uninstall"]).stderr).toBe("");
      expect(await inspect("if (Get-ScheduledTask -TaskName $env:N -ErrorAction SilentlyContinue) { 'present' } else { 'gone' }", { N: task })).toBe("gone");
    } finally {
      jarvis(["service", "uninstall"]);
    }
  });
});

describe("the entry point of the Windows logon task", () => {
  it("keeps the service running in the owner's home, restarts it after a crash, and stops it when it stops itself", async () => {
    const stateDir = join(tempDir("jarvis-supervised æøå-"), "state");
    const home = tempDir("jarvis-supervised-home-");
    const supervisor = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", home], {
      env: childEnv({ JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", JARVIS_STATE_DIR: undefined, JARVIS_INSTANCE: undefined }),
      stdio: "ignore",
    });
    supervisors.push(supervisor);

    const first = await healthyService(stateDir);
    process.kill(first.pid, "SIGKILL");
    const second = await healthyService(stateDir, first.pid);
    expect(second.pid).not.toBe(first.pid);
    const log = readFileSync(join(stateDir, "logs", "service.err.log"), "utf8");
    expect(log).toMatch(/jarvis service run: the service stopped \(.+\); starting it again in 2 s/);
    expect(readFileSync(join(stateDir, "logs", "service.out.log"), "utf8")).toContain("jarvis service listening");

    const exited = new Promise((r) => supervisor.once("exit", r));
    supervisor.kill("SIGTERM");
    await exited;
    await eventually("the service to stop with its supervisor", () => (alive(second.pid) ? null : true), 15_000);
    expect(existsSync(join(stateDir, "runtime.json"))).toBe(false);
  });

  it("never leaves the service running when the supervisor itself is killed, as ending the task does", async () => {
    const stateDir = join(tempDir("jarvis-supervised-"), "state");
    const supervisor = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", tempDir("jarvis-supervised-home-")], {
      env: childEnv({ JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1" }),
      stdio: "ignore",
    });
    supervisors.push(supervisor);
    const service = await healthyService(stateDir);
    supervisor.kill("SIGKILL");
    await eventually("the service to stop without its supervisor", () => (alive(service.pid) ? null : true), 15_000);
  });
});
