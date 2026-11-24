import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";
import { removeContextFiles, writeContextFiles } from "../src/agents/context-files.ts";
import { listSpool, spoolCopyPath } from "../src/agents/spool.ts";
import { parseOpenCode } from "../src/agents/opencode-transcript.ts";
import { SECRET, v1Normal, v2Assistant, v2User } from "./fixtures/agents/opencode.ts";

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
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { server: (input: { directory: string }) => Promise<{ config?: (c: Record<string, unknown>) => Promise<void> }> } };
  const hooks = await mod.default.server({ directory: home });
  await hooks.config?.(config);
  return config as { mcp?: Record<string, Server> };
}

/** Load a plugin file as OpenCode 2 does (the default export's `id` and `setup(ctx)`), against a stand-in for its MCP editor. */
async function loadV2(path: string, existing: Record<string, Server> = {}) {
  const servers = new Map(Object.entries(existing));
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { id: string; setup: (ctx: unknown) => Promise<void> } };
  const editor = { list: () => [...servers], get: (n: string) => servers.get(n), set: (n: string, c: Server) => servers.set(n, c), update: () => {}, remove: (n: string) => servers.delete(n) };
  await mod.default.setup({ location: { directory: home }, mcp: { transform: async (cb: (e: typeof editor) => void) => cb(editor) }, session: { hook: async () => ({ dispose: async () => {} }) } });
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

it("recognises the MCP-only plugin an earlier Attache wrote as its own: refreshing upgrades it with a backup, disconnecting removes it", () => {
  openCode().apply();
  const name = ours().replace(/^.*[\\/]/, "").replace(/\.js$/, "");
  // What the MCP-only version wrote: its own first line, the same ownership line.
  const earlier = [
    "// Managed by Attache: registers this Attache instance's MCP server each time OpenCode loads this plugin.",
    "// Attache rewrites this file when you connect OpenCode again and removes it when you disconnect; edits here are lost.",
    `// attache-instance: ${JSON.stringify({ stateDir })}`,
    "",
    `const ID = ${JSON.stringify(name)};`,
    "export default { id: ID, async setup() {}, async server() { return {}; } };",
    "",
  ].join("\n");
  writeFileSync(ours(), earlier);
  expect(openCode().status().state).toBe("stale");
  const r = openCode().refresh();
  expect(r.changes).toEqual([expect.objectContaining({ change: "update", backup: true })]);
  expect(readFileSync(r.backups[0]!, "utf8")).toBe(earlier);
  expect(openCode().status().state).toBe("current");
  writeFileSync(ours(), earlier);
  expect(openCode().uninstall().removed).toHaveLength(1);
  expect(readdirSync(PLUGINS())).toEqual([]);
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

  it("a configuration file that starts with a byte-order mark, as Windows editors write, is read like any other", () => {
    write(join(CONFIG(), "opencode.json"), `\uFEFF${JSON.stringify({ mcp: { [new AgentHooks(stateDir, backups).ownerKey()]: { type: "local", command: ["x"] } } })}`);
    // Read, not refused as unparseable: the name clash inside it is found.
    expect(() => openCode().apply()).toThrow(/already defines an MCP server named/);
  });

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

  it("finds the version in output that has more lines, such as an update notice", () => {
    installOpenCode("1.19.6\nA new version of opencode is available: 1.20.0");
    expect(openCode().apply().changes).toHaveLength(1);
    expect(openCode().status().state).toBe("current");
  });

  it("asks an OpenCode whose --version fails only once, not on every status check", () => {
    const runs = join(tempDir("attache-opencode-runs-"), "runs");
    const bin = join(tempDir("attache-opencode-bin-"), "opencode.mjs");
    writeFileSync(bin, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(runs)}, "run\\n");\nprocess.stderr.write("broken\\n");\nprocess.exit(3);\n`);
    process.env.ATTACHE_OPENCODE_BIN = bin;
    expect(() => openCode().preview()).toThrow(/could not run .*--version \(broken\)/);
    expect(() => openCode().apply()).toThrow(/could not run/);
    expect(openCode().status()).toMatchObject({ state: "failed", message: expect.stringMatching(/could not run/) });
    expect(readFileSync(runs, "utf8")).toBe("run\n");
  });

  it("a status check never waits for opencode --version", () => {
    const bin = join(tempDir("attache-opencode-bin-"), "opencode.mjs");
    writeFileSync(bin, `const end = Date.now() + 3000;\nwhile (Date.now() < end);\nprocess.stdout.write("1.19.6\\n");\n`);
    process.env.ATTACHE_OPENCODE_BIN = bin;
    const t0 = Date.now();
    openCode().status();
    openCode().refresh();
    expect(Date.now() - t0).toBeLessThan(1500);
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

  it("reports MCP access, runtime-fresh memory, session capture without a final event, and that a running OpenCode must restart", () => {
    expect({ ...openCode().capabilities, restartRequired: openCode().restartRequired }).toEqual({ mcp: true, memory: "runtime-fresh", capture: "without-final-event", restartRequired: true });
    // OpenCode has no session end: the Connection must say what that costs.
    expect(openCode().setupNote).toMatch(/no session-end event[^.]*turn still running when OpenCode quits can be missed/);
  });
});

/** OpenCode 1 as the plugin sees it for a session in `directory`: the system-prompt hook, the compaction hook, and the system prompt it is about to send. */
async function v1Session(path: string, directory: string) {
  type V1Hooks = Record<string, (input: Record<string, unknown>, output: Record<string, unknown>) => Promise<void>>;
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { server: (input: { directory: string }) => Promise<V1Hooks> } };
  const hooks = await mod.default.server({ directory });
  return {
    /** The system prompt one model call of `sessionID` gets. */
    async call(sessionID = "ses_1"): Promise<string[]> {
      const output = { system: ["You are OpenCode."] };
      await hooks["experimental.chat.system.transform"]?.({ sessionID, model: {} }, output);
      return output.system;
    },
    async compacting(sessionID = "ses_1") {
      await hooks["experimental.session.compacting"]?.({ sessionID }, { context: [] });
    },
  };
}

/** OpenCode 2 as the plugin sees it for a session in `directory`: the `context` hook it registered, and the system parts one model call gets. */
async function v2Session(path: string, directory: string) {
  const registered: Record<string, (e: { sessionID: string; system: Array<{ type: string; text: string }> }) => Promise<void> | void> = {};
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { setup: (ctx: unknown) => Promise<void> } };
  await mod.default.setup({
    location: { directory },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async (name: string, cb: (typeof registered)[string]) => ((registered[name] = cb), { dispose: async () => {} }) },
  });
  return {
    hooks: Object.keys(registered),
    async call(): Promise<string[]> {
      const event = { sessionID: "ses_1", system: [{ type: "text", text: "You are OpenCode." }] };
      await registered.context?.(event);
      return event.system.map((p) => p.text);
    },
  };
}

const memoryIn = (system: string[]) => system.filter((t) => t.includes("<attache-memory>"));

describe("Attache memory in OpenCode sessions", () => {
  const project = (dir: string, remote: string) => write(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);

  it("adds the Brain's current memory to the system prompt of every OpenCode 1 model call, read fresh each time", async () => {
    writeContextFiles(stateDir, "## Attache memory\n\nOrion cutover is planned for December.\n", []);
    openCode().apply();
    const s = await v1Session(ours(), home);
    expect(await s.call()).toEqual(["You are OpenCode.", "<attache-memory>\n## Attache memory\n\nOrion cutover is planned for December.\n</attache-memory>"]);
    writeContextFiles(stateDir, "## Attache memory\n\nOrion cutover moved to January.\n", []);
    expect(memoryIn(await s.call())).toEqual(["<attache-memory>\n## Attache memory\n\nOrion cutover moved to January.\n</attache-memory>"]);
  });

  it("adds the Brain's current memory to the system prompt of every OpenCode 2 agent-loop call, read fresh each time", async () => {
    writeContextFiles(stateDir, "Orion is on track.\n", []);
    openCode().apply();
    const s = await v2Session(ours(), home);
    // The context hook runs for the agent loop only; compaction and titles have hooks of their own, which never get memory.
    expect(s.hooks).toContain("context");
    expect(await s.call()).toEqual(["You are OpenCode.", "<attache-memory>\nOrion is on track.\n</attache-memory>"]);
    writeContextFiles(stateDir, "Orion slipped a week.\n", []);
    expect(memoryIn(await s.call())).toEqual(["<attache-memory>\nOrion slipped a week.\n</attache-memory>"]);
  });

  it("keeps memory out of OpenCode 1's compaction summary, so a compacted session never carries old memory, and gives the next call current memory", async () => {
    writeContextFiles(stateDir, "Old memory\n", []);
    openCode().apply();
    const s = await v1Session(ours(), home);
    await s.compacting("ses_1");
    // The summary request of ses_1 follows; another session's call is unaffected.
    expect(memoryIn(await s.call("ses_2"))).toHaveLength(1);
    expect(memoryIn(await s.call("ses_1"))).toEqual([]);
    writeContextFiles(stateDir, "New memory\n", []);
    expect(memoryIn(await s.call("ses_1"))).toEqual(["<attache-memory>\nNew memory\n</attache-memory>"]);
  });

  it("gives a session in one of a project's repositories that project's memory, in either OpenCode", async () => {
    const repo = at("code", "orion");
    project(repo, "git@github.com:acme/orion.git");
    writeContextFiles(stateDir, "Global memory\n", [{ slug: "orion", repositories: ["github.com/acme/orion"], text: "Orion memory\n" }]);
    openCode().apply();
    expect(memoryIn(await (await v1Session(ours(), repo)).call())).toEqual(["<attache-memory>\nOrion memory\n</attache-memory>"]);
    expect(memoryIn(await (await v2Session(ours(), repo)).call())).toEqual(["<attache-memory>\nOrion memory\n</attache-memory>"]);
    expect(memoryIn(await (await v1Session(ours(), home)).call())).toEqual(["<attache-memory>\nGlobal memory\n</attache-memory>"]);
  });

  it("adds nothing while Attache has no memory for sessions", async () => {
    openCode().apply();
    expect(await (await v1Session(ours(), home)).call()).toEqual(["You are OpenCode."]);
    expect(await (await v2Session(ours(), home)).call()).toEqual(["You are OpenCode."]);
  });

  it("still registers the MCP server, and only skips memory, when Attache's memory reader cannot be loaded", async () => {
    writeContextFiles(stateDir, "Memory\n", []);
    process.env.ATTACHE_AGENT_HOOK_SCRIPT = join(home, "gone", "attache-agent-hook.mjs");
    try {
      openCode().apply();
    } finally {
      delete process.env.ATTACHE_AGENT_HOOK_SCRIPT;
    }
    expect(await (await v1Session(ours(), home)).call()).toEqual(["You are OpenCode."]);
    const v2 = await loadV2(ours());
    expect(Object.keys(v2.servers)).toEqual([v2.id]);
  });

  it("another Attache instance's plugin gives its own instance's memory", async () => {
    const other = tempDir("attache-opencode-other-state-");
    writeContextFiles(stateDir, "Mine\n", []);
    writeContextFiles(other, "Theirs\n", []);
    openCode().apply();
    openCodeFor(other).apply();
    const files = readdirSync(PLUGINS()).map((f) => join(PLUGINS(), f));
    const sent = await Promise.all(files.map(async (f) => memoryIn(await (await v2Session(f, home)).call())[0]));
    expect(sent.sort()).toEqual(["<attache-memory>\nMine\n</attache-memory>", "<attache-memory>\nTheirs\n</attache-memory>"]);
  });
});

/** The session snapshots Attache's plugin spooled, parsed, oldest first. */
function spooled() {
  return listSpool(stateDir).map((r) => ({ event: r.event, agent: r.agent, sessionId: r.sessionId, cwd: r.cwd, parsed: parseOpenCode(readFileSync(spoolCopyPath(stateDir, r)!, "utf8")) }));
}

/** OpenCode 1 as the plugin sees it: a client that answers for one session, and the plugin's `event`, compaction and `dispose` hooks. */
async function v1Host(path: string, directory: string, session: { messages: unknown[]; parentID?: string }) {
  type V1Hooks = Record<string, (input: Record<string, unknown>, output?: Record<string, unknown>) => Promise<void>>;
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { server: (input: unknown) => Promise<V1Hooks> } };
  const client = {
    session: {
      get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id, title: "Plan the Orion cutover", directory, ...(session.parentID ? { parentID: session.parentID } : {}) } }),
      messages: async () => ({ data: session.messages }),
    },
  };
  const hooks = await mod.default.server({ directory, client });
  return {
    idle: (sessionID = "ses_1") => hooks.event!({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } }),
    busy: (sessionID = "ses_1") => hooks.event!({ event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } }),
    compacting: (sessionID = "ses_1") => hooks["experimental.session.compacting"]!({ sessionID }, { context: [] }),
    dispose: () => hooks.dispose!({}),
  };
}

/** OpenCode 2 as the plugin sees it: `ctx.session.get`/`context` for one session, and the hooks and cleanup the plugin registered. */
async function v2Host(path: string, directory: string, session: { context: unknown[]; parentID?: string }) {
  const registered: Record<string, (e: Record<string, unknown>) => Promise<void> | void> = {};
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: { setup: (ctx: unknown) => Promise<(() => Promise<void>) | void> } };
  const cleanup = await mod.default.setup({
    location: { directory },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name: string, cb: (typeof registered)[string]) => ((registered[name] = cb), { dispose: async () => {} }),
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Plan the Orion cutover", location: { directory }, ...(session.parentID ? { parentID: session.parentID } : {}) }),
      context: async () => session.context,
    },
  });
  return {
    hooks: Object.keys(registered).sort(),
    idle: (sessionID = "ses_1") => registered["experimental.idle"]!({ sessionID, background: [] }),
    compaction: (messages: unknown[], sessionID = "ses_1") => registered.compaction!({ sessionID, messages }),
    cleanup: () => cleanup?.(),
  };
}

describe("saving OpenCode sessions", () => {
  // Session capture follows the Agent sessions feature, as memory does: the service keeps these files only while it is on.
  beforeEach(() => writeContextFiles(stateDir, "Memory\n", []));

  it("OpenCode 1: spools the whole session each time a turn ends, for the service to save", async () => {
    openCode().apply();
    const session = { messages: v1Normal().slice(0, 2) };
    const s = await v1Host(ours(), at("work"), session);
    await s.busy();
    expect(spooled()).toEqual([]);
    await s.idle();
    session.messages = v1Normal();
    await s.idle();
    const [first, second] = spooled();
    expect(first).toMatchObject({ event: "turn-end", agent: "opencode", sessionId: "ses_1", cwd: at("work") });
    expect(first!.parsed.turns.map((t) => t.text)).toEqual(["Should the cutover wait for the audit?", "Yes: we decided to wait, because the audit closes Friday."]);
    expect(second!.parsed.turns).toHaveLength(4);
    expect(second!.parsed.title).toBe("Plan the Orion cutover");
  });

  it("OpenCode 1: spools the session before a compaction, and once more when OpenCode unloads the plugin", async () => {
    openCode().apply();
    const s = await v1Host(ours(), at("work"), { messages: v1Normal() });
    await s.compacting();
    await s.dispose();
    expect(spooled().map((r) => [r.event, r.parsed.turns.length])).toEqual([
      ["pre-compact", 4],
      ["turn-end", 4],
    ]);
  });

  it("OpenCode 2: spools the session's context when a turn ends, and the messages it is about to compact before a compaction", async () => {
    openCode().apply();
    const session = { context: [v2User("first question", 0)] as unknown[] };
    const s = await v2Host(ours(), at("work"), session);
    expect(s.hooks).toEqual(["compaction", "context", "experimental.idle"]);
    await s.compaction([{ id: "msg_a", role: "user", content: [{ type: "text", text: SECRET }] }]);
    session.context = [v2User("after compaction", 1), v2Assistant([{ type: "text", text: "pong" }], 2)];
    await s.idle();
    await s.cleanup();
    expect(spooled().map((r) => [r.event, r.parsed.turns.map((t) => t.text)])).toEqual([
      ["pre-compact", ["first question"]],
      ["turn-end", ["after compaction", "pong"]],
      ["turn-end", ["after compaction", "pong"]],
    ]);
    expect(spooled()[0]).toMatchObject({ agent: "opencode", sessionId: "ses_1", cwd: at("work") });
  });

  it("never spools a subagent's session, in either OpenCode", async () => {
    openCode().apply();
    await (await v1Host(ours(), home, { messages: v1Normal(), parentID: "ses_parent" })).idle();
    await (await v2Host(ours(), home, { context: [v2User("hi", 0)], parentID: "ses_parent" })).idle();
    expect(spooled()).toEqual([]);
  });

  it("spools nothing while the Agent sessions feature is off, and never breaks the session", async () => {
    removeContextFiles(stateDir);
    openCode().apply();
    await (await v1Host(ours(), home, { messages: v1Normal() })).idle();
    await (await v2Host(ours(), home, { context: [v2User("hi", 0)] })).idle();
    expect(spooled()).toEqual([]);
  });

  it("keeps the session going when OpenCode cannot give the plugin the session's messages", async () => {
    openCode().apply();
    const s = await v1Host(ours(), home, { messages: v1Normal() });
    const broken = await v2Host(ours(), home, { context: null as unknown as unknown[] });
    await expect(s.compacting("ses_missing")).resolves.toBeUndefined();
    await expect(broken.idle()).resolves.toBeUndefined();
  });
});
