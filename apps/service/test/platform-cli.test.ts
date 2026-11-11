import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const FAKE_PLATFORM = join(import.meta.dirname, "fixtures/fake-platform.mjs");

/** Run the `jarvis` executable from source, optionally as if on another operating system. */
function jarvis(args: string[], opts: { platform?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: tempDir("jarvis-cli-home-"), JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", ...opts.env };
  if (opts.platform) env.JARVIS_TEST_FAKE_PLATFORM = opts.platform;
  const r = spawnSync(process.execPath, ["--import", FAKE_PLATFORM, MAIN, ...args], { env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("paths and Harness locations per operating system", () => {
  const paths = (platform: string, env: Record<string, string | undefined>) => {
    const r = jarvis(["paths"], { platform, env: { JARVIS_STATE_DIR: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, XDG_CONFIG_HOME: undefined, LOCALAPPDATA: undefined, APPDATA: undefined, ...env } });
    expect(r.stderr).toBe("");
    return JSON.parse(r.stdout);
  };

  it("resolves the macOS locations the installer has always used", () => {
    const p = paths("darwin", { HOME: "/Users/owner" });
    expect(p).toMatchObject({
      os: "macos",
      installPrefix: "/Users/owner/Library/Application Support/Jarvis",
      stateDir: "/Users/owner/Library/Application Support/Jarvis/state",
      locksDir: "/Users/owner/Library/Application Support/Jarvis/locks",
      binDir: "/Users/owner/.local/bin",
      serviceDefinitionDir: "/Users/owner/Library/LaunchAgents",
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
      installPrefix: "/home/owner/.local/share/jarvis",
      stateDir: "/home/owner/.local/state/jarvis",
      locksDir: "/home/owner/.local/state/jarvis/locks",
      binDir: "/home/owner/.local/bin",
      serviceDefinitionDir: "/home/owner/.config/systemd/user",
      claudeManagedSettings: "/etc/claude-code/managed-settings.json",
    });
    const custom = paths("linux", { HOME: "/home/owner", XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/config" });
    expect(custom).toMatchObject({ installPrefix: "/data/jarvis", stateDir: "/state/jarvis", locksDir: "/home/owner/.local/state/jarvis/locks", serviceDefinitionDir: "/config/systemd/user" });
    expect(custom.harnesses.codex.executables).toEqual(["/home/owner/.local/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"]);
    expect(custom.harnesses["claude-desktop"]).toMatchObject({ mcpFile: ".config/Claude/claude_desktop_config.json", presence: ["/home/owner/.config/Claude"] });
  });

  it("resolves Windows locations under the owner's local application data", () => {
    const p = paths("win32", { USERPROFILE: "C:\\Users\\owner", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local", APPDATA: "C:\\Users\\owner\\AppData\\Roaming", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" });
    expect(p).toMatchObject({
      os: "windows",
      home: "C:\\Users\\owner",
      installPrefix: "C:\\Users\\owner\\AppData\\Local\\Jarvis",
      stateDir: "C:\\Users\\owner\\AppData\\Local\\Jarvis\\state",
      locksDir: "C:\\Users\\owner\\AppData\\Local\\Jarvis\\locks",
      binDir: "C:\\Users\\owner\\AppData\\Local\\Jarvis\\bin",
      serviceDefinitionDir: null,
      tar: "C:\\Windows\\System32\\tar.exe",
      claudeManagedSettings: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    });
    expect(p.harnesses.codex.executables).toEqual(["C:\\Users\\owner\\.local\\bin\\codex.exe", "C:\\Users\\owner\\.local\\bin\\codex.cmd", "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.exe", "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd"]);
    expect(p.harnesses["claude-code"].presence).toContain("C:\\Users\\owner\\.claude");
    expect(p.harnesses["claude-desktop"]).toMatchObject({ mcpFile: "AppData/Roaming/Claude/claude_desktop_config.json", presence: ["C:\\Users\\owner\\AppData\\Local\\AnthropicClaude", "C:\\Users\\owner\\AppData\\Roaming\\Claude"] });
  });

  it("prints a single location for installer scripts", () => {
    const r = jarvis(["paths", "installPrefix"], { platform: "darwin", env: { HOME: "/Users/owner" } });
    expect(r.stdout).toBe("/Users/owner/Library/Application Support/Jarvis\n");
  });
});

describe("an unsupported operating system", () => {
  const unsupported = "jarvis: Jarvis runs on macOS, Linux and Windows. This computer runs freebsd, which Jarvis does not support.\n";

  it("gets a clear message instead of a crash from the command line", () => {
    const r = jarvis(["status"], { platform: "freebsd", env: { JARVIS_STATE_DIR: undefined } });
    expect(r.stderr).toBe(unsupported);
    expect(r.status).toBe(1);
  });

  it("gets the same message when the service is asked to start, even with a state folder given", () => {
    const r = jarvis(["serve", "--port", "0"], { platform: "freebsd", env: { JARVIS_STATE_DIR: tempDir("jarvis-unsupported-") } });
    expect(r.stderr).toBe(unsupported);
    expect(r.status).toBe(1);
  });
});

describe("the command-line wrappers the installer puts on PATH", () => {
  it.skipIf(process.platform === "win32")("pin `jarvis` to the install and let `jarvis-uninstall` run the installed uninstaller", () => {
    const home = tempDir("jarvis-wrapper-home-");
    const prefix = join(home, "Jarvis Install");
    // A stand-in release that reports how it was called.
    mkdirSync(join(prefix, "current/bin"), { recursive: true });
    writeFileSync(join(prefix, "current/bin/jarvis"), '#!/bin/sh\necho "state=$JARVIS_STATE_DIR instance=$JARVIS_INSTANCE port=$JARVIS_PORT args=$*"\n', { mode: 0o755 });
    writeFileSync(join(prefix, "current/uninstall.sh"), 'echo "uninstall prefix=$JARVIS_PREFIX instance=$JARVIS_INSTANCE args=$*"\n');
    const env = { HOME: home, JARVIS_INSTANCE: "wraptest" };
    const installed = jarvis(["wrappers", "install", "--prefix", prefix, "--state-dir", join(prefix, "state"), "--port", "7999"], { env });
    expect(installed.stderr).toBe("");
    const bin = join(home, ".local/bin");
    expect(JSON.parse(installed.stdout)).toEqual([join(bin, "jarvis"), join(bin, "jarvis-uninstall")]);

    const clean = { PATH: "/usr/bin:/bin", HOME: home };
    expect(execFileSync(join(bin, "jarvis"), ["status", "--json"], { env: clean, encoding: "utf8" })).toBe(`state=${prefix}/state instance=wraptest port=7999 args=status --json\n`);
    expect(execFileSync(join(bin, "jarvis"), ["pair"], { env: { ...clean, JARVIS_PORT: "8001" }, encoding: "utf8" })).toBe(`state=${prefix}/state instance=wraptest port=8001 args=pair\n`);
    expect(execFileSync(join(bin, "jarvis-uninstall"), ["--delete-data"], { env: clean, encoding: "utf8" })).toBe(`uninstall prefix=${prefix} instance=wraptest args=--delete-data\n`);

    jarvis(["wrappers", "uninstall"], { env });
    expect(existsSync(join(bin, "jarvis")) || existsSync(join(bin, "jarvis-uninstall"))).toBe(false);
  });
});

describe("clearing stored credentials on uninstall", () => {
  it("removes every secret this install stored", () => {
    const state = tempDir("jarvis-credentials-");
    writeFileSync(join(state, "secrets.json"), JSON.stringify({ "github:token": "ghp_example", "slack:token": "xoxb-example" }), { mode: 0o600 });
    const r = jarvis(["credentials", "clear", "--state-dir", state]);
    expect(JSON.parse(r.stdout)).toEqual({ store: "file", removed: 2 });
    expect(readFileSync(join(state, "secrets.json"), "utf8")).not.toMatch(/ghp_example|xoxb-example/);
  });
});

describe("the background service", () => {
  it("explains that Linux and Windows cannot run it yet, instead of calling macOS tools", () => {
    for (const platform of ["linux", "win32"]) {
      const r = jarvis(["start"], { platform });
      expect(r.stderr).toMatch(/^jarvis: Running Jarvis as a background service is not available on (Linux|Windows) yet\. Run `jarvis serve` to start it in this terminal instead\.\n$/);
      expect(r.status).toBe(1);
    }
  });

  it.runIf(process.platform === "darwin")("is set up as a LaunchAgent that runs the bundled runtime through the stable `current` link, and removed again", () => {
    const home = tempDir("jarvis-launchd-home-");
    const instance = `svctest${process.pid}`;
    const env = { HOME: home, JARVIS_INSTANCE: instance };
    const plist = join(home, "Library/LaunchAgents", `dev.jarvis.${instance}.plist`);
    const r = jarvis(["service", "install", "--prefix", "/opt/Jarvis Test", "--state-dir", "/opt/Jarvis Test/state", "--port", "7998"], { env });
    expect(r.stderr).toBe("");
    const text = readFileSync(plist, "utf8");
    for (const s of ["<string>/opt/Jarvis Test/current/runtime/node</string>", "<string>/opt/Jarvis Test/current/service/jarvis-service.mjs</string>", "<string>7998</string>", `<key>JARVIS_INSTANCE</key><string>${instance}</string>`, "<key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/>"]) expect(text).toContain(s);
    expect(JSON.parse(jarvis(["service", "status"], { env }).stdout)).toMatchObject({ loaded: false, definition: plist });
    const removed = jarvis(["service", "uninstall"], { env });
    expect(removed.stderr).toBe("");
    expect(existsSync(plist)).toBe(false);
  });
});
