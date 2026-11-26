import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../src/core/db.ts";
import { runPowerShell } from "../src/platform/powershell.ts";
import { eventually, tempDir } from "./helpers.ts";
import { childEnv, FAKE_PLATFORM, attacheCli, MAIN } from "./fixtures/attache-child.ts";

// These tests start the service from source, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
/** Supervisors started by a stand-in host rather than by the test, by pid. */
const strays: number[] = [];
afterEach(() => {
  for (const s of supervisors.splice(0)) s.kill("SIGKILL");
  for (const pid of strays.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

describe("the background service on Windows", () => {
  const HOME = "C:\\Users\\Søren & Ærø";
  const PREFIX = `${HOME}\\AppData\\Local\\Attache`;
  const FAKE = join(import.meta.dirname, "fixtures", "fake-task-powershell.mjs");

  function windows() {
    const dir = tempDir("attache-fake-task-scheduler-");
    const env = { ATTACHE_TEST_FAKE_PLATFORM: "win32", USERPROFILE: HOME, LOCALAPPDATA: `${HOME}\\AppData\\Local`, APPDATA: `${HOME}\\AppData\\Roaming`, ATTACHE_INSTANCE: "svctest", ATTACHE_POWERSHELL_BIN: FAKE, FAKE_TASK_SCHEDULER_DIR: dir, ATTACHE_STATE_DIR: undefined };
    return {
      attache: (args: string[]) => attacheCli(args, env),
      tasks: (): Record<string, { xml: string; state: string }> => (existsSync(join(dir, "tasks.json")) ? JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) : {}),
    };
  }

  it("is a task of the owner's that starts at logon, with no window, running the bundled runtime through the stable `current` link", () => {
    const w = windows();
    const r = w.attache(["service", "install", "--prefix", PREFIX, "--state-dir", `${PREFIX}\\state`, "--port", "7998"]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("Attache background service Attache-svctest set up.\n");
    const { xml, state } = w.tasks()["Attache-svctest"]!;
    expect(state).toBe("Ready");
    // Only the owner's own logon starts it, and it runs as the owner, without raised rights.
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1000<\/UserId>\s*<\/LogonTrigger>/);
    expect(xml).toMatch(/<Principal id="Owner">\s*<UserId>S-1-5-21-1000<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/);
    // It keeps running however long, on battery too, and is never started twice.
    for (const setting of ["<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"]) expect(xml).toContain(setting);
    // A console program started by a task opens a window; a headless console host gives it none.
    expect(xml).toContain("<Command>%SystemRoot%\\System32\\conhost.exe</Command>");
    const home = "C:\\Users\\Søren &amp; Ærø";
    const prefix = `${home}\\AppData\\Local\\Attache`;
    expect(xml).toContain(
      `<Arguments>--headless "${prefix}\\current\\runtime\\node.exe" "${prefix}\\current\\service\\attache-service.mjs" service run --port 7998 --state-dir "${prefix}\\state" --instance svctest --home "${home}" --local-app-data "${home}\\AppData\\Local" --app-data "${home}\\AppData\\Roaming"</Arguments>`,
    );
  });

  // Each `attache` command below starts Node twice (the command from source, then the PowerShell stand-in), and
  // while the suite runs a Node start can wait seconds (issue #9), so each test keeps to a few commands.
  it("stopping a service that was never set up succeeds, and starting it says to run the installer", () => {
    const w = windows();
    expect(w.attache(["stop"]).stderr).toBe("");
    expect(w.attache(["start"]).stderr).toBe("attache: Attache is not set up as a background service here: the logon task Attache-svctest is missing. Run the Attache installer again.\n");
  });

  it("starts and stops the task it set up, and says whether it is running", () => {
    const w = windows();
    w.attache(["service", "install", "--prefix", PREFIX, "--port", "7998"]);
    expect(JSON.parse(w.attache(["service", "status"]).stdout)).toEqual({ name: "Attache-svctest", definition: null, loaded: false });
    expect(w.attache(["start"]).stderr).toBe("");
    expect(JSON.parse(w.attache(["service", "status"]).stdout)).toMatchObject({ loaded: true });
    expect(w.attache(["stop"]).stderr).toBe("");
    expect(JSON.parse(w.attache(["service", "status"]).stdout)).toMatchObject({ loaded: false });
  });

  it("removes the task while it runs", () => {
    const w = windows();
    w.attache(["service", "install", "--prefix", PREFIX, "--port", "7998"]);
    w.attache(["start"]);
    const removed = w.attache(["service", "uninstall"]);
    expect(removed.stderr).toBe("");
    expect(removed.stdout).toBe("Attache background service Attache-svctest removed.\n");
    expect(w.tasks()).toEqual({});
  });
});

describe.runIf(process.platform === "win32")("the logon task in Task Scheduler", () => {
  /** What Task Scheduler itself says about a task, as Windows PowerShell's ScheduledTasks module reports it. */
  const inspect = async (name: string) => {
    const script = String.raw`
function Invoke-Request($req) {
  $t = Get-ScheduledTask -TaskPath '\' -TaskName $req.name -ErrorAction SilentlyContinue
  if (-not $t) { return @{ ok = $true; present = $false } }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  return @{ ok = $true; present = $true; trigger = [string]$t.Triggers[0].CimClass.CimClassName; triggerUser = [string]$t.Triggers[0].UserId; logonType = [string]$t.Principal.LogonType; runLevel = [string]$t.Principal.RunLevel; me = @($me.Name, $me.User.Value) }
}
`;
    const r = await runPowerShell(script, { name }, { timeoutMs: 60_000 });
    if (!r.ok) throw new Error(r.why);
    return r.reply as { present: boolean; trigger?: string; triggerUser?: string; logonType?: string; runLevel?: string; me?: string[] };
  };

  it("starts the bundled runtime from a folder named with æøå without a window, stops with everything it started, and is removed again", async () => {
    const home = tempDir("attache-task-home æøå-");
    const prefix = join(home, "AppData", "Local", "Attache");
    const current = join(prefix, "current");
    mkdirSync(join(current, "runtime"), { recursive: true });
    mkdirSync(join(current, "service"), { recursive: true });
    copyFileSync(process.execPath, join(current, "runtime", "node.exe"));
    // A stand-in release that records how the task started it, and keeps running like the service.
    const report = join(home, "started.json");
    writeFileSync(join(current, "service", "attache-service.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));\nsetInterval(() => {}, 1000);\n`);
    const instance = `tasktest${process.pid}`;
    const task = `Attache-${instance}`;
    const env = { ATTACHE_INSTANCE: instance, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), ATTACHE_STATE_DIR: undefined };
    const attache = (args: string[]) => attacheCli(args, env);
    try {
      expect(attache(["service", "install", "--prefix", prefix, "--state-dir", join(prefix, "state"), "--port", "7997"]).stderr).toBe("");
      // Only the owner's own logon starts it, and it runs as the owner, without raised rights.
      const definition = await inspect(task);
      expect(definition).toMatchObject({ present: true, trigger: "MSFT_TaskLogonTrigger", logonType: "Interactive", runLevel: "Limited" });
      expect(definition.me!.map((m) => m.toLowerCase())).toContain(definition.triggerUser!.toLowerCase());

      expect(attache(["start"]).stderr).toBe("");
      const started = await eventually("the task to start the release", () => (existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null));
      expect(started.args).toEqual(["service", "run", "--port", "7997", "--state-dir", join(prefix, "state"), "--instance", instance, "--home", home, "--local-app-data", join(home, "AppData", "Local"), "--app-data", join(home, "AppData", "Roaming")]);
      expect(JSON.parse(attache(["service", "status"]).stdout)).toEqual({ name: task, definition: null, loaded: true });

      expect(attache(["stop"]).stderr).toBe("");
      expect(JSON.parse(attache(["service", "status"]).stdout)).toMatchObject({ loaded: false });
      await eventually("the release the task started to stop", () => (alive(started.pid) ? null : true), { timeoutMs: 15_000 });

      expect(attache(["service", "uninstall"]).stderr).toBe("");
      expect(await inspect(task)).toEqual({ ok: true, present: false });
    } finally {
      attache(["service", "uninstall"]);
    }
  });
});

describe("the entry point of the Windows logon task", () => {
  it("keeps the service running in the owner's home, restarts it after a crash, and stops it when it stops itself", async () => {
    const stateDir = join(tempDir("attache-supervised æøå-"), "state");
    const home = tempDir("attache-supervised-home-");
    const supervisor = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", home], {
      env: childEnv({ ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1", ATTACHE_STATE_DIR: undefined, ATTACHE_INSTANCE: undefined }),
      stdio: "ignore",
    });
    supervisors.push(supervisor);

    const first = await healthyService(stateDir);
    process.kill(first.pid, "SIGKILL");
    const second = await healthyService(stateDir, first.pid);
    expect(second.pid).not.toBe(first.pid);
    const log = readFileSync(join(stateDir, "logs", "service.err.log"), "utf8");
    expect(log).toMatch(/attache service run: the service stopped \(.+\); starting it again in 2 s/);
    expect(readFileSync(join(stateDir, "logs", "service.out.log"), "utf8")).toContain("attache service listening");

    const exited = new Promise((r) => supervisor.once("exit", r));
    supervisor.kill("SIGTERM");
    await exited;
    await eventually("the service to stop with its supervisor", () => (alive(second.pid) ? null : true), { timeoutMs: 15_000 });
    expect(existsSync(join(stateDir, "runtime.json"))).toBe(false);
  });

  it("does not start a service again that refused to start, such as on a database a newer Attache wrote", async () => {
    const stateDir = join(tempDir("attache-supervised-"), "state");
    mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(join(stateDir, "attache.sqlite"));
    db.exec(`pragma user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    const supervisor = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", tempDir("attache-supervised-home-")], {
      env: childEnv({ ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1", ATTACHE_STATE_DIR: undefined, ATTACHE_INSTANCE: undefined }),
      stdio: "ignore",
    });
    supervisors.push(supervisor);
    const code = await new Promise((r) => supervisor.once("exit", r));
    expect(code).toBe(0);
    const log = readFileSync(join(stateDir, "logs", "service.err.log"), "utf8");
    expect(log).toContain("Install the newest Attache again to keep using it.");
    expect(log).toMatch(/attache service run: the service refused to start; it starts again with `attache start` or when Attache is installed again\n$/);
    expect(log.match(/Install the newest Attache again/g), "started once").toHaveLength(1);
  });

  it("stops the service cleanly when the supervisor itself is killed outright", async () => {
    const stateDir = join(tempDir("attache-supervised-"), "state");
    const supervisor = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", tempDir("attache-supervised-home-")], {
      env: childEnv({ ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1" }),
      stdio: "ignore",
    });
    supervisors.push(supervisor);
    const service = await healthyService(stateDir);
    supervisor.kill("SIGKILL");
    await eventually("the service to stop without its supervisor", () => (alive(service.pid) ? null : true), { timeoutMs: 15_000 });
    expect(existsSync(join(stateDir, "runtime.json"))).toBe(false);
  });

  it("stops, with the service, when the console host the task started it in is gone, as ending the task leaves it", async () => {
    const stateDir = join(tempDir("attache-supervised-"), "state");
    const args = ["--import", FAKE_PLATFORM, MAIN, "service", "run", "--port", "0", "--state-dir", stateDir, "--instance", "supervised", "--home", tempDir("attache-supervised-home-")];
    // A stand-in for the console host: it starts the supervisor, says which process that is, and is then
    // ended without a word to it. Ending the console host leaves the supervisor running, so the stand-in
    // starts it detached: Node on Windows would otherwise end it along with the stand-in.
    const host = spawn(process.execPath, ["-e", `process.stdout.write(String(require("node:child_process").spawn(process.execPath, ${JSON.stringify(args)}, { stdio: "ignore", detached: true }).pid)); setInterval(() => {}, 1000);`], {
      env: childEnv({ ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1" }),
      stdio: ["ignore", "pipe", "ignore"],
    });
    supervisors.push(host);
    const supervisorPid = await new Promise<number>((r) => host.stdout!.once("data", (d: Buffer) => r(Number(d.toString()))));
    strays.push(supervisorPid);
    const service = await healthyService(stateDir);
    host.kill("SIGKILL");
    await eventually("the supervisor to stop after its host", () => (alive(supervisorPid) ? null : true), { timeoutMs: 20_000 });
    await eventually("the service to stop with its supervisor", () => (alive(service.pid) ? null : true), { timeoutMs: 20_000 });
    expect(existsSync(join(stateDir, "runtime.json"))).toBe(false);
    expect(readFileSync(join(stateDir, "logs", "service.err.log"), "utf8")).toContain("stopping (the task that started it has ended)");
  });
});
