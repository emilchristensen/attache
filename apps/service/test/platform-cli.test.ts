import { describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { tempDir } from "./helpers.ts";
import { fakeSystemctl } from "./fixtures/fake-systemctl.ts";

// Each test starts the `attache` executable from source several times, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../src/main.ts");
/** A URL, because `--import` reads a Windows path's drive letter as a URL scheme. */
const FAKE_PLATFORM = pathToFileURL(join(import.meta.dirname, "fixtures/fake-platform.mjs")).href;

/**
 * This process's environment with `overrides` in place of the inherited variables of the same name in any case.
 * Windows names are case-insensitive: a child given both `SYSTEMROOT` and `SystemRoot` sees whichever sorts first.
 */
function withOverrides(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  const replaced = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
  const inherited = Object.entries(process.env).filter(([name]) => !replaced.has(name.toLowerCase()));
  return { ...Object.fromEntries(inherited), ...overrides };
}

/** Run the `attache` executable from source, optionally as if on another operating system. */
function attache(args: string[], opts: { platform?: string; env?: Record<string, string | undefined> } = {}) {
  const env = withOverrides({ HOME: tempDir("attache-cli-home-"), ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1", ...opts.env });
  if (opts.platform) env.ATTACHE_TEST_FAKE_PLATFORM = opts.platform;
  const r = spawnSync(process.execPath, ["--import", FAKE_PLATFORM, MAIN, ...args], { env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("paths and Harness locations per operating system", () => {
  const paths = (platform: string, env: Record<string, string | undefined>) => {
    const r = attache(["paths"], { platform, env: { ATTACHE_STATE_DIR: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, XDG_CONFIG_HOME: undefined, LOCALAPPDATA: undefined, APPDATA: undefined, ...env } });
    expect(r.stderr).toBe("");
    return JSON.parse(r.stdout);
  };

  it("resolves the macOS locations the installer has always used", () => {
    const p = paths("darwin", { HOME: "/Users/owner" });
    expect(p).toMatchObject({
      os: "macos",
      installPrefix: "/Users/owner/Library/Application Support/Attache",
      stateDir: "/Users/owner/Library/Application Support/Attache/state",
      locksDir: "/Users/owner/Library/Application Support/Attache/locks",
      binDir: "/Users/owner/.local/bin",
      serviceDefinitionDir: "/Users/owner/Library/LaunchAgents",
      documentsDir: "/Users/owner/Documents",
      tar: "/usr/bin/tar",
      claudeManagedSettings: "/Library/Application Support/ClaudeCode/managed-settings.json",
    });
    expect(p.harnesses["claude-code"]).toMatchObject({ hooksFile: ".claude/settings.json", mcpFile: ".claude.json", legacySkillsDir: ".claude/skills", executables: ["/Users/owner/.local/bin/claude", "/Users/owner/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"] });
    expect(p.harnesses.codex).toMatchObject({ hooksFile: ".codex/hooks.json", mcpFile: ".codex/config.toml", mcpFormat: "toml", legacySkillsDir: ".agents/skills" });
    expect(p.harnesses.antigravity).toMatchObject({ hooksFile: ".gemini/config/hooks.json", rulesDir: ".gemini/config/rules", mcpFile: ".gemini/config/mcp_config.json", legacySkillsDir: ".gemini/config/skills" });
    expect(p.harnesses["claude-desktop"]).toMatchObject({ hooksFile: null, mcpFile: "Library/Application Support/Claude/claude_desktop_config.json", presence: ["/Applications/Claude.app", "/Users/owner/Library/Application Support/Claude"] });
    expect(p.harnesses.antigravity.presence).toContain("/Applications/Antigravity.app");
  });

  it("resolves Linux locations from the XDG base directories", () => {
    expect(paths("linux", { HOME: "/home/owner" })).toMatchObject({
      os: "linux",
      installPrefix: "/home/owner/.local/share/attache",
      stateDir: "/home/owner/.local/state/attache",
      locksDir: "/home/owner/.local/state/attache/locks",
      binDir: "/home/owner/.local/bin",
      serviceDefinitionDir: "/home/owner/.config/systemd/user",
      documentsDir: "/home/owner/Documents",
      claudeManagedSettings: "/etc/claude-code/managed-settings.json",
    });
    const custom = paths("linux", { HOME: "/home/owner", XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/config" });
    expect(custom).toMatchObject({ installPrefix: "/data/attache", stateDir: "/state/attache", locksDir: "/home/owner/.local/state/attache/locks", serviceDefinitionDir: "/config/systemd/user" });
    expect(custom.harnesses.codex.executables).toEqual(["/home/owner/.local/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"]);
    expect(custom.harnesses["claude-desktop"]).toMatchObject({ mcpFile: ".config/Claude/claude_desktop_config.json", presence: ["/home/owner/.config/Claude"] });
  });

  it("resolves Windows locations under the owner's local application data", () => {
    const p = paths("win32", { USERPROFILE: "C:\\Users\\owner", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local", APPDATA: "C:\\Users\\owner\\AppData\\Roaming", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" });
    expect(p).toMatchObject({
      os: "windows",
      home: "C:\\Users\\owner",
      installPrefix: "C:\\Users\\owner\\AppData\\Local\\Attache",
      stateDir: "C:\\Users\\owner\\AppData\\Local\\Attache\\state",
      locksDir: "C:\\Users\\owner\\AppData\\Local\\Attache\\locks",
      binDir: "C:\\Users\\owner\\AppData\\Local\\Attache\\bin",
      serviceDefinitionDir: null,
      documentsDir: "C:\\Users\\owner\\Documents",
      tar: "C:\\Windows\\System32\\tar.exe",
      claudeManagedSettings: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    });
    expect(p.harnesses.codex.executables).toEqual(["C:\\Users\\owner\\.local\\bin\\codex.exe", "C:\\Users\\owner\\.local\\bin\\codex.cmd", "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.exe", "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd"]);
    expect(p.harnesses["claude-code"].presence).toContain("C:\\Users\\owner\\.claude");
    expect(p.harnesses["claude-desktop"]).toMatchObject({ mcpFile: "AppData/Roaming/Claude/claude_desktop_config.json", presence: ["C:\\Users\\owner\\AppData\\Local\\AnthropicClaude", "C:\\Users\\owner\\AppData\\Roaming\\Claude"] });
  });

  it("prints a single location for installer scripts", () => {
    const r = attache(["paths", "installPrefix"], { platform: "darwin", env: { HOME: "/Users/owner" } });
    expect(r.stdout).toBe("/Users/owner/Library/Application Support/Attache\n");
  });
});

describe("an unsupported operating system", () => {
  const unsupported = "attache: Attache runs on macOS, Linux and Windows. This computer runs freebsd, which Attache does not support.\n";

  it("gets a clear message instead of a crash from the command line", () => {
    const r = attache(["status"], { platform: "freebsd", env: { ATTACHE_STATE_DIR: undefined } });
    expect(r.stderr).toBe(unsupported);
    expect(r.status).toBe(1);
  });

  it("gets the same message when the service is asked to start, even with a state folder given", () => {
    const r = attache(["serve", "--port", "0"], { platform: "freebsd", env: { ATTACHE_STATE_DIR: tempDir("attache-unsupported-") } });
    expect(r.stderr).toBe(unsupported);
    expect(r.status).toBe(1);
  });
});

describe("the command-line wrappers the installer puts on PATH", () => {
  it.skipIf(process.platform === "win32")("pin `attache` to the install and let `attache-uninstall` run the installed uninstaller", () => {
    const home = tempDir("attache-wrapper-home-");
    const prefix = join(home, "Attache Install");
    // A stand-in release that reports how it was called.
    mkdirSync(join(prefix, "current/bin"), { recursive: true });
    writeFileSync(join(prefix, "current/bin/attache"), '#!/bin/sh\necho "state=$ATTACHE_STATE_DIR instance=$ATTACHE_INSTANCE port=$ATTACHE_PORT args=$*"\n', { mode: 0o755 });
    writeFileSync(join(prefix, "current/uninstall.sh"), 'echo "uninstall prefix=$ATTACHE_PREFIX state=$ATTACHE_STATE_DIR instance=$ATTACHE_INSTANCE args=$*"\n');
    const env = { HOME: home, ATTACHE_INSTANCE: "wraptest" };
    const installed = attache(["wrappers", "install", "--prefix", prefix, "--state-dir", join(prefix, "state"), "--port", "7999"], { env });
    expect(installed.stderr).toBe("");
    const bin = join(home, ".local/bin");
    expect(JSON.parse(installed.stdout)).toEqual([join(bin, "attache"), join(bin, "attache-uninstall")]);

    const clean = { PATH: "/usr/bin:/bin", HOME: home };
    expect(execFileSync(join(bin, "attache"), ["status", "--json"], { env: clean, encoding: "utf8" })).toBe(`state=${prefix}/state instance=wraptest port=7999 args=status --json\n`);
    expect(execFileSync(join(bin, "attache"), ["pair"], { env: { ...clean, ATTACHE_PORT: "8001" }, encoding: "utf8" })).toBe(`state=${prefix}/state instance=wraptest port=8001 args=pair\n`);
    expect(execFileSync(join(bin, "attache-uninstall"), ["--delete-data"], { env: clean, encoding: "utf8" })).toBe(`uninstall prefix=${prefix} state=${prefix}/state instance=wraptest args=--delete-data\n`);

    attache(["wrappers", "uninstall"], { env });
    expect(existsSync(join(bin, "attache")) || existsSync(join(bin, "attache-uninstall"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("pin `attache.cmd` to the install and let `attache-uninstall.cmd` run the installed PowerShell uninstaller, in a folder named with æøå", () => {
    const home = tempDir("attache-wrapper-home æøå-");
    const prefix = join(home, "AppData", "Local", "Attache");
    const bin = join(prefix, "bin");
    // A stand-in release that records how it was called. It reports through a UTF-8 file, because
    // cmd.exe and PowerShell write to a pipe in the console's code page.
    const reports = join(home, "reports.jsonl");
    const reporter = join(prefix, "current", "report.cjs");
    mkdirSync(join(prefix, "current", "bin"), { recursive: true });
    writeFileSync(reporter, `const e = process.env; require("node:fs").appendFileSync(${JSON.stringify(reports)}, JSON.stringify({ state: e.ATTACHE_STATE_DIR, prefix: e.ATTACHE_PREFIX, instance: e.ATTACHE_INSTANCE, port: e.ATTACHE_PORT, args: process.argv.slice(2) }) + "\\n");\n`);
    writeFileSync(join(prefix, "current", "bin", "attache.cmd"), `@"${process.execPath}" "%~dp0..\\report.cjs" %*\r\n`);
    writeFileSync(join(prefix, "current", "uninstall.ps1"), `& '${process.execPath}' (Join-Path $PSScriptRoot 'report.cjs') uninstall @args\r\nRemove-Item -LiteralPath (Join-Path $PSScriptRoot '..\\bin\\attache-uninstall.cmd')\r\nexit 3\r\n`);
    const env = { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), ATTACHE_INSTANCE: "wraptest" };
    const installed = attache(["wrappers", "install", "--prefix", prefix, "--state-dir", join(prefix, "state"), "--port", "7999"], { env });
    expect(installed.stderr).toBe("");
    expect(JSON.parse(installed.stdout)).toEqual([join(bin, "attache.cmd"), join(bin, "attache-uninstall.cmd")]);
    const files = [join(bin, "attache.cmd"), join(bin, "attache-uninstall.cmd")];
    for (const f of files) expect(readFileSync(f, "utf8")).toMatch(/^[\x20-\x7e\r\n]*$/);

    // Run as a terminal does, through cmd.exe, with none of Attache's variables set.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATTACHE_")));
    const run = (file: string, args: string, extra: Record<string, string> = {}) => spawnSync(`"${file}" ${args}`, { env: { ...clean, ...extra }, encoding: "utf8", shell: true });
    const lastReport = () => JSON.parse(readFileSync(reports, "utf8").trim().split("\n").at(-1)!);
    expect(run(files[0]!, "status --json").status).toBe(0);
    expect(lastReport()).toEqual({ state: join(prefix, "state"), instance: "wraptest", port: "7999", args: ["status", "--json"] });
    run(files[0]!, "pair", { ATTACHE_PORT: "8001" });
    expect(lastReport()).toMatchObject({ state: join(prefix, "state"), port: "8001", args: ["pair"] });

    // The uninstaller removes the wrapper that started it; its exit status still comes through.
    const uninstall = run(files[1]!, "--delete-data");
    // The batch file's own variables end with it, so the install, its state folder and instance go as options.
    const { args } = lastReport();
    expect(args).toEqual(["uninstall", "--prefix", expect.any(String), "--state-dir", expect.any(String), "--instance", "wraptest", "--delete-data"]);
    expect([resolve(args[2]), resolve(args[4])]).toEqual([prefix, join(prefix, "state")]);
    expect(uninstall.stderr).toBe("");
    expect(uninstall.status).toBe(3);

    attache(["wrappers", "uninstall", "--prefix", prefix], { env });
    expect(files.some((f) => existsSync(f))).toBe(false);
  });
});

describe("clearing stored credentials on uninstall", () => {
  it("removes every secret this install stored", () => {
    const state = tempDir("attache-credentials-");
    writeFileSync(join(state, "secrets.json"), JSON.stringify({ "github:token": "ghp_example", "slack:token": "xoxb-example" }), { mode: 0o600 });
    const r = attache(["credentials", "clear", "--state-dir", state]);
    expect(JSON.parse(r.stdout)).toEqual({ store: "file", removed: 2 });
    // The file goes once it holds nothing.
    expect(existsSync(join(state, "secrets.json"))).toBe(false);
  });
});

describe("clearing stale writer locks on uninstall", () => {
  /** The pid of a process that has come and gone. */
  const gonePid = () => spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;

  it("removes the locks of services that are gone, and keeps those a live process holds or that cannot be read", () => {
    const locks = tempDir("attache-locks-");
    const lock = (name: string, content: string) => writeFileSync(join(locks, name), content);
    const record = (pid: number | string) => JSON.stringify({ pid: Number(pid), instance: "default", dataFolder: "/data", at: "2026-11-11T00:00:00.000Z" });
    lock("0123456789abcdef0123456789abcdef.lock", record(gonePid()));
    lock("11111111111111111111111111111111.lock", record(process.pid));
    lock("22222222222222222222222222222222.lock", "");
    lock("notes.txt", record(gonePid()));
    const r = attache(["locks", "clear-stale", "--locks-dir", locks]);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ removed: 1, kept: 2 });
    expect(readdirSync(locks).sort()).toEqual(["11111111111111111111111111111111.lock", "22222222222222222222222222222222.lock", "notes.txt"]);
  });

  it("does nothing when there is no locks folder", () => {
    const r = attache(["locks", "clear-stale", "--locks-dir", join(tempDir("attache-locks-"), "missing")]);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ removed: 0, kept: 0 });
  });
});

describe("what a data-deleting uninstall may remove", () => {
  const configDb = (state: string, config: unknown) => {
    const db = new DatabaseSync(join(state, "attache.sqlite"));
    db.exec("create table config (id integer primary key, json text not null)");
    db.prepare("insert into config (id, json) values (1, ?)").run(JSON.stringify(config));
    db.close();
  };

  it("names the data folder and only the entries Attache created in it", () => {
    const state = tempDir("attache-owned-state-");
    const data = tempDir("attache-owned-data-");
    mkdirSync(join(data, ".attache"));
    writeFileSync(join(data, ".attache/owned.json"), JSON.stringify({ createdFolder: false, created: ["memory", "README.md", "../outside", "/etc"] }));
    configDb(state, { dataFolder: data });
    const r = attache(["data-folder", "--state-dir", state]);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({ dataFolder: data, createdFolder: false, created: ["memory", "README.md"] });
  });

  it("names no data folder when the service never chose one", () => {
    const r = attache(["data-folder", "--state-dir", tempDir("attache-owned-empty-")]);
    expect(JSON.parse(r.stdout)).toEqual({ dataFolder: null, createdFolder: false, created: [] });
  });

  it("fails with the reason when the service database cannot be read, instead of naming no folder", () => {
    const state = tempDir("attache-owned-broken-");
    writeFileSync(join(state, "attache.sqlite"), "not a database");
    const r = attache(["data-folder", "--state-dir", state]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^attache: could not read the data folder from .*attache\.sqlite: /);
  });
});

describe("the background service", () => {
  describe.skipIf(process.platform === "win32")("on Linux", () => {
    const linux = (args: string[], env: Record<string, string | undefined>, systemctl: { bin: string }) => attache(args, { platform: "linux", env: { ...env, PATH: `${systemctl.bin}:${process.env.PATH}`, XDG_CONFIG_HOME: undefined } });

    it("is a systemd user service that starts at login, restarts after a crash and runs the bundled runtime through the stable `current` link", () => {
      const systemctl = fakeSystemctl();
      const home = tempDir("attache-systemd-home-");
      const instance = `svctest${process.pid}`;
      const env = { HOME: home, ATTACHE_INSTANCE: instance };
      const unitName = `attache-${instance}.service`;
      const unit = join(home, ".config/systemd/user", unitName);
      const r = linux(["service", "install", "--prefix", "/opt/Attache 100% $Test", "--state-dir", "/opt/Attache 100% $Test/state", "--port", "7998"], env, systemctl);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe(`Attache background service ${unitName} set up in ${unit}.\n`);

      const text = readFileSync(unit, "utf8");
      // systemd expands `%` specifiers everywhere and `$` variables in ExecStart, so both are doubled.
      expect(text).toContain('ExecStart="/opt/Attache 100%% $$Test/current/runtime/node" "/opt/Attache 100%% $$Test/current/service/attache-service.mjs" serve --port 7998\n');
      expect(text).toContain('Environment="ATTACHE_STATE_DIR=/opt/Attache 100%% $Test/state"\n');
      expect(text).toContain(`Environment="ATTACHE_INSTANCE=${instance}"\n`);
      expect(text).toContain('Environment="ATTACHE_WEB_DIR=/opt/Attache 100%% $Test/current/web"\n');
      expect(text).toContain(`Environment="HOME=${home}"\n`);
      expect(text).toContain("StandardError=append:/opt/Attache 100%% $Test/state/logs/service.err.log\n");
      expect(text).toMatch(/\nRestart=always\n/);
      // A service that refused to start, such as on a database a newer Attache wrote, is not started again and again.
      expect(text).toMatch(/\nRestartPreventExitStatus=78\n/);
      expect(text).toMatch(/\[Install\]\nWantedBy=default\.target\n/);
      // Installing enables it for the next login, without starting it yet.
      expect(systemctl.state()).toEqual({ enabled: [unitName], active: [] });
      expect(JSON.parse(linux(["service", "status"], env, systemctl).stdout)).toEqual({ name: unitName, definition: unit, loaded: false });

      expect(linux(["start"], env, systemctl).stderr).toBe("");
      expect(JSON.parse(linux(["service", "status"], env, systemctl).stdout)).toMatchObject({ loaded: true });
      expect(linux(["stop"], env, systemctl).stderr).toBe("");
      expect(JSON.parse(linux(["service", "status"], env, systemctl).stdout)).toMatchObject({ loaded: false });

      linux(["start"], env, systemctl);
      const removed = linux(["service", "uninstall"], env, systemctl);
      expect(removed.stderr).toBe("");
      expect(existsSync(unit)).toBe(false);
      expect(systemctl.state()).toEqual({ enabled: [], active: [] });
    });

    it("starts a service that systemd stopped restarting after it crashed too often, as after an Update that rolled back", () => {
      const systemctl = fakeSystemctl();
      const home = tempDir("attache-systemd-home-");
      const instance = `limit${process.pid}`;
      const env = { HOME: home, ATTACHE_INSTANCE: instance };
      const unitName = `attache-${instance}.service`;
      expect(linux(["service", "install", "--prefix", join(home, "attache"), "--state-dir", join(home, "state"), "--port", "7998"], env, systemctl).stderr).toBe("");
      systemctl.hitStartLimit(unitName);

      const r = linux(["start"], env, systemctl);
      expect(r.stderr).toBe("");
      expect(systemctl.state().active).toEqual([unitName]);
    });

    it("passes on the release feed address the installer was given, so a test's service reads its releases there", () => {
      const home = tempDir("attache-systemd-home-");
      const unitText = (extra: Record<string, string>) => {
        const systemctl = fakeSystemctl();
        const env = { HOME: home, ATTACHE_INSTANCE: `feed${process.pid}`, ...extra };
        expect(linux(["service", "install", "--prefix", join(home, "attache"), "--state-dir", join(home, "state"), "--port", "7998"], env, systemctl).stderr).toBe("");
        return readFileSync(join(home, ".config/systemd/user", `attache-feed${process.pid}.service`), "utf8");
      };
      expect(unitText({ ATTACHE_RELEASE_FEED_URL: "http://127.0.0.1:9/releases?x=100%" })).toContain('Environment="ATTACHE_RELEASE_FEED_URL=http://127.0.0.1:9/releases?x=100%%"\n');
      expect(unitText({})).not.toContain("ATTACHE_RELEASE_FEED_URL");
    });

    it("runs in the XDG base folders the installer saw, never the user manager's own", () => {
      const home = tempDir("attache-systemd-home-");
      const unitText = (xdg: Record<string, string | undefined>) => {
        const systemctl = fakeSystemctl();
        const env = { HOME: home, ATTACHE_INSTANCE: `xdg${process.pid}`, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, ...xdg };
        expect(linux(["service", "install", "--prefix", join(home, "attache"), "--state-dir", join(home, "state"), "--port", "7998"], env, systemctl).stderr).toBe("");
        return readFileSync(join(home, ".config/systemd/user", `attache-xdg${process.pid}.service`), "utf8");
      };
      // Where the installer put the unit, the release and the state is where the service, and an installer it starts for an Update, look too.
      const pinned = unitText({ XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "st") });
      expect(pinned).toContain(`Environment="XDG_DATA_HOME=${join(home, "data")}"\n`);
      expect(pinned).toContain(`Environment="XDG_STATE_HOME=${join(home, "st")}"\n`);
      expect(pinned).toContain("UnsetEnvironment=XDG_CONFIG_HOME\n");
      expect(unitText({})).toContain("UnsetEnvironment=XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME\n");
    });

    it("says what to do when there is no systemd user session to register with", () => {
      const systemctl = fakeSystemctl({ noUserSession: true });
      const home = tempDir("attache-systemd-home-");
      const r = linux(["service", "install", "--prefix", join(home, "attache"), "--state-dir", join(home, "state"), "--port", "7998"], { HOME: home, ATTACHE_INSTANCE: "nosession" }, systemctl);
      expect(r.stderr).toBe(
        "attache: Attache runs as a systemd user service, and systemd could not be reached for this user (Failed to connect to bus: No medium found). Run the installer from your own desktop or SSH login, or turn on lingering with `loginctl enable-linger`, then try again.\n",
      );
      expect(r.status).toBe(1);
    });
  });

  it.runIf(process.platform === "darwin")("is set up as a LaunchAgent that runs the bundled runtime through the stable `current` link, and removed again", () => {
    const home = tempDir("attache-launchd-home-");
    const instance = `svctest${process.pid}`;
    const env = { HOME: home, ATTACHE_INSTANCE: instance };
    const plist = join(home, "Library/LaunchAgents", `dev.attache.${instance}.plist`);
    const r = attache(["service", "install", "--prefix", "/opt/Attache Test", "--state-dir", "/opt/Attache Test/state", "--port", "7998"], { env });
    expect(r.stderr).toBe("");
    const text = readFileSync(plist, "utf8");
    for (const s of ["<string>/opt/Attache Test/current/runtime/node</string>", "<string>/opt/Attache Test/current/service/attache-service.mjs</string>", "<string>7998</string>", `<key>ATTACHE_INSTANCE</key><string>${instance}</string>`, "<key>RunAtLoad</key><true/>"]) expect(text).toContain(s);
    // Kept running unless it refused to start, such as on a database a newer Attache wrote: launchd cannot tell exit codes apart, so the service leaves a file.
    expect(text).toContain("<key>KeepAlive</key><dict><key>PathState</key><dict><key>/opt/Attache Test/state/refused-to-start</key><false/></dict></dict>");
    expect(text).not.toContain("ATTACHE_RELEASE_FEED_URL");
    expect(JSON.parse(attache(["service", "status"], { env }).stdout)).toMatchObject({ loaded: false, definition: plist });
    // The release feed address an installer was given goes to the service, so a test's service reads its releases there.
    attache(["service", "install", "--prefix", "/opt/Attache Test", "--state-dir", "/opt/Attache Test/state", "--port", "7998"], { env: { ...env, ATTACHE_RELEASE_FEED_URL: "http://127.0.0.1:9/releases?a=1&b=2" } });
    expect(readFileSync(plist, "utf8")).toContain("<key>ATTACHE_RELEASE_FEED_URL</key><string>http://127.0.0.1:9/releases?a=1&amp;b=2</string>");
    const removed = attache(["service", "uninstall"], { env });
    expect(removed.stderr).toBe("");
    expect(existsSync(plist)).toBe(false);
  });
});
