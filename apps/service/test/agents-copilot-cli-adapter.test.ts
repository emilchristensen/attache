import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks, mcpServerEntry } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";
import { locationsForHome } from "../src/platform/locations.ts";

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
});

describe("previewing Copilot CLI", () => {
  it("reports MCP access only, a restart, and the personal MCP configuration it would create", () => {
    const a = copilot();
    expect(a.label).toBe("Copilot CLI");
    expect(a.capabilities).toEqual({ mcp: true, memory: "none", capture: "none" });
    expect(a.manualSetup).toBe(true);
    expect(a.preview()).toEqual({
      restartRequired: true,
      changes: [{ path: CONFIG(), change: "create", backup: false, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" }],
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
    expect(copilot().preview().changes).toEqual([{ path: CONFIG(), change: "update", backup: true, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" }]);
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
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER, "old-name": { command: "/old/node", args: ["/old/attache.js", "mcp", "--state-dir", stateDir] } } }));
    expect(copilot().status().state).toBe("stale");
    const r = copilot().refresh();
    expect(r.changes).toEqual([expect.objectContaining({ change: "update", backup: true })]);
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

  it("reports missing, with no file named, when the entry was removed", () => {
    copilot().apply();
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER } }));
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
    const r = copilotFor(second).uninstall();
    expect(r).toEqual({ removed: [{ path: CONFIG(), change: "update", backup: true, purpose: "Attache's MCP server in Copilot CLI's personal MCP configuration" }], failures: [] });
    expect(read().mcpServers).toEqual({ [nameOf()]: expectedEntry() });
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
    expect(copilot().apply().changes).toHaveLength(1);
  });
});

describe("disconnecting Copilot CLI", () => {
  it("removes only this instance's entry, backs the file up, and changes nothing when there is none", () => {
    write(CONFIG(), JSON.stringify({ mcpServers: { playwright: OTHER }, someSetting: 1 }));
    copilot().apply();
    const r = copilot().uninstall();
    expect(r.failures).toEqual([]);
    expect(r.removed).toHaveLength(1);
    expect(read()).toEqual({ mcpServers: { playwright: OTHER }, someSetting: 1 });
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
    expect(copilot().uninstall().removed).toHaveLength(1);
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
