import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";

/**
 * OpenCode through its official plugin API: Attache owns one plugin file per
 * instance in OpenCode's global plugins folder, and that plugin registers this
 * instance's MCP server in memory each time OpenCode loads it, through
 * OpenCode 1's `config` hook and OpenCode 2's `ctx.mcp.transform`. Fixture
 * tests against real files in a temporary home, with a stand-in `opencode`
 * executable that only answers `--version`.
 */

let home: string;
let stateDir: string;
let backups: string;
const at = (...rel: string[]) => join(home, ...rel);
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const CONFIG = () => at(".config/opencode");
const PLUGINS = () => at(".config/opencode/plugins");

const openCodeFor = (state: string) => harnessAdapters(new AgentHooks(state, backups), () => "").find((a) => a.kind === "opencode")!;
const openCode = () => openCodeFor(stateDir);
/** The one plugin file this instance owns. */
const ours = () => {
  const files = readdirSync(PLUGINS()).filter((f) => f.startsWith("attache"));
  expect(files).toHaveLength(1);
  return join(PLUGINS(), files[0]!);
};

/** A stand-in `opencode` that prints `output` for `--version`, as the real one does. */
function installOpenCode(output: string) {
  const bin = join(tempDir("attache-opencode-bin-"), "opencode.mjs");
  writeFileSync(bin, `process.stdout.write(${JSON.stringify(`${output}\n`)});\n`);
  process.env.ATTACHE_OPENCODE_BIN = bin;
}

interface Server {
  type: string;
  command: string[];
  enabled?: boolean;
  codemode?: boolean;
}

/** Load a plugin file as OpenCode 1 does (the default export's `server()` hooks, then the `config` hook on a live config). */
async function loadV1(path: string, config: Record<string, unknown> = {}) {
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { server: () => Promise<{ config?: (c: Record<string, unknown>) => Promise<void> }> } };
  const hooks = await mod.default.server();
  await hooks.config?.(config);
  return config as { mcp?: Record<string, Server> };
}

/** Load a plugin file as OpenCode 2 does (the default export's `id` and `setup(ctx)`), against a stand-in for its MCP editor. */
async function loadV2(path: string, existing: Record<string, Server> = {}) {
  const servers = new Map(Object.entries(existing));
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { id: string; setup: (ctx: unknown) => Promise<void> } };
  const editor = { list: () => [...servers], get: (n: string) => servers.get(n), set: (n: string, c: Server) => servers.set(n, c), update: () => {}, remove: (n: string) => servers.delete(n) };
  await mod.default.setup({ mcp: { transform: async (cb: (e: typeof editor) => void) => cb(editor) } });
  return { id: mod.default.id, servers: Object.fromEntries(servers) };
}

beforeEach(() => {
  home = tempDir("attache-opencode-home-");
  stateDir = tempDir("attache-opencode-state-");
  backups = tempDir("attache-opencode-backups-");
  process.env.ATTACHE_AGENT_HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG;
  // No OpenCode unless a test installs one: this Machine's own tool folders are never looked at.
  process.env.ATTACHE_OPENCODE_BIN = join(home, "no-opencode-here");
});

describe("previewing OpenCode", () => {
  it("lists the one plugin file connecting would create, and writes nothing", () => {
    const p = openCode().preview();
    expect(p.restartRequired).toBe(true);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ change: "create", backup: false });
    expect(p.changes[0]!.path).toMatch(/[\\/]\.config[\\/]opencode[\\/]plugins[\\/]attache-[0-9a-f]{8}\.js$/);
    expect(p.changes[0]!.purpose).toMatch(/MCP server/);
    expect(existsSync(CONFIG())).toBe(false);
  });
});

describe("connecting OpenCode", () => {
  it("writes a plugin that registers this instance's MCP server in OpenCode 1 and OpenCode 2, each time it loads", async () => {
    const r = openCode().apply();
    expect(r).toMatchObject({ backups: [], restartRequired: true });
    expect(r.changes.map((c) => c.path)).toEqual([ours()]);
    const name = ours().replace(/^.*[\\/]/, "").replace(/\.js$/, "");
    expect(name).toMatch(/^attache-[0-9a-f]{8}$/);

    const v1 = await loadV1(ours(), { mcp: { files: { type: "local", command: ["npx", "fs"] } } });
    expect(Object.keys(v1.mcp!)).toEqual(["files", name]);
    expect(v1.mcp![name]).toMatchObject({ type: "local", enabled: true });
    expect(v1.mcp![name]!.command.slice(-3)).toEqual(["mcp", "--state-dir", stateDir]);

    const v2 = await loadV2(ours(), { files: { type: "local", command: ["npx", "fs"] } });
    expect(v2.id).toBe(name);
    expect(Object.keys(v2.servers)).toEqual(["files", name]);
    expect(v2.servers[name]).toEqual({ type: "local", command: v1.mcp![name]!.command, codemode: false });

    expect(openCode().status()).toMatchObject({ state: "current", files: [ours()] });
  });
});

describe("connecting OpenCode next to the owner's own setup", () => {
  it("adds nothing to OpenCode's configuration and leaves the owner's plugins alone", () => {
    const config = '{\n  // my settings\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "files": { "type": "local", "command": ["npx", "fs"] } },\n}\n';
    write(join(CONFIG(), "opencode.jsonc"), config);
    write(join(PLUGINS(), "mine.js"), "export default { id: 'mine', setup() {} };\n");
    openCode().apply();
    expect(readFileSync(join(CONFIG(), "opencode.jsonc"), "utf8")).toBe(config);
    expect(readFileSync(join(PLUGINS(), "mine.js"), "utf8")).toBe("export default { id: 'mine', setup() {} };\n");
    expect(readdirSync(PLUGINS()).sort()).toEqual([expect.stringMatching(/^attache-/), "mine.js"]);
  });

  it("connecting again previews and changes nothing", () => {
    openCode().apply();
    const before = readFileSync(ours(), "utf8");
    expect(openCode().preview().changes).toEqual([]);
    expect(openCode().apply()).toMatchObject({ changes: [], backups: [] });
    expect(readFileSync(ours(), "utf8")).toBe(before);
  });

  it("uses XDG_CONFIG_HOME, and OPENCODE_CONFIG_DIR over it, when the service has them set", () => {
    const xdg = tempDir("attache-opencode-xdg-");
    process.env.XDG_CONFIG_HOME = xdg;
    expect(openCode().apply().changes[0]!.path.startsWith(join(xdg, "opencode", "plugins"))).toBe(true);
    const dir = tempDir("attache-opencode-config-dir-");
    process.env.OPENCODE_CONFIG_DIR = dir;
    expect(openCode().apply().changes[0]!.path.startsWith(join(dir, "plugins"))).toBe(true);
    expect(existsSync(CONFIG())).toBe(false);
  });
});

describe("refreshing OpenCode", () => {
  it("replaces an out-of-date Attache plugin after backing it up, and is current again", () => {
    openCode().apply();
    const old = readFileSync(ours(), "utf8").replace(/const COMMAND = \[[^\]]*\]/, 'const COMMAND = ["/an/older/attache/node"]');
    writeFileSync(ours(), old);
    expect(openCode().status().state).toBe("stale");
    expect(openCode().preview().changes).toEqual([expect.objectContaining({ path: ours(), change: "update", backup: true })]);
    const r = openCode().refresh();
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(old);
    expect(openCode().status().state).toBe("current");
    expect(openCode().refresh()).toMatchObject({ changes: [], backups: [] });
  });
});

describe("two Attache instances on one Machine", () => {
  it("each owns its own plugin, plugin id and server name, and disconnecting one leaves the other's", async () => {
    const other = openCodeFor(tempDir("attache-opencode-other-state-"));
    other.apply();
    openCode().apply();
    const files = readdirSync(PLUGINS()).sort();
    expect(files).toHaveLength(2);
    const loaded = await Promise.all(files.map((f) => loadV2(join(PLUGINS(), f))));
    // OpenCode 2 refuses two plugins with one id, so each instance needs its own.
    expect(new Set(loaded.map((l) => l.id)).size).toBe(2);
    expect(new Set(loaded.flatMap((l) => Object.keys(l.servers))).size).toBe(2);
    const r = openCode().uninstall();
    expect(r.failures).toEqual([]);
    expect(r.removed).toHaveLength(1);
    expect(readdirSync(PLUGINS())).toHaveLength(1);
    expect(openCode().status().state).toBe("missing");
    expect(other.status().state).toBe("current");
  });
});

describe("disconnecting OpenCode", () => {
  it("removes only Attache's plugin; the owner's plugins and configuration stay", () => {
    write(join(PLUGINS(), "mine.js"), "export default { id: 'mine', setup() {} };\n");
    write(join(CONFIG(), "opencode.json"), '{ "mcp": { "files": { "type": "local", "command": ["npx"] } } }');
    openCode().apply();
    const path = ours();
    expect(openCode().uninstall()).toEqual({ removed: [expect.objectContaining({ path, change: "remove" })], failures: [] });
    expect(readdirSync(PLUGINS())).toEqual(["mine.js"]);
    expect(readFileSync(join(CONFIG(), "opencode.json"), "utf8")).toBe('{ "mcp": { "files": { "type": "local", "command": ["npx"] } } }');
    expect(openCode().uninstall()).toEqual({ removed: [], failures: [] });
  });

  it("still removes the plugin when OpenCode's own configuration no longer parses", () => {
    openCode().apply();
    write(join(CONFIG(), "opencode.json"), "{ broken");
    expect(openCode().uninstall().removed).toHaveLength(1);
    expect(readdirSync(PLUGINS())).toEqual([]);
  });

  it("a plugin in Attache's place that Attache did not write is left alone and named", () => {
    openCode().apply();
    const path = ours();
    writeFileSync(path, "export default { id: 'mine', setup() {} };\n");
    expect(() => openCode().apply()).toThrow(new RegExp(`${path.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")} exists and was not written by this Attache`));
    expect(openCode().status().state).toBe("failed");
    expect(openCode().uninstall()).toEqual({ removed: [], failures: [] });
    expect(readFileSync(path, "utf8")).toContain("id: 'mine'");
  });
});

describe("OpenCode configuration Attache cannot safely work with", () => {
  const nothingWritten = () => expect(existsSync(PLUGINS())).toBe(false);

  it("comments and trailing commas are fine, as OpenCode allows them", () => {
    write(join(CONFIG(), "opencode.jsonc"), '{\n  // "mcp": {},\n  /* block */ "theme": "dark", "url": "http://x//y",\n}\n');
    expect(openCode().apply().changes).toHaveLength(1);
  });

  for (const file of ["opencode.json", "opencode.jsonc", "config.json"]) {
    it(`a ${file} that does not parse stops the preview and the connection, names the file, and writes nothing`, () => {
      write(join(CONFIG(), file), '{ "theme": "dark" "mcp": {} }');
      const why = new RegExp(`${file.replace(/\./g, "\\.")} is not valid JSON`);
      expect(() => openCode().preview()).toThrow(why);
      expect(() => openCode().apply()).toThrow(why);
      nothingWritten();
      expect(openCode().status()).toMatchObject({ state: "failed", message: expect.stringMatching(why) });
    });
  }

  it("a file OPENCODE_CONFIG names is checked too", () => {
    const path = join(tempDir("attache-opencode-explicit-"), "team.json");
    write(path, "[1, 2]");
    process.env.OPENCODE_CONFIG = path;
    expect(() => openCode().apply()).toThrow(/team\.json does not contain a JSON object/);
    nothingWritten();
  });

  it("an MCP server of the same name, which Attache's plugin would replace, is refused in either OpenCode's shape", () => {
    openCode().apply();
    const name = readdirSync(PLUGINS())[0]!.replace(/\.js$/, "");
    write(join(CONFIG(), "opencode.json"), JSON.stringify({ mcp: { [name]: { type: "local", command: ["mine"] } } }));
    expect(() => openCode().preview()).toThrow(new RegExp(`opencode\\.json already defines an MCP server named "${name}"`));
    write(join(CONFIG(), "opencode.json"), JSON.stringify({ mcp: { servers: { [name]: { type: "local", command: ["mine"] } } } }));
    expect(() => openCode().preview()).toThrow(/already defines an MCP server named/);
    expect(openCode().status()).toMatchObject({ state: "failed", message: expect.stringMatching(/opencode\.json/) });
  });

  it("OpenCode 2's plugins list turning Attache's plugin off is refused, and turning it back on later is fine", () => {
    write(join(CONFIG(), "opencode.json"), JSON.stringify({ plugins: ["-attache.*", "-*"] }));
    expect(() => openCode().apply()).toThrow(/opencode\.json turns off Attache's plugin \("-\*"\)/);
    nothingWritten();
    write(join(CONFIG(), "opencode.json"), JSON.stringify({ plugins: ["-*", "attache-*"] }));
    expect(() => openCode().apply()).toThrow(/turns off Attache's plugin/);
    write(join(CONFIG(), "opencode.json"), JSON.stringify({ plugins: ["-*", "*"] }));
    expect(openCode().apply().changes).toHaveLength(1);
  });
});

describe("OpenCode versions", () => {
  // The real executables print these for --version (verified with opencode-ai 1.19.6 and @opencode/cli 2.3.2).
  for (const output of ["1.19.6", "1.18.29", "opencode v2.3.2"]) {
    it(`connects to an OpenCode that reports "${output}"`, () => {
      installOpenCode(output);
      expect(openCode().detect(home)).toBe(true);
      expect(openCode().apply().changes).toHaveLength(1);
      expect(openCode().status().state).toBe("current");
    });
  }

  it("refuses an OpenCode 1 older than 1.18.29, whose loader cannot read the plugin, and writes nothing", () => {
    installOpenCode("1.18.28");
    expect(() => openCode().preview()).toThrow(/OpenCode 1\.18\.28 is too old for Attache's plugin: update to OpenCode 1\.18\.29 or later, or OpenCode 2/);
    expect(() => openCode().apply()).toThrow(/too old/);
    expect(existsSync(PLUGINS())).toBe(false);
    expect(openCode().status()).toMatchObject({ state: "failed", message: expect.stringMatching(/too old/) });
  });

  it("refuses a major version Attache does not know yet, naming it", () => {
    installOpenCode("opencode v3.0.0");
    expect(() => openCode().apply()).toThrow(/OpenCode 3\.0\.0 is a version Attache does not support yet/);
    expect(existsSync(PLUGINS())).toBe(false);
  });

  it("refuses an OpenCode whose version it cannot read, naming the executable and what it printed", () => {
    installOpenCode("something odd");
    expect(() => openCode().apply()).toThrow(/could not tell which OpenCode .*opencode\.mjs.* is \(it printed "something odd"\)/);
    expect(existsSync(PLUGINS())).toBe(false);
  });

  it("connects when OpenCode was not found, and offers that manual connection", () => {
    expect(openCode().manualSetup).toBe(true);
    expect(openCode().detect(home)).toBe(false);
    expect(openCode().apply().changes).toHaveLength(1);
  });

  it("finds OpenCode by its installer's folder", () => {
    mkdirSync(at(".opencode"));
    expect(openCode().detect(home)).toBe(true);
  });

  it("reports MCP access only, and that a running OpenCode must restart", () => {
    expect({ ...openCode().capabilities, restartRequired: openCode().restartRequired }).toEqual({ mcp: true, memory: "none", capture: "none", restartRequired: true });
  });
});
