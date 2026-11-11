import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { accessOutsideOwner } from "../helpers.ts";
import { join, sep } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;
const MAIN = join(import.meta.dirname, "../../src/main.ts");

/**
 * Run the real CLI the way an agent's shell does: JSON on stdin, pinned to the
 * test service's state folder. Asynchronous, because the service it talks to
 * runs in this process.
 */
function cli(args: string[], input = "", env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args, "--state-dir", svc.stateDir], { env: { ...clean, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for October" }, { subject: "Owner", value: "Ada" }, { subject: "Repositories", value: "acme/orion" }] }] });
});
afterAll(async () => {
  await svc?.stop();
});

describe("saving from a Harness", () => {
  it("creates a new note and corrects an existing one in one save, citing the session", async () => {
    const r = await svc.post("/memory/save", {
      origin: { agent: "claude-code", sessionId: "sess-1", cwd: "/Users/alex/code/jarvis" },
      items: [
        { action: "create", type: "decision", title: "CLI writes go through the service", facts: [{ subject: "Decision", value: "jarvis save posts to the running service instead of writing files" }], notes: "The service holds the data folder's writer lock.", events: ["Agreed while adding jarvis save"] },
        { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }], events: ["Vendor slipped the cutover by a month"] },
      ],
    });
    expect(r.saved.map((s: any) => [s.action, s.relPath, s.facts, s.events])).toEqual([
      ["created", "memory/decisions/cli-writes-go-through-the-service.md", 1, 1],
      ["updated", "memory/projects/orion-migration.md", 1, 1],
    ]);
    const decision = readFileSync(join(svc.dataDir, "memory/decisions/cli-writes-go-through-the-service.md"), "utf8");
    expect(decision).toContain("provenance: agent-saved");
    expect(decision).toContain("kind: agent-session");
    expect(decision).toMatch(/\*\*Decision\*\* \(\d{4}-\d{2}-\d{2}\): jarvis save posts to the running service/);
    expect(decision).toContain("The service holds the data folder's writer lock.");
    expect(decision).toMatch(/— Agreed while adding jarvis save \(source: Claude Code session in jarvis \(agent-session: claude-code\/sess-1/);
    const orion = readFileSync(join(svc.dataDir, "memory/projects/orion-migration.md"), "utf8");
    expect(orion).toMatch(/\*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Cutover moved to November — source: Claude Code session in jarvis/);
    // The old value is kept in History, not left looking current.
    expect(orion).toMatch(/\*\*Status\*\* was "Cutover planned for October".*superseded: vendor delay/);
    expect(orion.match(/Cutover planned for October/g)).toHaveLength(1);
    // Recall sees the new value straight away.
    const hits = (await svc.get(`/memory/search?q=${encodeURIComponent("Orion cutover")}`)).hits;
    expect(hits[0].snippet).toContain("November");
  });

  it("rejects the whole save when one item is wrong, writing nothing", async () => {
    const before = svc.app.memory.listDocuments({ area: "memory" }).length;
    const r = await svc.call("POST", "/memory/save", {
      items: [
        { action: "create", type: "note", title: "Should not be written", facts: [{ subject: "Fact", value: "x" }] },
        { action: "update", path: "memory/projects/does-not-exist.md", events: ["x"] },
      ],
    });
    expect(r.status).toBe(404);
    expect(r.body.error.message).toContain("does not exist");
    expect(svc.app.memory.listDocuments({ area: "memory" }).length).toBe(before);
  });

  it("refuses a second note with the same title, outside memory, the identity record and repeated subjects", async () => {
    const dup = await svc.call("POST", "/memory/save", { items: [{ action: "create", type: "project", title: "Orion Migration", facts: [{ subject: "Status", value: "x" }] }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain("memory/projects/orion-migration.md");
    const outside = await svc.call("POST", "/memory/save", { items: [{ action: "update", path: "evidence/captures/x.md", events: ["x"] }] });
    expect(outside.status).toBe(400);
    const escape = await svc.call("POST", "/memory/save", { items: [{ action: "update", path: "../outside.md", events: ["x"] }] });
    expect(escape.status).toBe(400);
    await svc.post("/setup/identity", { name: "Alex", confirm: true });
    const self = await svc.call("POST", "/memory/save", { items: [{ action: "update", path: "memory/self.md", facts: [{ subject: "Role", value: "x", reason: "x" }] }] });
    expect(self.status).toBe(403);
    const sameNew = await svc.call("POST", "/memory/save", { items: [0, 1].map(() => ({ action: "create", type: "note", title: "Same new note", facts: [{ subject: "A", value: "1" }] })) });
    expect(sameNew.status).toBe(400);
    expect(sameNew.body.error.message).toContain("twice");
    const twice = await svc.call("POST", "/memory/save", { items: [{ action: "create", type: "note", title: "Twice", facts: [{ subject: "A", value: "1" }, { subject: "a", value: "2" }] }] });
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toContain("twice");
  });
});

describe("auditing memory", () => {
  it("flags stale, unsourced and missing-source facts, and points at newer evidence", async () => {
    // A fact past its Review date, from a capture that has since been deleted.
    await svc.post("/memory/save", { items: [{ action: "create", type: "project", title: "Helios budget", facts: [{ subject: "Budget", value: "40k EUR" }] }] });
    const rel = "memory/projects/helios-budget.md";
    const file = join(svc.dataDir, rel);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\*\*Budget\*\* \(\d{4}-\d{2}-\d{2}\): 40k EUR/, "**Budget** (2026-01-05, review 2026-02-01): 40k EUR — source: (capture: evidence/captures/2026-01-05-gone.md, observed 2026-01-05)"));
    svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, rel);
    // Newer evidence that disagrees.
    const captured = "evidence/captures/helios-steering.md";
    writeFileSync(join(svc.dataDir, captured), `---\ntype: capture\ntitle: Helios steering\ncaptured_at: ${new Date().toISOString()}\n---\n# Helios steering\n\n> Helios budget was cut to 25k EUR at the steering meeting.\n`);
    svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, captured);
    const audit = await svc.get("/memory/audit");
    const helios = audit.findings.find((f: any) => f.relPath === rel);
    expect(helios.entries[0]).toMatchObject({ subject: "Budget", value: "40k EUR", date: "2026-01-05", review: "2026-02-01" });
    expect(helios.entries[0].flags).toEqual(expect.arrayContaining(["stale", "missing-source"]));
    expect(helios.entries[0].newerEvidence.map((e: any) => e.relPath)).toContain(captured);
    // Notes created without a source are unsupported, not contradicted.
    const orion = audit.findings.find((f: any) => f.relPath === "memory/projects/orion-migration.md");
    expect(orion.entries.find((e: any) => e.subject === "Owner").flags).toEqual(["unsourced"]);
    // Sessions in Orion's repository read its facts; Helios lists no repository, so no session does.
    expect(orion.inSessionIndex).toBe(true);
    expect(helios.inSessionIndex).toBe(false);
    expect(audit.counts.stale).toBeGreaterThanOrEqual(1);
    expect(audit.findings.some((f: any) => f.relPath === "memory/self.md")).toBe(false);
  });

  it("offers as newer evidence only passages that name the note and are dated after the fact", async () => {
    const dir = join(svc.dataDir, "memory/projects");
    const source = "evidence/captures/2026-03-01-tamarind-kickoff.md";
    writeFileSync(join(svc.dataDir, source), "---\ntype: capture\ntitle: Tamarind kickoff\ncaptured_at: 2026-03-01T09:00:00Z\n---\n# Tamarind kickoff\n\n> Tamarind rollout owner is Ingrid.\n");
    writeFileSync(
      join(dir, "tamarind-rollout.md"),
      `---\ntype: project\ntitle: Tamarind rollout\n---\n# Tamarind rollout\n\n## Current State\n- **Owner** (2026-03-01): Ingrid — source: (capture: ${source}, observed 2026-03-01)\n- **Budget** (2026-06-01): 90k EUR\n`,
    );
    // An old document copied in today: its file is new, what it says is not.
    mkdirSync(join(svc.dataDir, "evidence/archive/oldvault"), { recursive: true });
    writeFileSync(join(svc.dataDir, "evidence/archive/oldvault/tamarind.md"), "# Tamarind rollout\n\nTamarind rollout owner was Ingrid from the start.\n");
    // Dated before the fact, although the file was written today.
    writeFileSync(join(svc.dataDir, "evidence/captures/2026-02-10-tamarind-early.md"), "---\ntype: capture\ntitle: Tamarind early talk\ncaptured_at: 2026-02-10T09:00:00Z\n---\n# Tamarind early talk\n\n> Tamarind rollout owner might be Stellan.\n");
    // Dated after the fact and names the note: a real lead.
    const later = "evidence/captures/2026-04-20-tamarind-handover.md";
    writeFileSync(join(svc.dataDir, later), "---\ntype: capture\ntitle: Tamarind handover\ncaptured_at: 2026-04-20T09:00:00Z\n---\n# Tamarind handover\n\n> Tamarind rollout owner is now Bao.\n");
    // Shares the subject's word but is about something else.
    writeFileSync(join(svc.dataDir, "evidence/captures/2026-05-01-kiosk.md"), "---\ntype: capture\ntitle: Kiosk refit\ncaptured_at: 2026-05-01T09:00:00Z\n---\n# Kiosk refit\n\n> The owner of the kiosk refit is Dmitri.\n");
    // Another note's current fact, dated later, is a lead; its undated prose is not.
    writeFileSync(join(svc.dataDir, "memory/people/bao.md"), "---\ntype: person\ntitle: Bao\n---\n# Bao\n\n## Current State\n- **Role** (2026-04-21): Owner of the Tamarind rollout\n\n## Notes\nBao once asked who the Tamarind rollout owner was.\n");
    svc.app.memory.indexer.scan(svc.app.memory.rootRef!);

    const audit = await svc.get("/memory/audit");
    const note = audit.findings.find((f: any) => f.relPath === "memory/projects/tamarind-rollout.md");
    const owner = note.entries.find((e: any) => e.subject === "Owner");
    expect(owner.newerEvidence.map((e: any) => `${e.relPath}:${e.startLine}`).sort()).toEqual([`${later}:8`, "memory/people/bao.md:8"]);
    expect(owner.newerEvidence.find((e: any) => e.relPath === later).modified).toBe("2026-04-20T00:00:00.000Z");
    // The later capture predates the budget fact, so it cannot overturn it.
    const budget = note.entries.find((e: any) => e.subject === "Budget");
    expect(budget.newerEvidence).toEqual([]);
  });

  it("reports notes whose titles reduce to the same name", async () => {
    const dir = join(svc.dataDir, "memory/notes");
    writeFileSync(join(dir, "kitchen-renovation.md"), "---\ntype: note\ntitle: Kitchen renovation\n---\n# Kitchen renovation\n\n## Current State\n- **Status** (2026-09-01): Quotes in\n");
    writeFileSync(join(dir, "kitchen-renovation-2.md"), "---\ntype: note\ntitle: Kitchen Renovation!\n---\n# Kitchen Renovation!\n\n## Current State\n- **Status** (2026-09-20): Builder booked\n");
    for (const f of ["kitchen-renovation.md", "kitchen-renovation-2.md"]) svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, `memory/notes/${f}`);
    const audit = await svc.get("/memory/audit");
    expect(audit.possibleDuplicates).toContainEqual({ title: expect.any(String), relPaths: ["memory/notes/kitchen-renovation-2.md", "memory/notes/kitchen-renovation.md"] });
  });
});

describe("the terminal commands", () => {
  it("has no save command, because a save is confirmed in a Harness", async () => {
    const r = await cli(["save"], JSON.stringify({ items: [{ action: "create", type: "note", title: "From a shell", facts: [{ subject: "How", value: "x" }] }] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown command save");
    expect(r.stderr).not.toMatch(/Commands: .*\bsave\b/);
    expect(existsSync(join(svc.dataDir, "memory/notes/from-a-shell.md"))).toBe(false);
  });

  it("search finds curated memory from a terminal", async () => {
    const r = await cli(["search", "Orion cutover", "--json"]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as Array<{ file: string }>).some((h) => h.file === join(svc.dataDir, "memory/projects/orion-migration.md"))).toBe(true);
  });

  it("audit pairs itself on first use and keeps its token in the state folder", async () => {
    const r = await cli(["audit", "--json"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(accessOutsideOwner(join(svc.stateDir, "cli-token"))).toEqual([]);
    const clients = svc.app.db.prepare("select name, kind from clients where revoked_at is null").all() as Array<{ name: string; kind: string }>;
    expect(clients).toContainEqual({ name: "Jarvis CLI", kind: "cli" });
  });

  it("audit re-pairs when its token was revoked", async () => {
    svc.app.db.prepare("update clients set revoked_at = ? where name = 'Jarvis CLI'").run(new Date().toISOString());
    const r = await cli(["audit", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).findings.length).toBeGreaterThan(0);
  });

  it("audit says how to start Jarvis when it is not running", async () => {
    const rt = join(svc.stateDir, "runtime.json");
    const saved = readFileSync(rt, "utf8");
    writeFileSync(rt, JSON.stringify({ ...JSON.parse(saved), pid: 999_999 }));
    try {
      const r = await cli(["audit"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("jarvis start");
    } finally {
      writeFileSync(rt, saved);
    }
  });

  it("audit prints a readable report with absolute paths, and JSON on request", async () => {
    const text = (await cli(["audit"])).stdout;
    expect(text).toMatch(/^Jarvis memory audit: \d+ notes, \d+ current facts, stale = past its Review date/);
    expect(text).toContain(`## Orion migration [project, in a project's session context]`);
    expect(text).toContain(`## Helios budget [project]`);
    expect(text).toMatch(/- Budget \(2026-01-05, review 2026-02-01, \d+ days, line \d+\): 40k EUR .*\{stale, missing-source\}/);
    expect(text).toContain(`newer: ${join(svc.dataDir, "evidence", "captures")}${sep}`);
    const json = JSON.parse((await cli(["audit", "--json"])).stdout);
    expect(json).not.toHaveProperty("staleDays");
    expect(existsSync(json.findings[0].absPath)).toBe(true);
  });

  it("audit has no day threshold to set", async () => {
    expect((await cli(["audit", "--help"])).stdout).not.toContain("stale-days");
    const r = await cli(["audit", "--stale-days", "400"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown option --stale-days");
  });

  it("audit leaves the data folder untouched", async () => {
    const file = join(svc.dataDir, "memory/projects/helios-budget.md");
    const past = new Date("2026-02-01T00:00:00Z");
    utimesSync(file, past, past);
    const before = readFileSync(file, "utf8");
    expect((await cli(["audit", "--json"])).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statSync(file).mtime.toISOString()).toBe(past.toISOString());
  });
});
