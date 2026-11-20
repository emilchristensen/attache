import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";
import { currentOs } from "../src/platform/os.ts";
import { harnessMcpConfigs } from "../src/platform/harness-locations.ts";

let home: string;
let stateDir: string;
let backups: string;
const at = (...rel: string[]) => join(home, ...rel);
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const MEMORY = "You are helping Ada. Orion cutover is planned for December.";

function adapters() {
  return harnessAdapters(new AgentHooks(stateDir, backups), () => MEMORY);
}
const adapter = (kind: string) => adapters().find((a) => a.kind === kind)!;

beforeEach(() => {
  home = tempDir("attache-adapter-home-");
  stateDir = tempDir("attache-adapter-state-");
  backups = tempDir("attache-adapter-backups-");
  process.env.ATTACHE_AGENT_HOME = home;
});

describe("previewing a Harness connection", () => {
  it("lists every file Claude Code's connection would change, and writes nothing", () => {
    write(at(".claude/settings.json"), JSON.stringify({ model: "opus" }));
    const preview = adapter("claude-code").preview();
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: at(".claude/settings.json"), change: "update", backup: true }),
        expect.objectContaining({ path: at(".claude.json"), change: "create", backup: false }),
      ]),
    );
    expect(preview.changes).toHaveLength(2);
    expect(readFileSync(at(".claude/settings.json"), "utf8")).toBe(JSON.stringify({ model: "opus" }));
    expect(existsSync(at(".claude.json"))).toBe(false);
  });
});

describe("connecting through the adapter", () => {
  it("applies what the preview listed, backs up the existing file, and reports the Harness current", () => {
    write(at(".claude/settings.json"), JSON.stringify({ model: "opus" }));
    const claude = adapter("claude-code");
    expect(claude.status().state).toBe("missing");
    const listed = claude.preview().changes.map((c) => c.path);
    const r = claude.apply();
    expect(r.changes.map((c) => c.path).sort()).toEqual(listed.sort());
    expect(r.backups).toHaveLength(1);
    expect(readdirSync(backups)).toHaveLength(1);
    expect(JSON.parse(readFileSync(at(".claude/settings.json"), "utf8")).model).toBe("opus");
    const status = claude.status();
    expect(status.state).toBe("current");
    expect(status.files.sort()).toEqual([at(".claude.json"), at(".claude/settings.json")].sort());
  });

  it("connecting again previews and changes nothing", () => {
    adapter("codex").apply();
    const before = readFileSync(at(".codex/config.toml"), "utf8");
    expect(adapter("codex").preview().changes).toEqual([]);
    expect(adapter("codex").apply()).toMatchObject({ changes: [], backups: [] });
    expect(readFileSync(at(".codex/config.toml"), "utf8")).toBe(before);
  });

  it("refuses a file it cannot parse before writing anything, and status reports it failed", () => {
    write(at(".claude/settings.json"), "{ not json");
    const claude = adapter("claude-code");
    expect(() => claude.preview()).toThrow(/settings\.json is not valid JSON.*Attache will not change it/);
    expect(() => claude.apply()).toThrow(/Attache will not change it/);
    expect(existsSync(at(".claude.json"))).toBe(false);
    expect(claude.status()).toMatchObject({ state: "failed", message: expect.stringMatching(/not valid JSON/) });
  });
});

describe("refreshing and disconnecting", () => {
  it("refresh repairs a stale Attache entry and leaves the owner's entries alone; when current it writes nothing", () => {
    const file = at(harnessMcpConfigs(currentOs())["claude-desktop"].file);
    const desktop = adapter("claude-desktop");
    desktop.apply();
    const config = JSON.parse(readFileSync(file, "utf8"));
    const [name] = Object.keys(config.mcpServers);
    config.mcpServers[name!].command = "/an/older/attache/node";
    config.mcpServers.mine = { command: "mine", args: [] };
    write(file, JSON.stringify(config));
    expect(desktop.status().state).toBe("stale");
    const r = desktop.refresh();
    expect(r.changes.map((c) => c.path)).toEqual([file]);
    expect(desktop.status().state).toBe("current");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.mine).toEqual({ command: "mine", args: [] });
    expect(desktop.refresh()).toMatchObject({ changes: [], backups: [] });
  });

  it("disconnecting removes only this instance's entries; another Attache instance's stay", () => {
    const otherState = tempDir("attache-adapter-other-state-");
    const other = harnessAdapters(new AgentHooks(otherState, backups), () => MEMORY).find((a) => a.kind === "antigravity")!;
    other.apply();
    adapter("antigravity").apply();
    const r = adapter("antigravity").uninstall();
    expect(r.failures).toEqual([]);
    // The memory rule is Attache's own file and goes; the hooks and MCP files are the owner's and only lose Attache's entry.
    const rules = readdirSync(at(".gemini/config/rules"));
    expect(rules).toHaveLength(1);
    expect(r.removed.map((c) => [c.path, c.change])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/rules[\\/]attache-[0-9a-f]{8}-memory\.md$/), "remove"],
        [at(".gemini/config/hooks.json"), "update"],
        [at(".gemini/config/mcp_config.json"), "update"],
      ]),
    );
    expect(r.removed).toHaveLength(3);
    expect(r.removed.map((c) => c.path)).not.toContain(at(".gemini/config/rules", rules[0]!));
    expect(adapter("antigravity").status().state).toBe("missing");
    expect(other.status().state).toBe("current");
  });

  it("reports a part it could not remove by its file, and still removes the rest", () => {
    adapter("claude-code").apply();
    write(at(".claude/settings.json"), "{ broken");
    const r = adapter("claude-code").uninstall();
    expect(r.failures).toEqual([expect.stringMatching(/settings\.json is not valid JSON/)]);
    expect(r.removed.map((c) => c.path)).toEqual([at(".claude.json")]);
  });
});

describe("what each Harness reports it can do", () => {
  it("reports MCP access, memory and session capture independently, and whether a restart is needed", () => {
    const report = Object.fromEntries(adapters().map((a) => [a.kind, { ...a.capabilities, restartRequired: a.restartRequired }]));
    expect(report).toEqual({
      "claude-code": { mcp: true, memory: "runtime-fresh", capture: "with-final-event", restartRequired: false },
      codex: { mcp: true, memory: "runtime-fresh", capture: "with-final-event", restartRequired: false },
      antigravity: { mcp: true, memory: "managed-file", capture: "without-final-event", restartRequired: false },
      "claude-desktop": { mcp: true, memory: "none", capture: "none", restartRequired: true },
    });
  });

  it("an MCP-only Harness's preview and apply say a restart is needed, and touch only its MCP configuration", () => {
    const desktop = adapter("claude-desktop");
    const file = at(harnessMcpConfigs(currentOs())["claude-desktop"].file);
    expect(desktop.preview()).toEqual({ changes: [{ path: file, change: "create", backup: false, purpose: "Attache's MCP server" }], restartRequired: true });
    expect(desktop.apply().restartRequired).toBe(true);
  });
});
