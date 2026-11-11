import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients, promptText } from "./mcp-client.ts";

type Evidence = { path: string; title: string; startLine: number; endLine: number; snippet: string; modified: string };
type Fact = { subject: string; value: string; date: string; ageDays: number; source: string | null; line: number; flags: string[]; newerEvidence: Evidence[] };
type Finding = { path: string; title: string; type: string; inSessionIndex: boolean; flags: string[]; entries: Fact[] };
type Audit = { notes: number; entries: number; counts: Record<string, number>; findings: Finding[]; possibleDuplicates: Array<{ title: string; paths: string[] }> };

let svc: TestService;
const mcp = mcpClients();

const NOTE = "memory/projects/tamarind-rollout.md";
const LATER = "evidence/captures/2026-04-20-tamarind-handover.md";

function writeBrainFile(rel: string, text: string) {
  mkdirSync(dirname(join(svc.dataDir, rel)), { recursive: true });
  writeFileSync(join(svc.dataDir, rel), text);
}

/** Every file in the Brain with its content and modification time. */
function brainSnapshot(): Map<string, string> {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  return new Map(walk(svc.dataDir).map((f) => [relative(svc.dataDir, f), `${statSync(f).mtimeMs} ${readFileSync(f, "utf8")}`]));
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  writeBrainFile(
    NOTE,
    "---\ntype: project\ntitle: Tamarind rollout\n---\n# Tamarind rollout\n\n## Current State\n" +
      "- **Owner** (2026-03-01): Ingrid — source: (capture: evidence/captures/2026-03-01-gone.md, observed 2026-03-01)\n" +
      "- **Budget** (2026-06-01): 90k EUR\n",
  );
  writeBrainFile(LATER, "---\ntype: capture\ntitle: Tamarind handover\ncaptured_at: 2026-04-20T09:00:00Z\n---\n# Tamarind handover\n\n> Tamarind rollout owner is now Bao.\n");
  svc.app.memory.indexer.scan(svc.app.memory.rootRef!);
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("the MCP audit tool", () => {
  it("returns every current fact with its date, source, flags and newer evidence", async () => {
    const client = await mcp.connect(svc.stateDir);
    const r = await callTool<Audit>(client, "audit", {});
    expect(r.isError).toBe(false);
    const note = r.data.findings.find((f) => f.path === NOTE)!;
    expect(note).toMatchObject({ title: "Tamarind rollout", type: "project" });
    expect(note.entries.map((e) => e.subject)).toEqual(["Owner", "Budget"]);
    const owner = note.entries[0]!;
    expect(owner).toMatchObject({ value: "Ingrid", date: "2026-03-01", source: "(capture: evidence/captures/2026-03-01-gone.md, observed 2026-03-01)", line: 8 });
    expect(owner.flags).toContain("missing-source");
    // Evidence paths are the ones `read` takes.
    expect(owner.newerEvidence).toEqual([expect.objectContaining({ path: LATER, startLine: 8, modified: "2026-04-20T00:00:00.000Z" })]);
    const budget = note.entries[1]!;
    expect(budget).toMatchObject({ value: "90k EUR", date: "2026-06-01", source: null });
    expect(budget.flags).toContain("unsourced");
    expect(r.data.counts["missing-source"]).toBe(1);
    // Months old, but neither fact has a Review date: neither is stale, and no day threshold is reported.
    expect([...owner.flags, ...budget.flags]).not.toContain("stale");
    expect(r.data).not.toHaveProperty("staleDays");
    // The identity record is not audited.
    expect(r.data.findings.map((f) => f.path)).not.toContain("memory/self.md");

    // The text a model reads carries the same facts, with paths it can pass to `read`.
    expect(r.text).toMatch(/Jarvis memory audit: \d+ notes, \d+ current facts/);
    expect(r.text).toContain(`## Tamarind rollout [project`);
    expect(r.text).toContain(NOTE);
    expect(r.text).toMatch(/- Owner \(2026-03-01, \d+ days, line 8\): Ingrid — source: .*\{.*missing-source.*\}/);
    expect(r.text).toContain(`newer: ${LATER}:8-8 (2026-04-20)`);
    expect(r.text).not.toContain(svc.dataDir);
  });

  it("writes nothing", async () => {
    const client = await mcp.connect(svc.stateDir);
    const audit = (await client.listTools()).tools.find((t) => t.name === "audit")!;
    expect(audit.annotations).toMatchObject({ readOnlyHint: true });
    const before = brainSnapshot();
    const changes = (await svc.get("/memory/changes?limit=200")).length;
    expect((await callTool(client, "audit", {})).isError).toBe(false);
    expect(brainSnapshot()).toEqual(before);
    expect((await svc.get("/memory/changes?limit=200")).length).toBe(changes);
  });
});

/** What the prompts must never ask for: a shell command, or a file edit in the Brain. */
const SHELL = [/\bjarvis (save|audit|search|start)\b/, /<<\s*'?JSON/, /^ {4}\S/m, /\$\(/, /\bcurl\b/];

describe("the MCP save and audit prompts", () => {
  it("are listed and fetched by a real MCP client", async () => {
    const client = await mcp.connect(svc.stateDir);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(["save", "audit"]));
    const save = prompts.find((p) => p.name === "save")!;
    expect(save.description).toBeTruthy();
    expect(save.arguments?.map((a) => ({ name: a.name, required: a.required ?? false }))).toEqual([{ name: "focus", required: false }]);
    expect(prompts.find((p) => p.name === "audit")!.arguments?.map((a) => a.name)).toEqual(["topic"]);
    for (const name of ["save", "audit"]) {
      const { messages } = await client.getPrompt({ name, arguments: {} });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: "user", content: { type: "text" } });
    }
  });

  it("save tells the agent to search before creating, to sort items into facts and events, and to use the save tool", async () => {
    const client = await mcp.connect(svc.stateDir);
    const text = await promptText(client, "save");
    expect(text).toMatch(/search the Brain with the `search` tool for every person, project and decision/i);
    expect(text).toMatch(/before you create/i);
    expect(text).toContain("A **fact** has one current value");
    expect(text).toContain("An **event** is something that happened");
    expect(text).toMatch(/`facts`/);
    expect(text).toMatch(/`events`/);
    expect(text).toMatch(/call the `save` tool once with every item/i);
    // The example is the save tool's own argument shape.
    const example = JSON.parse(/```json\n([\s\S]+?)\n```/.exec(text)![1]!);
    expect(example.items.map((i: { action: string }) => i.action)).toEqual(["create", "update"]);
    expect(text).not.toMatch(/\{\{|\$\{/);
  });

  it("save passes on what the owner asked to focus on", async () => {
    const client = await mcp.connect(svc.stateDir);
    expect(await promptText(client, "save", { focus: "the Tamarind budget decision" })).toContain("Focus on: the Tamarind budget decision");
    expect(await promptText(client, "save")).not.toContain("Focus on:");
  });

  it("audit tells the agent to show corrections to the owner first and to make them through the save tool", async () => {
    const client = await mcp.connect(svc.stateDir);
    const text = await promptText(client, "audit");
    expect(text).toMatch(/call the `audit` tool/i);
    expect(text).toMatch(/show (each|every) correction to the owner first/i);
    expect(text).toMatch(/only after the owner says yes/i);
    expect(text).toMatch(/through the `save` tool/i);
    expect(text).toMatch(/call the `audit` tool again/i);
    expect(text).toContain("`stale`: past its Review date");
    expect(text).toContain("A fact without a Review date is never stale");
    expect(text).not.toMatch(/stale-days|60 days/);
    expect(await promptText(client, "audit", { topic: "Tamarind" })).toContain("Limit the audit to: Tamarind");
  });

  it("neither prompt tells the agent to run a shell command or edit files in the Brain", async () => {
    const client = await mcp.connect(svc.stateDir);
    for (const name of ["save", "audit"]) {
      const text = await promptText(client, name);
      for (const pattern of SHELL) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      // Code blocks hold tool arguments only.
      const blocks = [...text.matchAll(/```(\w*)\n[\s\S]*?\n```/g)].map((m) => m[1]);
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((lang) => lang === "json")).toBe(true);
      expect(text).toContain("Never write, edit or delete files in the Brain yourself");
      expect(text).not.toMatch(/\b(run|execute)\b[^.\n]*\b(command|terminal|shell)\b/i);
    }
  });
});
