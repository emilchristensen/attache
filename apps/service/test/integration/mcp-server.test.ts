import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

type Passage = { path: string; startLine: number; endLine: number; section: string; heading: string | null; title: string; text: string };
type Note = { path: string; title: string; startLine: number; endLine: number; totalLines: number; text: string };

let svc: TestService;
const mcp = mcpClients();
const connect = (stateDir: string) => mcp.connect(stateDir);

/** Write a file into the Brain by hand, as another tool would. */
function writeBrainFile(rel: string, text: string) {
  mkdirSync(dirname(join(svc.dataDir, rel)), { recursive: true });
  writeFileSync(join(svc.dataDir, rel), text);
}

/** Wait until the service has indexed every hand-written file. */
async function indexed(query: string, relPaths: string[], timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const hits: Array<{ relPath: string }> = (await svc.get(`/memory/search?limit=50&q=${encodeURIComponent(query)}`)).hits;
    if (relPaths.every((p) => hits.some((h) => h.relPath === p))) return;
    if (Date.now() > end) throw new Error(`not indexed: ${relPaths.join(", ")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every file under a folder, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", {
    items: [
      { action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for November" }, { subject: "Owner", value: "Grace" }], events: ["Kick-off held"] },
      { action: "create", type: "person", title: "Grace Hopper", facts: [{ subject: "Role", value: "Leads the Orion cutover" }] },
    ],
  });
  writeBrainFile("evidence/conversations/2026-11-01-orion.md", "# Chat about Orion\n\nuser: when is the Orion cutover?\n");
  writeBrainFile("evidence/sessions/transcripts/claude-code/2026-11-02-orion.md", "# Orion session transcript\n\nuser: move the Orion cutover\n");
  writeBrainFile("evidence/sessions/2026-11-02.md", "# Sessions 2026-11-02\n\n## Claude Code\n\n- Decided the Orion cutover stays in November.\n");
  await indexed("Orion cutover", ["memory/projects/orion-migration.md", "evidence/conversations/2026-11-01-orion.md", "evidence/sessions/transcripts/claude-code/2026-11-02-orion.md", "evidence/sessions/2026-11-02.md"]);
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("Jarvis MCP server", () => {
  it("starts through the jarvis executable and lists its tools", async () => {
    const client = await connect(svc.stateDir);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["audit", "read", "save", "search", "wrap_up"]));
  });

  it("searches the Brain and returns passages with path, line range, section kind and note title", async () => {
    const client = await connect(svc.stateDir);
    const r = await callTool<{ passages: Passage[] }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    const status = r.data.passages.find((p) => p.path === "memory/projects/orion-migration.md" && p.text.includes("Cutover planned for November"));
    expect(status).toMatchObject({ section: "state", title: "Orion migration" });
    expect(status!.endLine).toBeGreaterThanOrEqual(status!.startLine);
    // The cited lines hold the passage.
    const lines = readFileSync(join(svc.dataDir, status!.path), "utf8").split("\n").slice(status!.startLine - 1, status!.endLine).join("\n");
    expect(lines).toContain("Cutover planned for November");
    expect(r.text).toContain(`memory/projects/orion-migration.md:${status!.startLine}-${status!.endLine}`);
    // Summaries are searchable; raw chat and session transcripts are not.
    const paths = r.data.passages.map((p) => p.path);
    expect(paths).toContain("evidence/sessions/2026-11-02.md");
    expect(paths.filter((p) => p.startsWith("evidence/conversations/") || p.startsWith("evidence/sessions/transcripts/"))).toEqual([]);
  });

  it("says when results match keywords only, because meaning-based search is not ready yet", async () => {
    const client = await connect(svc.stateDir);
    const r = await callTool<{ passages: Passage[]; meaning: { state: string; note: string | null } }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.meaning.state).toBe("missing");
    expect(r.data.meaning.note).toMatch(/keywords only.*not downloaded/);
    expect(r.text.split("\n")[0]).toBe(r.data.meaning.note);
    expect(r.data.passages.length).toBeGreaterThan(0);
  });

  it("says when nothing matches", async () => {
    const client = await connect(svc.stateDir);
    const r = await callTool<{ passages: Passage[] }>(client, "search", { query: "xylophone" });
    expect(r.isError).toBe(false);
    expect(r.data.passages).toEqual([]);
    expect(r.text).toContain('No passages in the Brain match "xylophone"');
  });

  it("reads a whole note, or only the requested line range", async () => {
    const client = await connect(svc.stateDir);
    const raw = readFileSync(join(svc.dataDir, "memory/projects/orion-migration.md"), "utf8");
    const whole = await callTool<Note>(client, "read", { path: "memory/projects/orion-migration.md" });
    expect(whole.isError).toBe(false);
    expect(whole.data).toMatchObject({ path: "memory/projects/orion-migration.md", title: "Orion migration", startLine: 1, text: raw.replace(/\n$/, "") });
    expect(whole.data.endLine).toBe(whole.data.totalLines);

    const { passages } = (await callTool<{ passages: Passage[] }>(client, "search", { query: "Orion owner Grace" })).data;
    const owner = passages.find((p) => p.path === "memory/projects/orion-migration.md" && p.text.includes("Grace"))!;
    const part = await callTool<Note>(client, "read", { path: owner.path, startLine: owner.startLine, endLine: owner.endLine });
    expect(part.data.text).toBe(raw.split("\n").slice(owner.startLine - 1, owner.endLine).join("\n"));
    expect(part.data.text).toContain("Grace");
    expect(part.data.text).not.toContain("Cutover planned");
    expect(part.text).toContain(`lines ${owner.startLine}-${owner.endLine} of ${whole.data.totalLines}`);

    // A range past the end is clamped; one that starts past the end is refused.
    expect((await callTool<Note>(client, "read", { path: owner.path, startLine: owner.startLine, endLine: 9999 })).data.endLine).toBe(whole.data.totalLines);
    const past = await callTool<Note>(client, "read", { path: owner.path, startLine: 9999 });
    expect(past.isError).toBe(true);
    expect(past.text).toContain(`has ${whole.data.totalLines} lines`);
  });

  it("reads by absolute path inside the Brain, and refuses paths outside it", async () => {
    const client = await connect(svc.stateDir);
    const abs = await callTool<Note>(client, "read", { path: join(svc.dataDir, "memory/people/grace-hopper.md") });
    expect(abs.isError).toBe(false);
    expect(abs.data.text).toContain("Leads the Orion cutover");
    const missing = await callTool<Note>(client, "read", { path: "memory/projects/nothing.md" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no longer exists");
    for (const path of ["../../etc/passwd", `${svc.dataDir}/../../etc/passwd`, "/etc/passwd"]) {
      const r = await callTool<Note>(client, "read", { path });
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("root:");
    }
  });

  it("tells the Harness who the owner is and which notes the Brain holds", async () => {
    const client = await connect(svc.stateDir);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Ada Lovelace <ada@example.com>");
    expect(instructions).toMatch(/Projects: .*Orion migration/);
    expect(instructions).toMatch(/People: .*Grace Hopper/);
    // The identity record is the owner line, not an entry in the index.
    expect(instructions.match(/Ada Lovelace/g)).toHaveLength(1);
  });

  it("writes no token into any Harness configuration", async () => {
    const client = await connect(svc.stateDir);
    expect((await callTool(client, "search", { query: "Orion" })).isError).toBe(false);
    // The server paired itself, like the CLI, and keeps the token in the state folder only.
    const tokenFile = join(svc.stateDir, "cli-token");
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(token.length).toBeGreaterThan(10);
    expect(statSync(tokenFile).mode & 0o077).toBe(0);
    for (const file of filesUnder(process.env.JARVIS_AGENT_HOME!)) expect(readFileSync(file, "utf8")).not.toContain(token);
  });
});

describe("Jarvis MCP server while the service is stopped", () => {
  it("still starts, each tool says how to start Jarvis, and the tools work once it runs", async () => {
    const stopped = await startTestService();
    await stopped.post("/memory/save", { items: [{ action: "create", type: "note", title: "Quokka plan", facts: [{ subject: "Start", value: "The quokka rollout starts in March" }] }] });
    await stopped.stop();
    const client = await connect(stopped.stateDir);
    expect(client.getInstructions()).toContain("Start it with `jarvis start`");
    for (const [name, args] of [["search", { query: "quokka" }], ["read", { path: "memory/notes/quokka-plan.md" }], ["audit", {}]] as const) {
      const r = await callTool(client, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Jarvis is not running. Start it with `jarvis start`");
    }
    const again = await startTestService({ stateDir: stopped.stateDir, dataDir: stopped.dataDir });
    try {
      const r = await callTool<{ passages: Passage[] }>(client, "search", { query: "quokka" });
      expect(r.isError).toBe(false);
      expect(r.data.passages.map((p) => p.path)).toContain("memory/notes/quokka-plan.md");
    } finally {
      await again.stop();
    }
  });

  it("still starts when Jarvis has never run in its state folder", async () => {
    const client = await connect(join(tmpdir(), `jarvis-never-${Math.random().toString(36).slice(2)}`));
    const r = await callTool(client, "search", { query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Start it with `jarvis start`");
  });

  it("says how to start Jarvis when the service stopped without cleaning up", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "jarvis-crashed-"));
    // A runtime file left behind, naming a live process that no longer listens.
    writeFileSync(join(stateDir, "runtime.json"), JSON.stringify({ pid: process.pid, port: 9, url: "http://127.0.0.1:9", version: "test", startedAt: new Date().toISOString(), instance: "crashed" }));
    const client = await connect(stateDir);
    expect(client.getInstructions()).toContain("start it with `jarvis start`");
    const r = await callTool(client, "read", { path: "memory/notes/anything.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("start it with `jarvis start`");
  });
});
