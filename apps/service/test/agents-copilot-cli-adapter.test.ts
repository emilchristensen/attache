import { beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks, mcpServerEntry } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";
import { locationsForHome } from "../src/platform/locations.ts";
import { writeContextFiles } from "../src/agents/context-files.ts";
import { spawn, spawnSync } from "node:child_process";
import { listSpool, spoolCopyPath } from "../src/agents/spool.ts";
import { parseCopilotCli } from "../src/agents/copilot-cli-transcript.ts";
import { assistant, events, start, user } from "./fixtures/agents/copilot-cli.ts";

/**
 * Copilot CLI through its personal MCP configuration: Attache adds this
 * instance's MCP server to `~/.copilot/mcp-config.json` (or
 * `$COPILOT_HOME/mcp-config.json`) and changes nothing else in it. Fixture
 * tests against real files in a temporary home.
 */

let home: string;
let stateDir: string;
let backups: string;
const at = (...rel: string[]) => join(home, ...rel);
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const CONFIG = () => at(".copilot/mcp-config.json");
const SETTINGS = () => at(".copilot/settings.json");
/** This instance's personal hooks file: one file per instance in Copilot CLI's personal hooks folder. */
const HOOKS = (state = stateDir) => at(".copilot/hooks", `${nameOf(state)}.json`);
const HOOKS_PURPOSE = "Attache's personal Copilot CLI hooks that give each new, cleared or resumed session your current Attache memory and save the conversation after each turn, before compaction and when the session ends";
const read = (p = CONFIG()) => JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
const copilotFor = (state: string) => harnessAdapters(new AgentHooks(state, backups), () => "").find((a) => a.kind === "copilot-cli")!;
const copilot = () => copilotFor(stateDir);
/** The entry Copilot CLI starts this instance's MCP server from, as Copilot's docs describe a local server. */
const expectedEntry = (state = stateDir) => ({ type: "local", ...mcpServerEntry(state), tools: ["*"] });
const nameOf = (state = stateDir) => new AgentHooks(state, backups).ownerKey();
const OTHER = { type: "local", command: "npx", args: ["@playwright/mcp@latest"], tools: ["*"] };

beforeEach(() => {
  home = tempDir("attache-copilot-home-");
  stateDir = tempDir("attache-copilot-state-");
  backups = tempDir("attache-copilot-backups-");
  process.env.ATTACHE_AGENT_HOME = home;
  delete process.env.COPILOT_HOME;
  process.env.ATTACHE_COPILOT_BIN = join(home, "no-copilot-here");
});

describe("previewing Copilot CLI", () => {
  it("reports MCP access, runtime-fresh memory, capture with a final event, a restart, and the two personal files it would create", () => {
    const a = copilot();
    expect(a.label).toBe("Copilot CLI");
    expect(a.capabilities).toEqual({ mcp: true, memory: "runtime-fresh", capture: "with-final-event" });
    expect(a.setupNote).toMatch(/only a Copilot CLI that is killed or crashes mid-turn can lose that newest turn/);
    expect(a.manualSetup).toBe(true);
    expect(a.preview()).toEqual({
      restartRequired: true,
      changes: [
        { path: CONFIG(), change: "create", backup: false, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" },
        { path: HOOKS(), change: "create", backup: false, purpose: HOOKS_PURPOSE },
      ],
    });
    expect(existsSync(at(".copilot"))).toBe(false);
  });
});

describe("connecting Copilot CLI", () => {
  it("writes this instance's MCP server under the instance's name, and connecting again changes nothing", () => {
    const r = copilot().apply();
    expect(r.backups).toEqual([]);
    expect(read()).toEqual({ mcpServers: { [nameOf()]: expectedEntry() } });
    expect(copilot().status().state).toBe("current");
    const again = copilot().apply();
    expect(again.changes).toEqual([]);
    expect(copilot().preview().changes).toEqual([]);
    expect(readdirSync(backups)).toEqual([]);
  });
});

describe("the owner's own configuration", () => {
  it("keeps the owner's other servers and settings, and backs the file up before changing it", () => {
    const before = JSON.stringify({ mcpServers: { playwright: OTHER }, someSetting: true }, null, 2);
    write(CONFIG(), before);
    expect(copilot().preview().changes[0]).toEqual({ path: CONFIG(), change: "update", backup: true, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" });
    const r = copilot().apply();
    expect(read()).toEqual({ mcpServers: { playwright: OTHER, [nameOf()]: expectedEntry() }, someSetting: true });
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(before);
  });

  it("reads a file with comments and trailing commas, as Copilot CLI does, says the comments go, and keeps them in the backup", () => {
    const before = '{\n  // my servers\n  "mcpServers": {\n    "playwright": { "type": "local", "command": "npx", "args": ["@playwright/mcp@latest"], "tools": ["*"] },\n  },\n}\n';
    write(CONFIG(), before);
    expect(copilot().preview().changes[0]!.purpose).toMatch(/written back as plain JSON.*comments are kept only in the backup/);
    const r = copilot().apply();
    expect(read()).toEqual({ mcpServers: { playwright: OTHER, [nameOf()]: expectedEntry() } });
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(before);
    expect(copilot().status().state).toBe("current");
  });

  it("uses COPILOT_HOME instead of ~/.copilot when the service has it set", () => {
    const elsewhere = tempDir("attache-copilot-elsewhere-");
    process.env.COPILOT_HOME = elsewhere;
    try {
      copilot().apply();
      expect(read(join(elsewhere, "mcp-config.json")).mcpServers).toEqual({ [nameOf()]: expectedEntry() });
      expect(existsSync(at(".copilot"))).toBe(false);
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });
});

describe("repairing a stale entry", () => {
  it("replaces this instance's out-of-date entry, under whatever name, and leaves the rest", () => {
    copilot().apply();
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER, "old-name": { command: "/old/node", args: ["/old/attache.js", "mcp", "--state-dir", stateDir] } } }));
    expect(copilot().status().state).toBe("stale");
    const r = copilot().refresh();
    expect(r.changes).toEqual([expect.objectContaining({ path: CONFIG(), change: "update", backup: true })]);
    expect(read().mcpServers).toEqual({ playwright: OTHER, [nameOf()]: expectedEntry() });
    expect(copilot().status().state).toBe("current");
    expect(copilot().refresh().changes).toEqual([]);
  });

  it("repairs an entry under its own name whose command or tools are out of date", () => {
    const { tools: _tools, ...withoutTools } = expectedEntry();
    write(CONFIG(), JSON.stringify({ mcpServers: { [nameOf()]: withoutTools } }));
    expect(copilot().status().state).toBe("stale");
    copilot().apply();
    expect(read().mcpServers).toEqual({ [nameOf()]: expectedEntry() });
  });

  it("an entry with fields Copilot CLI adds itself (empty env and headers, its own type) is current, and nothing is rewritten", () => {
    copilot().apply();
    write(CONFIG(), JSON.stringify({ mcpServers: { [nameOf()]: { ...expectedEntry(), type: "stdio", env: {}, headers: {} } } }));
    const before = readFileSync(CONFIG(), "utf8");
    expect(copilot().status().state).toBe("current");
    expect(copilot().refresh()).toMatchObject({ changes: [], backups: [] });
    expect(readFileSync(CONFIG(), "utf8")).toBe(before);
  });

  it("reports missing, with no file named, when the entry and the hook were removed, and stale when only one was", () => {
    copilot().apply();
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER } }));
    expect(copilot().status()).toMatchObject({ state: "stale", message: expect.stringMatching(/MCP server is not in/), files: [HOOKS()] });
    rmSync(HOOKS());
    expect(copilot().status()).toMatchObject({ state: "missing", files: [] });
  });
});

describe("several Attache instances", () => {
  it("keeps each instance's entry, and disconnecting one leaves the other", () => {
    const second = tempDir("attache-copilot-state2-");
    copilot().apply();
    copilotFor(second).apply();
    expect(Object.keys(read().mcpServers!).sort()).toEqual([nameOf(), nameOf(second)].sort());
    expect(copilot().status().state).toBe("current");
    expect(copilotFor(second).status().state).toBe("current");
    expect(existsSync(HOOKS())).toBe(true);
    expect(existsSync(HOOKS(second))).toBe(true);
    const r = copilotFor(second).uninstall();
    expect(r).toEqual({
      removed: [
        { path: CONFIG(), change: "update", backup: true, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" },
        { path: HOOKS(second), change: "remove", backup: false, purpose: HOOKS_PURPOSE },
      ],
      failures: [],
    });
    expect(read().mcpServers).toEqual({ [nameOf()]: expectedEntry() });
    expect(existsSync(HOOKS(second))).toBe(false);
    expect(existsSync(HOOKS())).toBe(true);
    expect(copilot().status().state).toBe("current");
  });
});

describe("refusing what Attache must not change", () => {
  const refuses = (pattern: RegExp) => {
    expect(() => copilot().preview()).toThrow(pattern);
    expect(() => copilot().apply()).toThrow(pattern);
    expect(copilot().status()).toMatchObject({ state: "failed", message: expect.stringMatching(pattern) });
  };

  it.each([
    ["not JSON", "{ nope", /mcp-config\.json is not valid JSON/],
    ["not an object", "[1, 2]", /mcp-config\.json does not contain a JSON object/],
    ["a server list that is not an object", '{ "mcpServers": [] }', /mcpServers` value that is not an object/],
  ])("a configuration that is %s, naming it, and writes nothing", (_, text, pattern) => {
    write(CONFIG(), text);
    refuses(pattern);
    expect(readFileSync(CONFIG(), "utf8")).toBe(text);
    expect(readdirSync(backups)).toEqual([]);
  });

  it("a server under this instance's name that Attache did not add", () => {
    const text = JSON.stringify({ mcpServers: { [nameOf()]: OTHER } });
    write(CONFIG(), text);
    expect(() => copilot().apply()).toThrow(/already has an MCP server named .* that Attache did not add/);
    expect(readFileSync(CONFIG(), "utf8")).toBe(text);
  });

  it("settings.json that does not parse, or that turns this instance's server off", () => {
    write(SETTINGS(), "{ nope");
    refuses(/settings\.json is not valid JSON/);
    write(SETTINGS(), '{\n  // mine\n  "disabledMcpServers": ["' + nameOf() + '"],\n}');
    refuses(/turns off the MCP server .*copilot mcp enable/);
    expect(existsSync(CONFIG())).toBe(false);
    write(SETTINGS(), JSON.stringify({ disabledMcpServers: ["playwright"] }));
    expect(copilot().apply().changes).toHaveLength(2);
  });
});

describe("disconnecting Copilot CLI", () => {
  it("removes only this instance's entry, backs the file up, and changes nothing when there is none", () => {
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER }, someSetting: 1 }));
    copilot().apply();
    const r = copilot().uninstall();
    expect(r.failures).toEqual([]);
    expect(r.removed.map((c) => [c.path, c.change])).toEqual([[CONFIG(), "update"], [HOOKS(), "remove"]]);
    expect(read()).toEqual({ mcpServers: { playwright: OTHER }, someSetting: 1 });
    expect(existsSync(HOOKS())).toBe(false);
    const text = readFileSync(CONFIG(), "utf8");
    expect(copilot().uninstall()).toEqual({ removed: [], failures: [] });
    expect(readFileSync(CONFIG(), "utf8")).toBe(text);
  });

  it("does nothing when there is no configuration, and reports a configuration it cannot read", () => {
    expect(copilot().uninstall()).toEqual({ removed: [], failures: [] });
    write(CONFIG(), "{ nope");
    const r = copilot().uninstall();
    expect(r.removed).toEqual([]);
    expect(r.failures).toEqual([expect.stringMatching(/Could not remove Attache's MCP server from .*mcp-config\.json/)]);
    expect(readFileSync(CONFIG(), "utf8")).toBe("{ nope");
  });

  it("removes its entry even when settings.json is broken", () => {
    copilot().apply();
    write(SETTINGS(), "{ nope");
    expect(copilot().uninstall().removed).toHaveLength(2);
    expect(read().mcpServers).toBeUndefined();
  });
});

describe("detecting Copilot CLI", () => {
  it("finds the folder gh copilot downloads it to, and does not count ~/.copilot alone", () => {
    mkdirSync(at(".copilot"), { recursive: true });
    // The Machine's own tool folders are looked in too, so the negative holds only where they have no copilot.
    if (!locationsForHome(home).toolDirs.some((d) => existsSync(join(d, "copilot")))) expect(copilot().detect(home)).toBe(false);
    mkdirSync(at(".local/share/gh/copilot"), { recursive: true });
    expect(copilot().detect(home)).toBe(true);
  });

  it("finds an executable in ~/.local/bin, where its install script puts it", () => {
    write(at(".local/bin", process.platform === "win32" ? "copilot.exe" : "copilot"), "");
    expect(copilot().detect(home)).toBe(true);
  });
});

/** The hooks file as Copilot CLI reads it. */
const hooksFile = (state = stateDir) => JSON.parse(readFileSync(HOOKS(state), "utf8")) as { version: number; hooks: Record<string, Array<Record<string, unknown>>> };

/**
 * Run this instance's session-start hook the way Copilot CLI's hooks reference describes: the `bash`
 * command through bash, the camelCase sessionStart input on stdin; stdout is one JSON object.
 */
function runSessionStart(input: Record<string, unknown>, state = stateDir): { status: number | null; stdout: string } {
  const command = hooksFile(state).hooks.sessionStart![0]!.bash as string;
  const r = spawnSync("bash", ["-c", command], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_INVOKED_BY: "", ATTACHE_AGENT_HOOK_DISABLED: "" } });
  return { status: r.status, stdout: r.stdout };
}
const sessionStart = (source: string, cwd = home) => ({ sessionId: "4a7e329c-e982-4165-97f7-bc66fa9111f0", timestamp: 1795189600883, cwd, source, initialPrompt: "first question" });

describe.skipIf(process.platform === "win32")("Attache memory in Copilot CLI sessions", () => {
  it("writes one personal hooks file with a sessionStart command hook, in the documented shape", () => {
    copilot().apply();
    const file = hooksFile();
    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks)).toContain("sessionStart");
    expect(file.hooks.sessionStart).toEqual([{ type: "command", bash: expect.stringContaining("attache-agent-hook"), powershell: expect.stringMatching(/^& '.*attache-agent-hook.*' copilot-cli session-start --state-dir '/), timeoutSec: 10 }]);
    expect(file.hooks.sessionStart![0]!.bash).toContain(" copilot-cli session-start --state-dir ");
  });

  it("the hook prints the current memory as additionalContext, read fresh for every new, cleared or resumed session", () => {
    copilot().apply();
    writeContextFiles(stateDir, "Ada prefers short answers.", []);
    const first = runSessionStart(sessionStart("new"));
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ additionalContext: "<attache-memory>\nAda prefers short answers.\n</attache-memory>" });
    writeContextFiles(stateDir, "Ada now prefers detailed answers.", []);
    for (const source of ["resume", "new", "startup"]) {
      expect(JSON.parse(runSessionStart(sessionStart(source)).stdout)).toEqual({ additionalContext: "<attache-memory>\nAda now prefers detailed answers.\n</attache-memory>" });
    }
  });

  it("the hook prints nothing, which Copilot CLI treats as no context, when there is no memory", () => {
    copilot().apply();
    expect(runSessionStart(sessionStart("new"))).toEqual({ status: 0, stdout: "" });
  });

  it("each instance's hook gives that instance's memory", () => {
    const second = tempDir("attache-copilot-state2-");
    copilot().apply();
    copilotFor(second).apply();
    writeContextFiles(stateDir, "first instance", []);
    writeContextFiles(second, "second instance", []);
    expect(JSON.parse(runSessionStart(sessionStart("new")).stdout).additionalContext).toMatch(/first instance/);
    expect(JSON.parse(runSessionStart(sessionStart("new"), second).stdout).additionalContext).toMatch(/second instance/);
  });
});

describe("the owner's personal hooks", () => {
  const OWN_HOOKS = JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "echo '{}'", timeoutSec: 5 }], agentStop: [{ type: "command", bash: "true" }] } }, null, 2);

  it("never opens the owner's own hooks files, on connect, reconnect or disconnect", () => {
    const own = at(".copilot/hooks/mine.json");
    write(own, OWN_HOOKS);
    copilot().apply();
    copilot().apply();
    copilot().uninstall();
    expect(readFileSync(own, "utf8")).toBe(OWN_HOOKS);
    expect(readdirSync(at(".copilot/hooks"))).toEqual(["mine.json"]);
  });

  it("refuses a file it did not write at its own path, and leaves it on disconnect", () => {
    write(HOOKS(), OWN_HOOKS);
    expect(() => copilot().preview()).toThrow(/hooks[\\/]attache(-[0-9a-f]{8})?\.json exists and was not written by this Attache/);
    expect(() => copilot().apply()).toThrow(/was not written by this Attache/);
    expect(copilot().status().state).toBe("failed");
    expect(existsSync(CONFIG())).toBe(false);
    expect(copilot().uninstall()).toEqual({ removed: [], failures: [] });
    expect(readFileSync(HOOKS(), "utf8")).toBe(OWN_HOOKS);
  });

  it("repairs its own out-of-date hooks file, backing it up, and connecting again changes nothing", () => {
    copilot().apply();
    const old = readFileSync(HOOKS(), "utf8").replace(/"timeoutSec": 10/, '"timeoutSec": 30');
    write(HOOKS(), old);
    expect(copilot().status()).toMatchObject({ state: "stale", message: expect.stringMatching(/hooks file .* is out of date/) });
    const r = copilot().refresh();
    expect(r.changes).toEqual([{ path: HOOKS(), change: "update", backup: true, purpose: HOOKS_PURPOSE }]);
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(old);
    expect(copilot().status().state).toBe("current");
    expect(copilot().apply().changes).toEqual([]);
  });

  it("puts the hooks file in COPILOT_HOME when the service has it set", () => {
    const elsewhere = tempDir("attache-copilot-elsewhere-");
    process.env.COPILOT_HOME = elsewhere;
    try {
      copilot().apply();
      expect(existsSync(join(elsewhere, "hooks", `${nameOf()}.json`))).toBe(true);
    } finally {
      delete process.env.COPILOT_HOME;
    }
  });

  it("refuses when settings.json turns off all hooks, and writes nothing", () => {
    write(SETTINGS(), '{ "disableAllHooks": true }');
    expect(() => copilot().apply()).toThrow(/turns off all hooks \(disableAllHooks\)/);
    expect(copilot().status()).toMatchObject({ state: "failed" });
    expect(existsSync(CONFIG())).toBe(false);
    expect(existsSync(HOOKS())).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the installed Copilot CLI's version", () => {
  const fakeCopilot = (output: string, code = 0) => {
    const bin = at("bin", "copilot");
    write(bin, `#!/bin/sh\necho '${output}'\nexit ${code}\n`);
    chmodSync(bin, 0o755);
    process.env.ATTACHE_COPILOT_BIN = bin;
  };

  it("refuses one older than 1.0.22, whose session-start hooks Copilot CLI would not inject once per session", () => {
    fakeCopilot("GitHub Copilot CLI 1.0.21.");
    expect(() => copilot().apply()).toThrow(/Copilot CLI 1\.0\.21 .* is too old .*copilot update/);
    expect(existsSync(CONFIG())).toBe(false);
  });

  it.each([["GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates."], ["GitHub Copilot CLI 1.0.22."], ["GitHub Copilot CLI 1.1.0."]])("connects with %s", (output) => {
    fakeCopilot(output);
    expect(copilot().apply().changes).toHaveLength(2);
  });

  it("a status check never waits for copilot --version", () => {
    const bin = at("bin", "copilot");
    write(bin, "#!/bin/sh\nsleep 3\necho 'GitHub Copilot CLI 1.0.114.'\n");
    chmodSync(bin, 0o755);
    process.env.ATTACHE_COPILOT_BIN = bin;
    const t0 = Date.now();
    copilot().status();
    copilot().refresh();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("connects when the version cannot be read, since Copilot CLI updates itself", () => {
    fakeCopilot("garbled");
    expect(copilot().apply().changes).toHaveLength(2);
  });
});

describe.skipIf(process.platform === "win32")("saving Copilot CLI sessions", () => {
  const ID = "6128c6ac-b9e7-479c-acc8-6918e02e109b";
  const work = () => at("work");
  const eventsPath = (root = at(".copilot"), id = ID) => join(root, "session-state", id, "events.jsonl");
  /** The hook.start event Copilot CLI writes for a hook run, carrying the hook's own input. */
  const hookStart = (hookType: string, input: Record<string, unknown>) => JSON.stringify({ id: `h-${hookType}`, timestamp: "2026-11-21T20:50:32.000Z", parentId: null, type: "hook.start", data: { hookInvocationId: "x", hookType, input } });
  const session = (lines: string[]) => [...lines.map((l) => `${l}\n`)].join("");
  const BEFORE = events([start(0), user("Should the cutover wait for the audit?", 1), assistant("Yes, until Friday.", 2)]).trim().split("\n");
  const stopInput = (extra: Record<string, unknown> = {}) => ({ sessionId: ID, timestamp: 1795294232036, cwd: work(), transcriptPath: eventsPath(), stopReason: "end_turn", stop_hook_active: false, ...extra });
  const spooled = () => listSpool(stateDir).map((r) => ({ event: r.event, agent: r.agent, sessionId: r.sessionId, cwd: r.cwd, text: r.copy ? readFileSync(spoolCopyPath(stateDir, r)!, "utf8") : null, error: r.error ?? null }));

  /** Run one of the hooks file's commands the way Copilot CLI does, with its input on stdin, without blocking this process. */
  function runHookCommand(hookType: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; ms: number }> {
    const command = hooksFile().hooks[hookType]![0]!.bash as string;
    const t0 = Date.now();
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { env: { ...process.env, HOME: home, CLAUDE_INVOKED_BY: "", ATTACHE_AGENT_HOOK_DISABLED: "", ...env } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.on("close", (status) => resolve({ status, stdout, ms: Date.now() - t0 }));
      child.stdin.end(JSON.stringify(input));
    });
  }

  beforeEach(() => {
    mkdirSync(work(), { recursive: true });
    copilot().apply();
    // The Agent sessions feature is on: the service keeps a session context.
    writeContextFiles(stateDir, "memory", []);
  });

  it("adds agentStop, preCompact and sessionEnd command hooks to the same personal hooks file", () => {
    const file = hooksFile();
    expect(Object.keys(file.hooks)).toEqual(["sessionStart", "agentStop", "preCompact", "sessionEnd"]);
    for (const [hookType, event] of [["agentStop", "turn-end"], ["preCompact", "pre-compact"], ["sessionEnd", "session-end"]] as const) {
      expect(file.hooks[hookType]).toEqual([{ type: "command", bash: expect.stringContaining(` copilot-cli ${event} --state-dir `), powershell: expect.stringContaining(` copilot-cli ${event} --state-dir '`), timeoutSec: 10 }]);
    }
  });

  it("a finished turn spools a copy of the session's events.jsonl once Copilot CLI has written the turn, and prints nothing", async () => {
    write(eventsPath(), session(BEFORE));
    // Copilot CLI writes the turn's events, and the hook's own hook.start after them, shortly after it starts the hook.
    const run = runHookCommand("agentStop", stopInput());
    setTimeout(() => writeFileSync(eventsPath(), session([...BEFORE, events([user("Check the env file", 3), assistant("Done.", 4)]).trim(), hookStart("agentStop", stopInput())])), 300);
    const r = await run;
    expect(r).toMatchObject({ status: 0, stdout: "" });
    const [record, ...rest] = spooled();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ event: "turn-end", agent: "copilot-cli", sessionId: ID, cwd: work() });
    expect(parseCopilotCli(record!.text!).turns.map((t) => t.text)).toEqual(["Should the cutover wait for the audit?", "Yes, until Friday.", "Check the env file", "Done."]);
  });

  it("a compaction spools the session before Copilot CLI compacts it", async () => {
    const input = { sessionId: ID, timestamp: 1795294297442, cwd: work(), transcriptPath: eventsPath(), trigger: "manual", customInstructions: "" };
    write(eventsPath(), session([...BEFORE, hookStart("preCompact", input)]));
    expect((await runHookCommand("preCompact", input)).status).toBe(0);
    expect(spooled().map((r) => [r.event, parseCopilotCli(r.text!).turns.length])).toEqual([["pre-compact", 2]]);
  });

  it("a session end, whose input names no transcript, finds events.jsonl in Copilot CLI's home folder", async () => {
    const input = { sessionId: ID, timestamp: 1795294310947, cwd: work(), reason: "user_exit" };
    write(eventsPath(), session([...BEFORE, hookStart("sessionEnd", input)]));
    expect((await runHookCommand("sessionEnd", input)).status).toBe(0);
    const elsewhere = tempDir("attache-copilot-home2-");
    write(eventsPath(elsewhere), session([...BEFORE, hookStart("sessionEnd", input)]));
    expect((await runHookCommand("sessionEnd", input, { COPILOT_HOME: elsewhere })).status).toBe(0);
    expect(spooled().map((r) => [r.event, r.error, parseCopilotCli(r.text!).turns.length])).toEqual([
      ["session-end", null, 2],
      ["session-end", null, 2],
    ]);
  });

  it("copies what is there when Copilot CLI never writes the hook's start (a session /clear ends), after a bounded wait", async () => {
    const input = { sessionId: ID, timestamp: 1, cwd: work(), reason: "user_exit" };
    write(eventsPath(), session(BEFORE));
    const r = await runHookCommand("sessionEnd", input);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(8_000);
    expect(spooled().map((x) => [x.event, parseCopilotCli(x.text!).turns.length])).toEqual([["session-end", 2]]);
  });

  it("never spools for a subagent's agentStop, which names the parent's events.jsonl", async () => {
    const input = stopInput({ sessionId: "3879bcc5-1220-473e-beb5-cdae729e1f0f", agentId: "3879bcc5-1220-473e-beb5-cdae729e1f0f", agentType: "explore", parentAgentId: ID });
    write(eventsPath(), session([...BEFORE, hookStart("agentStop", input)]));
    expect(await runHookCommand("agentStop", input)).toMatchObject({ status: 0, stdout: "" });
    expect(spooled()).toEqual([]);
  });

  it("spools nothing for sessions tools start on their own", async () => {
    write(eventsPath(), session([...BEFORE, hookStart("agentStop", stopInput())]));
    await runHookCommand("agentStop", stopInput(), { CLAUDE_INVOKED_BY: "sdk" });
    await runHookCommand("agentStop", stopInput(), { ATTACHE_AGENT_HOOK_DISABLED: "1" });
    expect(spooled()).toEqual([]);
  });
});
