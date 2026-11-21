import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers.ts";
import { AgentHooks } from "../src/agents/install.ts";
import { harnessAdapters } from "../src/agents/harness-adapters.ts";
import { removeContextFiles, writeContextFiles } from "../src/agents/context-files.ts";
import { listSpool, spoolCopyPath } from "../src/agents/spool.ts";
import { parsePi } from "../src/agents/pi-transcript.ts";
import { HEADER, assistant, normal, text, user } from "./fixtures/agents/pi.ts";

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

type Handler = (event: unknown, ctx: unknown) => unknown;
interface PiMessage {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

/** Load an extension file the way Pi does (a default-exported factory) against a stand-in for Pi's extension API. */
async function loadExtension(path: string) {
  const registered: Array<{ name: string; config: { command: string; args: string[]; exposure?: string } }> = [];
  const handlers = new Map<string, Handler[]>();
  const mod = (await import(`${path}?v=${Math.random()}`)) as { default: (api: unknown) => void };
  mod.default({
    registerMcpServer: (name: string, config: never) => registered.push({ name, config }),
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  });
  /** Run every handler of one Pi event, as Pi awaits them. */
  const emit = async (event: string, payload: Record<string, unknown>, ctx: unknown) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
  };
  /** What Pi sends the model on one call: the messages after every `context` handler, as Pi chains them. */
  const context = async (messages: PiMessage[], cwd: string): Promise<PiMessage[]> => {
    let current = messages;
    for (const h of handlers.get("context") ?? []) {
      const r = (await h({ type: "context", messages: structuredClone(current) }, { cwd })) as { messages?: PiMessage[] } | undefined;
      if (r?.messages) current = r.messages;
    }
    return current;
  };
  return { registered, handlers, context, emit };
}
const load = async (path: string) => (await loadExtension(path)).registered;

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

  it("recognises the MCP-only extension an earlier Attache wrote as its own: refreshing upgrades it to give memory, and disconnecting removes it", async () => {
    pi().apply();
    const path = ours();
    // What the MCP-only version wrote: its own first line, the same ownership line, and no memory.
    const earlier = readFileSync(path, "utf8")
      .replace(/^[^\n]*/, "// Managed by Attache: registers this Attache instance's MCP server in each Pi session.")
      .replace(/\nlet hook;[\s\S]*$/, "\nexport default function attache(pi) {\n  pi.registerMcpServer(SERVER, CONFIG);\n}\n");
    writeFileSync(path, earlier);
    expect(pi().status().state).toBe("stale");
    const r = pi().refresh();
    expect(r.changes).toEqual([expect.objectContaining({ path, change: "update", backup: true })]);
    expect(readFileSync(r.backups[0]!, "utf8")).toBe(earlier);
    expect((await loadExtension(path)).handlers.has("context")).toBe(true);
    writeFileSync(path, earlier);
    expect(pi().uninstall()).toMatchObject({ removed: [expect.objectContaining({ path, change: "remove" })], failures: [] });
    expect(existsSync(path)).toBe(false);
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

  it("reports MCP access, runtime-fresh memory, session capture with a final event, and that a running Pi must reload", () => {
    expect({ ...pi().capabilities, restartRequired: pi().restartRequired }).toEqual({ mcp: true, memory: "runtime-fresh", capture: "with-final-event", restartRequired: true });
  });
});

describe("Attache memory in Pi sessions", () => {
  const user = (text: string): PiMessage => ({ role: "user", content: [{ type: "text", text }] });
  const memoryOf = (messages: PiMessage[]) => messages.filter((m) => m.role === "custom" && m.customType === "attache-memory");
  const project = (dir: string, remote: string) => write(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);

  it("puts the Brain's current memory ahead of the conversation on every model call, read fresh each time", async () => {
    writeContextFiles(stateDir, "## Attache memory\n\nOrion cutover is planned for December.\n", []);
    pi().apply();
    const ext = await loadExtension(ours());
    const first = await ext.context([user("hello")], home);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ role: "custom", customType: "attache-memory", display: false });
    expect(first[0]!.content).toBe("<attache-memory>\n## Attache memory\n\nOrion cutover is planned for December.\n</attache-memory>");
    expect(first[1]).toEqual(user("hello"));

    writeContextFiles(stateDir, "## Attache memory\n\nOrion cutover moved to January.\n", []);
    const second = await ext.context([user("hello"), user("again")], home);
    expect(memoryOf(second).map((m) => m.content)).toEqual(["<attache-memory>\n## Attache memory\n\nOrion cutover moved to January.\n</attache-memory>"]);
  });

  it("replaces memory a resumed or compacted session still carries, so only the current memory reaches the model", async () => {
    writeContextFiles(stateDir, "Current memory\n", []);
    pi().apply();
    const ext = await loadExtension(ours());
    const stale: PiMessage = { role: "custom", customType: "attache-memory", content: "<attache-memory>\nOld memory\n</attache-memory>", display: false };
    const sent = await ext.context([stale, user("hello"), stale], home);
    expect(memoryOf(sent).map((m) => m.content)).toEqual(["<attache-memory>\nCurrent memory\n</attache-memory>"]);
    expect(sent.filter((m) => m.role === "user")).toEqual([user("hello")]);
  });

  it("gives a session in one of a project's repositories that project's memory", async () => {
    const repo = at("code", "orion");
    project(repo, "git@github.com:acme/orion.git");
    writeContextFiles(stateDir, "Global memory\n", [{ slug: "orion", repositories: ["github.com/acme/orion"], text: "Orion memory\n" }]);
    pi().apply();
    const ext = await loadExtension(ours());
    expect(memoryOf(await ext.context([user("hi")], repo))[0]!.content).toBe("<attache-memory>\nOrion memory\n</attache-memory>");
    expect(memoryOf(await ext.context([user("hi")], home))[0]!.content).toBe("<attache-memory>\nGlobal memory\n</attache-memory>");
  });

  it("adds nothing while Attache has no memory for sessions, and leaves the conversation as it is", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    expect(await ext.context([user("hello")], home)).toEqual([user("hello")]);
  });

  it("another Attache instance's extension gives its own instance's memory", async () => {
    const other = tempDir("attache-pi-other-state-");
    writeContextFiles(stateDir, "Mine\n", []);
    writeContextFiles(other, "Theirs\n", []);
    pi().apply();
    piFor(other).apply();
    const files = readdirSync(EXTENSIONS()).map((f) => join(EXTENSIONS(), f));
    const sent = await Promise.all(files.map(async (f) => memoryOf(await (await loadExtension(f)).context([user("hi")], home))[0]!.content));
    expect(sent.sort()).toEqual(["<attache-memory>\nMine\n</attache-memory>", "<attache-memory>\nTheirs\n</attache-memory>"]);
  });
});

describe("saving Pi sessions", () => {
  // Session capture follows the Agent sessions feature, as memory does: the service keeps these files only while it is on.
  beforeEach(() => writeContextFiles(stateDir, "Memory\n", []));

  const spooled = () => listSpool(stateDir).map((r) => ({ event: r.event, agent: r.agent, sessionId: r.sessionId, cwd: r.cwd, parsed: parsePi(readFileSync(spoolCopyPath(stateDir, r)!, "utf8")) }));

  /** Pi's session manager as an extension's handlers see it: one session file, its header and its current branch. */
  function piSession(branch: unknown[], opts: { file?: string | undefined; header?: Record<string, unknown> } = {}) {
    const header = opts.header ?? HEADER;
    const file = "file" in opts ? opts.file : at("sessions", "s.jsonl");
    const sessionManager = { getSessionFile: () => file, getSessionId: () => header.id, getHeader: () => header, getBranch: () => structuredClone(branch), getCwd: () => header.cwd };
    return { ctx: { cwd: at("work"), sessionManager }, branch };
  }

  it("spools the session's whole branch when Pi settles after a run, for the service to save", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    const entries = normal();
    await ext.emit("agent_settled", { aborted: false }, piSession(entries.slice(0, 5)).ctx);
    await ext.emit("agent_settled", { aborted: false }, piSession(entries).ctx);
    const [first, second] = spooled();
    expect(first).toMatchObject({ event: "turn-end", agent: "pi", sessionId: HEADER.id, cwd: "/work/orion" });
    expect(first!.parsed.turns.map((t) => t.text)).toEqual(["Should the cutover wait for the audit?", "Yes: we decided to wait, because the audit closes Friday."]);
    expect(second!.parsed.turns).toHaveLength(4);
    expect(second!.parsed.problem).toBeUndefined();
  });

  it("spools before a compaction, and once more when the session closes: a session end on quitting or leaving it, a turn's end on a reload", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    const { ctx } = piSession(normal());
    await ext.emit("session_before_compact", { reason: "manual", willRetry: false }, ctx);
    await ext.emit("session_shutdown", { reason: "reload" }, ctx);
    for (const reason of ["quit", "new", "resume", "fork"]) await ext.emit("session_shutdown", { reason }, ctx);
    expect(spooled().map((r) => [r.event, r.parsed.turns.length])).toEqual([
      ["pre-compact", 4],
      ["turn-end", 4],
      ["session-end", 4],
      ["session-end", 4],
      ["session-end", 4],
      ["session-end", 4],
    ]);
  });

  it("never spools a session Pi keeps no file for: --no-session runs, as Pi's subagent example starts its subagents", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    const { ctx } = piSession(normal(), { file: undefined });
    await ext.emit("agent_settled", { aborted: false }, ctx);
    await ext.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(spooled()).toEqual([]);
  });

  it("a session cloned or forked from another names where it left its parent, so only its own turns are saved under it", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    const parent = normal();
    const parentFile = at("sessions", "parent.jsonl");
    write(parentFile, [HEADER, ...parent].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const child = [...parent, user("In the clone", 10), assistant([text("Cloned answer")], 11)];
    const { ctx } = piSession(child, { header: { ...HEADER, id: "child-session", parentSession: parentFile } });
    await ext.emit("agent_settled", { aborted: false }, ctx);
    const [r] = spooled();
    expect(r).toMatchObject({ sessionId: "child-session" });
    expect(r!.parsed.turns.map((t) => t.text)).toEqual(["In the clone", "Cloned answer"]);
  });

  it("a clone whose parent session file is gone keeps all its turns: they are then the only copy", async () => {
    pi().apply();
    const ext = await loadExtension(ours());
    const { ctx } = piSession(normal(), { header: { ...HEADER, id: "child-session", parentSession: at("sessions", "deleted.jsonl") } });
    await ext.emit("agent_settled", { aborted: false }, ctx);
    expect(spooled()[0]!.parsed.turns).toHaveLength(4);
  });

  it("spools nothing while the Agent sessions feature is off, and never breaks the session when Pi's session manager fails", async () => {
    removeContextFiles(stateDir);
    pi().apply();
    const ext = await loadExtension(ours());
    await ext.emit("agent_settled", { aborted: false }, piSession(normal()).ctx);
    expect(spooled()).toEqual([]);
    writeContextFiles(stateDir, "Memory\n", []);
    const broken = { cwd: home, sessionManager: { getSessionFile: () => "/x.jsonl", getHeader: () => HEADER, getBranch: () => { throw new Error("stale ctx"); } } };
    await expect(ext.emit("agent_settled", { aborted: false }, broken)).resolves.toBeUndefined();
    await expect(ext.emit("session_shutdown", { reason: "quit" }, {})).resolves.toBeUndefined();
    expect(spooled()).toEqual([]);
  });

  it("another Attache instance's extension spools into its own instance", async () => {
    const other = tempDir("attache-pi-other-state-");
    writeContextFiles(other, "Theirs\n", []);
    pi().apply();
    piFor(other).apply();
    for (const f of readdirSync(EXTENSIONS())) await (await loadExtension(join(EXTENSIONS(), f))).emit("agent_settled", { aborted: false }, piSession(normal()).ctx);
    expect(listSpool(stateDir)).toHaveLength(1);
    expect(listSpool(other)).toHaveLength(1);
  });
});
