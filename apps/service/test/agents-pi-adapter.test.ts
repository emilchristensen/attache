import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";

/**
 * Pi (earendil-works/pi) through its official extension API: Attache owns one
 * extension file per instance in Pi's global extensions folder, and that
 * extension registers this instance's MCP server with `pi.registerMcpServer`
 * every time Pi loads it. Fixture tests against real files in a temporary home.
 */

let home: string;
let stateDir: string;
let backups: string;
const at = (...rel: string[]) => join(home, ...rel);
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const EXTENSIONS = () => at(".pi/agent/extensions");

const piFor = (state: string) => harnessAdapters(new AgentHooks(state, backups), () => "").find((a) => a.kind === "pi")!;
const pi = () => piFor(stateDir);
/** The one extension file this instance owns. */
const ours = () => {
  const files = readdirSync(EXTENSIONS()).filter((f) => f.startsWith("attache"));
  expect(files).toHaveLength(1);
  return join(EXTENSIONS(), files[0]!);
};

beforeEach(() => {
  home = tempDir("attache-pi-home-");
  stateDir = tempDir("attache-pi-state-");
  backups = tempDir("attache-pi-backups-");
  process.env.ATTACHE_AGENT_HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("previewing Pi", () => {
  it("lists the one extension file connecting would create, and writes nothing", () => {
    mkdirSync(at(".pi/agent"), { recursive: true });
    const p = pi().preview();
    expect(p.restartRequired).toBe(true);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ change: "create", backup: false });
    expect(p.changes[0]!.path).toMatch(/[\\/]\.pi[\\/]agent[\\/]extensions[\\/]attache-[0-9a-f]{8}\.ts$/);
    expect(p.changes[0]!.purpose).toMatch(/MCP server/);
    expect(existsSync(EXTENSIONS())).toBe(false);
  });
});

/** Load an extension file the way Pi does (a default-exported factory) against a stand-in for Pi's extension API. */
async function load(path: string) {
  const registered: Array<{ name: string; config: { command: string; args: string[]; exposure?: string } }> = [];
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: (api: unknown) => void };
  mod.default({ registerMcpServer: (name: string, config: never) => registered.push({ name, config }) });
  return registered;
}

describe("connecting Pi", () => {
  it("writes an extension that registers this instance's MCP server, with its tools declared to the model, each time it loads", async () => {
    const r = pi().apply();
    expect(r).toMatchObject({ backups: [], restartRequired: true });
    expect(r.changes.map((c) => c.path)).toEqual([ours()]);
    const registered = await load(ours());
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toMatch(/^attache-[0-9a-f]{8}$/);
    expect(registered[0]!.config.args.slice(-3)).toEqual(["mcp", "--state-dir", stateDir]);
    expect(registered[0]!.config.exposure).toBe("direct");
    expect(await load(ours())).toEqual(registered);
    expect(pi().status()).toMatchObject({ state: "current", files: [ours()] });
  });

  it("adds nothing to Pi's own settings or MCP configuration", () => {
    const settings = JSON.stringify({ defaultModel: "sonnet", extensions: ["/my/ext.ts"] });
    const mcp = JSON.stringify({ mcpServers: { files: { command: "npx", args: ["fs"] } } });
    write(at(".pi/agent/settings.json"), settings);
    write(at(".pi/agent/mcp.json"), mcp);
    write(at(".pi/agent/extensions/mine.ts"), "export default () => {};\n");
    pi().apply();
    expect(readFileSync(at(".pi/agent/settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(at(".pi/agent/mcp.json"), "utf8")).toBe(mcp);
    expect(readFileSync(at(".pi/agent/extensions/mine.ts"), "utf8")).toBe("export default () => {};\n");
  });

  it("connecting again previews and changes nothing", () => {
    pi().apply();
    const before = readFileSync(ours(), "utf8");
    expect(pi().preview().changes).toEqual([]);
    expect(pi().apply()).toMatchObject({ changes: [], backups: [] });
    expect(readFileSync(ours(), "utf8")).toBe(before);
  });

  it("uses PI_CODING_AGENT_DIR when the service has it set", () => {
    const dir = tempDir("attache-pi-agent-dir-");
    process.env.PI_CODING_AGENT_DIR = dir;
    const [change] = pi().apply().changes;
    expect(change!.path.startsWith(join(dir, "extensions"))).toBe(true);
    expect(existsSync(at(".pi"))).toBe(false);
    delete process.env.PI_CODING_AGENT_DIR;
  });
});

describe("refreshing Pi", () => {
  it("replaces an out-of-date Attache extension after backing it up, and is current again", () => {
    pi().apply();
    const old = readFileSync(ours(), "utf8").replace(/"command": "[^"]*"/, '"command": "/an/older/attache/node"');
    writeFileSync(ours(), old);
    expect(pi().status().state).toBe("stale");
    expect(pi().preview().changes).toEqual([expect.objectContaining({ path: ours(), change: "update", backup: true })]);
    const r = pi().refresh();
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(old);
    expect(pi().status().state).toBe("current");
    expect(pi().refresh()).toMatchObject({ changes: [], backups: [] });
  });
});

describe("two Attache instances on one Machine", () => {
  it("each owns its own extension and server name, and disconnecting one leaves the other's", async () => {
    const other = piFor(tempDir("attache-pi-other-state-"));
    other.apply();
    pi().apply();
    const files = readdirSync(EXTENSIONS()).sort();
    expect(files).toHaveLength(2);
    const names = (await Promise.all(files.map((f) => load(join(EXTENSIONS(), f))))).map((r) => r[0]!.name);
    expect(new Set(names).size).toBe(2);
    const r = pi().uninstall();
    expect(r.failures).toEqual([]);
    expect(r.removed).toHaveLength(1);
    expect(readdirSync(EXTENSIONS())).toHaveLength(1);
    expect(pi().status().state).toBe("missing");
    expect(other.status().state).toBe("current");
  });
});

describe("disconnecting Pi", () => {
  it("removes only Attache's extension; the owner's extensions, settings and MCP servers stay", () => {
    write(at(".pi/agent/extensions/mine.ts"), "export default () => {};\n");
    write(at(".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { files: { command: "npx" } } }));
    pi().apply();
    const path = ours();
    expect(pi().uninstall()).toEqual({ removed: [expect.objectContaining({ path, change: "remove" })], failures: [] });
    expect(readdirSync(EXTENSIONS())).toEqual(["mine.ts"]);
    expect(JSON.parse(readFileSync(at(".pi/agent/mcp.json"), "utf8"))).toEqual({ mcpServers: { files: { command: "npx" } } });
    expect(pi().uninstall()).toEqual({ removed: [], failures: [] });
  });

  it("still removes the extension when Pi's own settings no longer parse", () => {
    pi().apply();
    write(at(".pi/agent/settings.json"), "{ broken");
    expect(pi().uninstall().removed).toHaveLength(1);
    expect(readdirSync(EXTENSIONS())).toEqual([]);
  });
});

describe("Pi configuration Attache cannot safely work with", () => {
  const nothingWritten = () => expect(existsSync(EXTENSIONS())).toBe(false);

  it("a settings.json that does not parse stops the preview and the connection, names the file, and writes nothing", () => {
    write(at(".pi/agent/settings.json"), '{ "defaultModel": "sonnet", }');
    expect(() => pi().preview()).toThrow(/settings\.json is not valid JSON/);
    expect(() => pi().apply()).toThrow(/settings\.json is not valid JSON/);
    nothingWritten();
    expect(pi().status()).toMatchObject({ state: "failed", message: expect.stringMatching(/settings\.json/) });
  });

  it("an mcp.json that does not parse stops the connection and names the file", () => {
    write(at(".pi/agent/mcp.json"), "{ nope");
    expect(() => pi().apply()).toThrow(/mcp\.json is not valid JSON/);
    nothingWritten();
  });

  it("Pi's built-in MCP turned off in settings.json is refused, naming the entry", () => {
    write(at(".pi/agent/settings.json"), JSON.stringify({ extensions: ["-builtin:mcp"] }));
    expect(() => pi().apply()).toThrow(/settings\.json turns off Pi's built-in MCP support/);
    nothingWritten();
  });

  it("a server of the same name in mcp.json, which Pi would use instead, is refused", () => {
    pi().apply();
    const name = readdirSync(EXTENSIONS())[0]!.replace(/\.ts$/, "");
    write(at(".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { [name.replace(/-/g, "_")]: { command: "something-else" } } }));
    expect(() => pi().preview()).toThrow(/mcp\.json already defines a server named/);
    expect(pi().status()).toMatchObject({ state: "failed", message: expect.stringMatching(/mcp\.json/) });
  });

  it("an extension in Attache's place that Attache did not write is left alone and named", () => {
    pi().apply();
    const path = ours();
    writeFileSync(path, "export default (pi) => pi.registerMcpServer('attache', { command: 'mine' });\n");
    expect(() => pi().apply()).toThrow(new RegExp(`${path.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")} exists and was not written by this Attache`));
    expect(pi().status().state).toBe("failed");
    expect(pi().uninstall()).toEqual({ removed: [], failures: [] });
    expect(readFileSync(path, "utf8")).toContain("command: 'mine'");
  });
});

describe("finding Pi", () => {
  it("finds Pi by its folder, and still offers a manual connection when it finds nothing", () => {
    // Whether Pi is on this Machine's tool folders depends on the Machine, so only the home folder is varied here.
    expect(pi().manualSetup).toBe(true);
    mkdirSync(at(".pi"));
    expect(pi().detect(home)).toBe(true);
  });

  it("reports MCP access only, and that a running Pi must reload", () => {
    expect({ ...pi().capabilities, restartRequired: pi().restartRequired }).toEqual({ mcp: true, memory: "none", capture: "none", restartRequired: true });
  });
});
