import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients, type HarnessClientOptions } from "./mcp-client.ts";

// Some tests start the `jarvis mcp` process from source eight times, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

type Saved = { action: "created" | "updated"; path: string; title: string; facts: number; events: number };
type SaveReply = { outcome: "saved" | "declined" | "proposed"; saved?: Saved[]; proposals?: Array<{ id: string; target: string }> };

const CLAUDE_CODE_SESSION = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "5f0c2a1e-session-orion" };

let svc: TestService;
const mcp = mcpClients();
const connect = (opts: HarnessClientOptions): Promise<Client> => mcp.connect(svc.stateDir, opts);

/** A Harness whose owner answers every confirmation with `action`, keeping what it was shown. */
function owner(action: ElicitResult["action"]) {
  const shown: Array<ElicitRequest["params"]> = [];
  return { shown, confirm: (params: ElicitRequest["params"]) => (shown.push(params), { action }) };
}

function brainFile(rel: string): string | null {
  const abs = join(svc.dataDir, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for November" }] }] });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("MCP save, confirmed in the Harness", () => {
  it("asks the owner first, listing the items, and writes them as the owner with the Harness and session as source", async () => {
    const answer = owner("accept");
    const client = await connect({ env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", {
      items: [
        { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Cutover moved to December", reason: "The vendor slipped" }], events: ["Cutover date moved"] },
        { action: "create", type: "person", title: "Grace Hopper", facts: [{ subject: "Role", value: "Leads the Orion cutover" }], notes: "Prefers mornings.", events: ["Joined the Orion team"], tags: ["orion"] },
      ],
    });

    expect(r.isError).toBe(false);
    expect(answer.shown).toHaveLength(1);
    const message = answer.shown[0]!.message;
    expect(message).toContain("Orion migration");
    expect(message).toContain("Status: Cutover moved to December");
    expect(message).toContain("The vendor slipped");
    expect(message).toContain("Cutover date moved");
    expect(message).toContain('New person "Grace Hopper"');
    expect(message).toContain("Role: Leads the Orion cutover");

    expect(r.data.outcome).toBe("saved");
    expect(r.data.saved).toEqual([
      { action: "updated", path: "memory/projects/orion-migration.md", title: "Orion migration", facts: 1, events: 1 },
      { action: "created", path: "memory/people/grace-hopper.md", title: "Grace Hopper", facts: 1, events: 1 },
    ]);
    expect(r.text).toContain("memory/people/grace-hopper.md");

    const project = brainFile("memory/projects/orion-migration.md")!;
    const status = project.split("\n").find((l) => l.includes("Cutover moved to December"))!;
    expect(status).toContain("Claude Code session");
    expect(status).toContain("claude-code/5f0c2a1e-session-orion");
    const person = brainFile("memory/people/grace-hopper.md")!;
    const role = person.split("\n").find((l) => l.includes("Leads the Orion cutover"))!;
    expect(role).toContain("Claude Code session");
    expect(person).toContain("Prefers mornings.");
    expect(person).toContain("Joined the Orion team");

    // The change log names the Harness and session, one batch for the whole save.
    const { changes } = await svc.get("/memory/recent-changes?limit=20");
    const mine = changes.filter((c: { relPath: string; newValue: string | null }) => ["memory/people/grace-hopper.md"].includes(c.relPath) || c.newValue === "Cutover moved to December");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const c of mine) expect(c.source).toMatchObject({ harness: "claude-code", harnessLabel: "Claude Code", sessionId: "5f0c2a1e-session-orion" });
  });

  it("writes nothing when the owner declines or closes the confirmation, and says so", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const before = brainFile("memory/projects/orion-migration.md");
      const answer = owner(action);
      const client = await connect({ env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
      const r = await callTool<SaveReply>(client, "save", {
        items: [
          { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Cancelled", reason: "Budget cut" }] },
          { action: "create", type: "note", title: `Declined plan ${action}`, facts: [{ subject: "Idea", value: "Never written" }] },
        ],
      });
      expect(answer.shown).toHaveLength(1);
      expect(r.isError).toBe(false);
      expect(r.data.outcome).toBe("declined");
      expect(r.text).toContain("nothing was written");
      expect(brainFile("memory/projects/orion-migration.md")).toBe(before);
      expect(brainFile(`memory/notes/declined-plan-${action}.md`)).toBeNull();
    }
  });

  it("rejects the whole save when one item is invalid, before asking the owner, with a message the agent can act on", async () => {
    const answer = owner("accept");
    const client = await connect({ env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const before = brainFile("memory/projects/orion-migration.md");
    const missing = await callTool<SaveReply>(client, "save", {
      items: [
        { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Half written", reason: "Should not land" }] },
        { action: "update", path: "memory/projects/apollo.md", events: ["Launched"] },
      ],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Nothing was saved");
    expect(missing.text).toContain("memory/projects/apollo.md does not exist. Search for the note, or create a new one.");

    const duplicate = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "project", title: "Orion Migration", facts: [{ subject: "Status", value: "Twin" }] }] });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain("already exists at memory/projects/orion-migration.md. Update it instead");

    const shape = await callTool<SaveReply>(client, "save", { items: [{ action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "No reason given" }] }] });
    expect(shape.isError).toBe(true);
    expect(shape.text).toContain("reason");

    expect(answer.shown).toEqual([]);
    expect(brainFile("memory/projects/orion-migration.md")).toBe(before);
  });

  it("never changes the identity record, not even when the owner would accept", async () => {
    const before = brainFile("memory/self.md");
    expect(before).toContain("Ada Lovelace");
    for (const path of ["memory/self.md", "./memory/self.md", "memory/people/../self.md", "memory/SELF.md"]) {
      for (const confirm of [owner("accept"), null]) {
        const client = await connect({ env: CLAUDE_CODE_SESSION, ...(confirm ? { confirm: confirm.confirm } : {}) });
        const r = await callTool<SaveReply>(client, "save", { items: [{ action: "update", path, facts: [{ subject: "Name", value: "Mallory", reason: "Takeover" }] }] });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("identity record");
        if (confirm) expect(confirm.shown).toEqual([]);
      }
    }
    expect(brainFile("memory/self.md")).toBe(before);
    const { proposals } = await svc.get("/memory/proposals?status=proposed");
    expect(proposals.filter((p: { target: string }) => p.target.toLowerCase().includes("self"))).toEqual([]);
  });
});

describe("MCP save from a Harness that cannot ask the owner", () => {
  it("stores each item as a Proposal citing the Harness, writes nothing, and says it awaits review", async () => {
    const before = brainFile("memory/projects/orion-migration.md");
    const client = await connect({ name: "claude-ai" });
    const r = await callTool<SaveReply>(client, "save", {
      items: [
        { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Budget", value: "Two million", reason: "Approved in the steering group" }] },
        { action: "create", type: "decision", title: "Orion freeze window", facts: [{ subject: "Decision", value: "No deploys in the last week of November" }], events: ["Agreed with ops"] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.data.outcome).toBe("proposed");
    expect(r.text).toContain("awaits the owner's review");
    expect(r.data.proposals!.map((p) => p.target)).toEqual(["memory/projects/orion-migration.md", "(new decision: Orion freeze window)"]);
    expect(brainFile("memory/projects/orion-migration.md")).toBe(before);
    expect(brainFile("memory/decisions/orion-freeze-window.md")).toBeNull();

    const { proposals } = await svc.get("/memory/proposals?status=proposed");
    const mine = proposals.filter((p: { id: string }) => r.data.proposals!.some((x) => x.id === p.id));
    expect(mine).toHaveLength(2);
    for (const p of mine) {
      expect(p.source).toContain("session");
      expect(p.reason).toContain("cannot ask you to confirm");
    }
    expect(mine.find((p: { target: string }) => p.target === "(new decision: Orion freeze window)").item).toMatchObject({ action: "create", title: "Orion freeze window", events: ["Agreed with ops"] });

    // Applying one in the Dashboard writes it, as the owner approved.
    const update = mine.find((p: { target: string }) => p.target === "memory/projects/orion-migration.md");
    await svc.post(`/memory/proposals/${update.id}/apply`, {});
    expect(brainFile("memory/projects/orion-migration.md")).toContain("Two million");
    const { changes } = await svc.get("/memory/recent-changes?limit=20");
    expect(changes.find((c: { newValue: string | null }) => c.newValue === "Two million").source).toMatchObject({ harness: "claude-desktop", sessionId: null });
  });

  it("stores Proposals when the Harness claims the confirmation request but cannot answer it", async () => {
    const client = await connect({ name: "half-done-harness", claimsConfirmation: true });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Unanswered idea", facts: [{ subject: "Idea", value: "Waits for review" }] }] });
    expect(r.isError).toBe(false);
    expect(r.data.outcome).toBe("proposed");
    expect(brainFile("memory/notes/unanswered-idea.md")).toBeNull();
    const { proposals } = await svc.get("/memory/proposals?status=proposed");
    expect(proposals.find((p: { id: string }) => p.id === r.data.proposals![0]!.id).proposedBy).toBe("half-done-harness");
  });

  it("stores no Proposal when one item is invalid", async () => {
    const client = await connect({ name: "claude-ai" });
    const count = async () => (await svc.get("/memory/proposals?status=proposed")).proposals.length;
    const before = await count();
    const r = await callTool<SaveReply>(client, "save", {
      items: [
        { action: "create", type: "note", title: "Valid half", facts: [{ subject: "Idea", value: "Would be proposed" }] },
        { action: "update", path: "evidence/sessions/2026-11-02.md", events: ["Not a memory note"] },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("is not a memory note");
    expect(await count()).toBe(before);
  });
});

describe("MCP save while Jarvis is stopped", () => {
  it("says how to start Jarvis", async () => {
    const stopped = await startTestService();
    await stopped.stop();
    const client = await mcp.connect(stopped.stateDir, { confirm: owner("accept").confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Lost", facts: [{ subject: "Idea", value: "Nowhere to go" }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Jarvis is not running. Start it with `jarvis start`");
  });
});
