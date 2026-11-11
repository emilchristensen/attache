import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;
const read = (rel: string) => readFileSync(join(svc.dataDir, rel), "utf8");
const session = { kind: "agent-session", ref: "claude-code/sess-7", observedAt: "2026-11-10T09:00:00.000Z", label: "Claude Code session in jarvis" };

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Atlas rollout", facts: [{ subject: "Status", value: "Pilot in Copenhagen" }, { subject: "Owner", value: "Mia" }] }] });
});
afterAll(async () => {
  await svc?.stop();
});

describe("a Proposal holds a whole save item", () => {
  it("proposes a new note with several facts and events, writes nothing until applied, then writes every part", async () => {
    const proposal = await svc.post("/memory/proposals", {
      item: {
        action: "create",
        type: "decision",
        title: "Atlas uses Postgres",
        facts: [
          { subject: "Decision", value: "Atlas stores rollout state in Postgres" },
          { subject: "Project", value: "Atlas rollout" },
        ],
        notes: "SQLite could not handle the concurrent writers.",
        events: ["Chosen after the load test"],
        tags: ["atlas"],
      },
      reason: "Decided in the session",
      source: session,
    });
    expect(proposal.status).toBe("proposed");
    expect(existsSync(join(svc.dataDir, "memory/decisions/atlas-uses-postgres.md"))).toBe(false);

    const { proposals } = await svc.get("/memory/proposals");
    const listed = proposals.find((p: any) => p.id === proposal.id);
    expect(listed.item.facts.map((f: any) => f.subject)).toEqual(["Decision", "Project"]);
    expect(listed.item.events).toEqual(["Chosen after the load test"]);
    expect(listed.reason).toBe("Decided in the session");
    expect(listed.source).toContain("Claude Code session in jarvis");

    const applied = await svc.post(`/memory/proposals/${proposal.id}/apply`);
    expect(applied.status).toBe("applied");
    expect(applied.target).toBe("memory/decisions/atlas-uses-postgres.md");
    const note = read("memory/decisions/atlas-uses-postgres.md");
    expect(note).toContain("provenance: user-approved");
    expect(note).toContain("kind: agent-session");
    expect(note).toMatch(/\*\*Decision\*\* \(\d{4}-\d{2}-\d{2}\): Atlas stores rollout state in Postgres — source: Claude Code session in jarvis/);
    expect(note).toMatch(/\*\*Project\*\* \(\d{4}-\d{2}-\d{2}\): Atlas rollout/);
    expect(note).toContain("SQLite could not handle the concurrent writers.");
    expect(note).toContain("tags:\n  - atlas");
    expect(note.split("## History")[1]).toMatch(/— Chosen after the load test \(source: Claude Code session in jarvis/);
    const after = (await svc.get("/memory/proposals")).proposals;
    expect(after.some((p: any) => p.id === proposal.id)).toBe(false);
  });
});

describe("deciding a Proposal", () => {
  it("applies an update with several facts and events in one click, keeping each superseded value in History", async () => {
    const proposal = await svc.post("/memory/proposals", {
      item: {
        action: "update",
        path: "memory/projects/atlas-rollout.md",
        facts: [
          { subject: "Status", value: "Live in Copenhagen and Aarhus", reason: "Aarhus went live" },
          { subject: "Owner", value: "Jonas", reason: "Mia moved team" },
          { subject: "Next step", value: "Odense in January", reason: "Agreed plan" },
        ],
        events: ["Aarhus cut over without downtime", "Mia handed over to Jonas"],
      },
      reason: "Rollout review",
      source: session,
    });
    expect(read("memory/projects/atlas-rollout.md")).toContain("Pilot in Copenhagen");
    await svc.post(`/memory/proposals/${proposal.id}/apply`);
    const note = read("memory/projects/atlas-rollout.md");
    const [current, history] = note.split("## History");
    expect(current).toMatch(/\*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Live in Copenhagen and Aarhus — source: Claude Code session in jarvis/);
    expect(current).toMatch(/\*\*Owner\*\* \(\d{4}-\d{2}-\d{2}\): Jonas/);
    expect(current).toMatch(/\*\*Next step\*\* \(\d{4}-\d{2}-\d{2}\): Odense in January/);
    expect(current).not.toContain("Pilot in Copenhagen");
    expect(history).toMatch(/\*\*Status\*\* was "Pilot in Copenhagen".*superseded: Aarhus went live/);
    expect(history).toMatch(/\*\*Owner\*\* was "Mia".*superseded: Mia moved team/);
    expect(history).toContain("Aarhus cut over without downtime (source: Claude Code session in jarvis");
    expect(history).toContain("Mia handed over to Jonas (source: Claude Code session in jarvis");
    const hits = (await svc.get(`/memory/search?q=${encodeURIComponent("Atlas owner")}`)).hits;
    expect(hits[0].snippet).toContain("Jonas");
  });

  it("rejecting writes nothing and takes the Proposal off the review list", async () => {
    const before = read("memory/projects/atlas-rollout.md");
    const update = await svc.post("/memory/proposals", { item: { action: "update", path: "memory/projects/atlas-rollout.md", facts: [{ subject: "Owner", value: "Priya", reason: "Rumour" }], events: ["Priya joined"] }, reason: "Overheard" });
    const create = await svc.post("/memory/proposals", { item: { action: "create", type: "person", title: "Priya Shah", facts: [{ subject: "Role", value: "Engineer" }] }, reason: "Mentioned" });
    expect((await svc.post(`/memory/proposals/${update.id}/reject`)).status).toBe("rejected");
    expect((await svc.post(`/memory/proposals/${create.id}/reject`)).status).toBe("rejected");
    expect(read("memory/projects/atlas-rollout.md")).toBe(before);
    expect(existsSync(join(svc.dataDir, "memory/people/priya-shah.md"))).toBe(false);
    const pending = (await svc.get("/memory/proposals")).proposals.map((p: any) => p.id);
    expect(pending).not.toContain(update.id);
    expect(pending).not.toContain(create.id);
    const again = await svc.call("POST", `/memory/proposals/${update.id}/apply`);
    expect(again.status).toBe(409);
    expect(read("memory/projects/atlas-rollout.md")).toBe(before);
  });

  it("passes the same validation as a save when it is made", async () => {
    await svc.post("/setup/identity", { name: "Alex", confirm: true });
    const propose = (item: unknown) => svc.call("POST", "/memory/proposals", { item, reason: "invalid on purpose" });
    const self = await propose({ action: "update", path: "memory/self.md", facts: [{ subject: "Role", value: "CEO", reason: "x" }] });
    expect(self.status).toBe(403);
    const dup = await propose({ action: "create", type: "project", title: "Atlas Rollout", facts: [{ subject: "Status", value: "x" }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain("memory/projects/atlas-rollout.md");
    expect((await propose({ action: "update", path: "evidence/captures/x.md", events: ["x"] })).status).toBe(400);
    expect((await propose({ action: "update", path: "memory/projects/nope.md", events: ["x"] })).status).toBe(404);
    expect((await propose({ action: "update", path: "memory/projects/atlas-rollout.md" })).status).toBe(400);
    const twice = await propose({ action: "create", type: "note", title: "Twice", facts: [{ subject: "A", value: "1" }, { subject: "a", value: "2" }] });
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toContain("twice");
    expect((await propose({ action: "create", type: "note", title: "No facts", facts: [] })).status).toBe(400);
    expect((await svc.get("/memory/proposals")).proposals.map((p: any) => p.reason)).not.toContain("invalid on purpose");
  });

  it("applies every part or nothing when the Brain changed after it was proposed", async () => {
    const created = await svc.post("/memory/proposals", { item: { action: "create", type: "note", title: "Coffee machine", facts: [{ subject: "Descaling", value: "Fridays" }], events: ["Bought in March"] }, reason: "Office chat" });
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "note", title: "Coffee Machine", facts: [{ subject: "Brand", value: "Sage" }] }] });
    const clash = await svc.call("POST", `/memory/proposals/${created.id}/apply`);
    expect(clash.status).toBe(409);
    const coffee = read("memory/notes/coffee-machine.md");
    expect(coffee).not.toContain("Descaling");
    expect(coffee).not.toContain("Bought in March");
    expect(existsSync(join(svc.dataDir, "memory/notes/coffee-machine-2.md"))).toBe(false);

    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "note", title: "Short lived", facts: [{ subject: "A", value: "1" }] }] });
    const update = await svc.post("/memory/proposals", { item: { action: "update", path: "memory/notes/short-lived.md", facts: [{ subject: "A", value: "2", reason: "x" }], events: ["y"] }, reason: "Cleanup" });
    rmSync(join(svc.dataDir, "memory/notes/short-lived.md"));
    const gone = await svc.call("POST", `/memory/proposals/${update.id}/apply`);
    expect(gone.status).toBe(404);
    expect(existsSync(join(svc.dataDir, "memory/notes/short-lived.md"))).toBe(false);

    // A refused Proposal stays on the review list so the owner can reject it.
    const pending = (await svc.get("/memory/proposals")).proposals.map((p: any) => p.id);
    expect(pending).toEqual(expect.arrayContaining([created.id, update.id]));
  });
});

describe("the briefing", () => {
  it("names what each pending Proposal changes", async () => {
    await svc.post("/memory/proposals", { item: { action: "create", type: "person", title: "Freya Lund", facts: [{ subject: "Role", value: "Designer" }, { subject: "Team", value: "Atlas" }], events: ["Joined in October"] }, reason: "Intro meeting" });
    const { job } = await svc.post("/briefings", { kind: "manual" });
    expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
    const briefing = (await svc.get("/briefings/latest")).briefing;
    const memory = briefing.sections.find((s: any) => s.id === "memory");
    expect(memory.items.map((i: any) => i.title)).toContain('New person "Freya Lund" (Role: Designer; Team: Atlas; 1 event)');
    expect(briefing.counts.proposals).toBe((await svc.get("/memory/proposals")).proposals.length);
  });

  it("shows a correction as the old value and the new one", async () => {
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Billing revamp", facts: [{ subject: "Status", value: "Draft" }] }] });
    await svc.post("/memory/proposals", { item: { action: "update", path: "memory/projects/billing-revamp.md", facts: [{ subject: "Status", value: "Approved", reason: "Signed off" }, { subject: "Budget", value: "40k", reason: "Signed off" }] }, reason: "Steering group" });
    const { job } = await svc.post("/briefings", { kind: "manual" });
    expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
    const memory = (await svc.get("/briefings/latest")).briefing.sections.find((s: any) => s.id === "memory");
    expect(memory.items.map((i: any) => i.title)).toContain("Status: Draft → Approved; Budget: 40k");
  });
});
