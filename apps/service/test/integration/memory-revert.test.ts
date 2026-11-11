import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

const ORION = "memory/projects/orion-migration.md";
const origin = { agent: "claude-code", sessionId: "sess-revert-1", cwd: "/Users/alex/code/jarvis" };

async function recent(): Promise<any[]> {
  return (await svc.get("/memory/recent-changes")).changes;
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for October" }, { subject: "Owner", value: "Ada" }] }] });
});
afterAll(async () => {
  await svc?.stop();
});

describe("recent saves", () => {
  it("lists each change with its note, subject, old and new value, Harness, session and time", async () => {
    await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "update", path: ORION, facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }] }] });
    const [latest, created] = await recent();
    expect(latest).toMatchObject({
      relPath: ORION,
      title: "Orion migration",
      kind: "correct",
      subject: "Status",
      oldValue: "Cutover planned for October",
      newValue: "Cutover moved to November",
      source: { harness: "claude-code", harnessLabel: "Claude Code", sessionId: "sess-revert-1" },
    });
    expect(Date.parse(latest.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(created).toMatchObject({ relPath: ORION, kind: "create", newValue: "Orion migration", source: { harnessLabel: "Claude Code", sessionId: "sess-revert-1" } });
  });

  it("reverts a corrected fact to its previous value, with both steps in History and the revert listed as a change of its own", async () => {
    const [correction] = await recent();
    expect(correction.revert).toEqual({ allowed: true, reason: null });
    const { change } = await svc.post(`/memory/changes/${correction.id}/revert`);
    expect(change).toMatchObject({ relPath: ORION, kind: "correct", subject: "Status", oldValue: "Cutover moved to November", newValue: "Cutover planned for October", revertOf: correction.id, source: { label: "Revert in the Dashboard" } });

    const note = readFileSync(join(svc.dataDir, ORION), "utf8");
    expect(note).toMatch(/- \*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Cutover planned for October/);
    expect(note).toMatch(/\*\*Status\*\* was "Cutover planned for October".*superseded: vendor delay/);
    expect(note).toMatch(/\*\*Status\*\* was "Cutover moved to November".*superseded: reverted the change of/);
    const hits = (await svc.get(`/memory/search?q=${encodeURIComponent("Orion cutover")}`)).hits;
    expect(hits[0].snippet).toContain("October");

    const [revert, original] = await recent();
    expect(revert.id).toBe(change.id);
    expect(original).toMatchObject({ id: correction.id, revertedBy: change.id, revert: { allowed: false, reason: "Already reverted." } });
  });

  it("reverts a newly created note by removing it from the Brain and from search, and can bring it back", async () => {
    const { saved } = await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "create", type: "decision", title: "Use Kestrel for queues", facts: [{ subject: "Decision", value: "Kestrel replaces the zephyrine broker" }], events: ["Agreed in the queue review"] }] });
    const relPath = saved[0].relPath;
    const search = async () => (await svc.get(`/memory/search?q=zephyrine`)).hits.filter((h: any) => h.relPath === relPath);
    expect(await search()).not.toHaveLength(0);
    const created = (await recent()).find((c) => c.relPath === relPath && c.kind === "create");
    // The save's own event belongs to the creation and does not block the revert.
    expect(created.revert.allowed).toBe(true);

    const { change } = await svc.post(`/memory/changes/${created.id}/revert`);
    expect(change).toMatchObject({ relPath, kind: "delete", title: "Use Kestrel for queues", oldValue: "Use Kestrel for queues", newValue: null, revertOf: created.id });
    expect(existsSync(join(svc.dataDir, relPath))).toBe(false);
    expect(await search()).toHaveLength(0);
    expect((await svc.call("GET", `/memory/document?path=${encodeURIComponent(relPath)}`)).status).toBe(404);
    expect((await recent()).find((c) => c.id === created.id)).toMatchObject({ title: "Use Kestrel for queues", revertedBy: change.id, revert: { allowed: false } });

    // Undoing the removal puts the note back exactly as it was.
    const { change: restored } = await svc.post(`/memory/changes/${change.id}/revert`);
    expect(restored).toMatchObject({ relPath, kind: "create", revertOf: change.id });
    expect(readFileSync(join(svc.dataDir, relPath), "utf8")).toContain("Kestrel replaces the zephyrine broker");
    expect(await search()).not.toHaveLength(0);
  });

  it("refuses to revert a change that a later change overwrote, and says why", async () => {
    const path = "memory/projects/orion-migration.md";
    await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "update", path, facts: [{ subject: "Owner", value: "Grace", reason: "handover" }] }] });
    await svc.post("/memory/save", { confirmed: true, origin: { agent: "codex", sessionId: "sess-2" }, items: [{ action: "update", path, facts: [{ subject: "Owner", value: "Linus", reason: "second handover" }] }] });
    const [newest, older] = await recent();
    expect(newest).toMatchObject({ subject: "Owner", newValue: "Linus", source: { harnessLabel: "Codex", sessionId: "sess-2" }, revert: { allowed: true } });
    expect(older).toMatchObject({ subject: "Owner", newValue: "Grace", revert: { allowed: false, reason: "A later change overwrote “Owner”. Revert that change first." } });
    const refused = await svc.call("POST", `/memory/changes/${older.id}/revert`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "not_revertible", message: "A later change overwrote “Owner”. Revert that change first." });
    expect(readFileSync(join(svc.dataDir, path), "utf8")).toMatch(/\*\*Owner\*\* \(\d{4}-\d{2}-\d{2}\): Linus/);

    // Undoing the newer change first makes the older one the last word again.
    await svc.post(`/memory/changes/${newest.id}/revert`);
    expect((await recent()).find((c) => c.id === older.id).revert.allowed).toBe(true);
    await svc.post(`/memory/changes/${older.id}/revert`);
    expect(readFileSync(join(svc.dataDir, path), "utf8")).toMatch(/\*\*Owner\*\* \(\d{4}-\d{2}-\d{2}\): Ada/);
  });

  it("refuses a revert after an edit made outside Jarvis, and for events", async () => {
    const { saved } = await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "create", type: "person", title: "Ada Byron", facts: [{ subject: "Role", value: "Analyst" }] }, { action: "update", path: ORION, facts: [{ subject: "Budget", value: "40k", reason: "new estimate" }], events: ["Budget agreed"] }] });
    const ada = saved[0].relPath;
    writeFileSync(join(svc.dataDir, ada), readFileSync(join(svc.dataDir, ada), "utf8").replace("Analyst", "Lead analyst"));
    writeFileSync(join(svc.dataDir, ORION), readFileSync(join(svc.dataDir, ORION), "utf8").replace("): 40k", "): 45k"));
    const list = await recent();
    expect(list.find((c) => c.relPath === ada && c.kind === "create").revert).toEqual({ allowed: false, reason: "The note was edited outside Jarvis after it was created." });
    expect(list.find((c) => c.subject === "Budget").revert).toEqual({ allowed: false, reason: "“Budget” was edited outside Jarvis after this change." });
    expect(list.find((c) => c.kind === "append" && c.newValue.startsWith("Budget agreed")).revert.allowed).toBe(false);
  });

  it("lists an approved Proposal once, as the change it made, and leaves pending Proposals out", async () => {
    const source = { kind: "user", ref: "standup", label: "standup notes" };
    const pending = await svc.post("/memory/proposals", { item: { action: "update", path: ORION, facts: [{ subject: "Risk", value: "Vendor capacity", reason: "seen in standup" }] }, reason: "seen in standup", source });
    const approved = await svc.post("/memory/proposals", { item: { action: "update", path: ORION, facts: [{ subject: "Phase", value: "Testing", reason: "seen in standup" }], events: ["Testing started"] }, reason: "seen in standup", source });
    await svc.post(`/memory/proposals/${approved.id}/apply`);
    const list = await recent();
    expect(list.some((c) => c.id === pending.id || c.id === approved.id)).toBe(false);
    expect(list.filter((c) => c.subject === "Phase")).toEqual([expect.objectContaining({ newValue: "Testing", source: expect.objectContaining({ harness: null, label: "A Proposal you approved" }), revert: { allowed: true, reason: null } })]);
  });

  it("records an applied Proposal as one batch, so a note it created reverts with its own events", async () => {
    const proposal = await svc.post("/memory/proposals", { item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Account manager" }], events: ["Introduced in the vendor call"] }, reason: "vendor call" });
    const { target } = await svc.post(`/memory/proposals/${proposal.id}/apply`);
    const rows = (await svc.get("/memory/changes?status=applied")).filter((c: any) => c.docRelPath === target && c.change !== "proposal");
    expect(rows.map((c: any) => c.change).sort()).toEqual(["append", "create"]);
    expect(rows[0].batchId).toBeTruthy();
    expect(new Set(rows.map((c: any) => c.batchId)).size).toBe(1);
    const created = (await recent()).find((c) => c.relPath === target && c.kind === "create");
    expect(created).toMatchObject({ title: "Lena Berg", source: { label: "A Proposal you approved" }, revert: { allowed: true, reason: null } });
    await svc.post(`/memory/changes/${created.id}/revert`);
    expect(existsSync(join(svc.dataDir, target))).toBe(false);
  });

  it("gives every change one save made the same batch id, and each save its own", async () => {
    await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "update", path: ORION, facts: [{ subject: "Region", value: "EU", reason: "chosen" }], events: ["Region chosen"] }, { action: "create", type: "note", title: "Region checklist", facts: [{ subject: "Step", value: "Move DNS" }] }] });
    const [a, b, c] = (await svc.get("/memory/changes?status=applied&limit=3")) as any[];
    expect(new Set([a.batchId, b.batchId, c.batchId]).size).toBe(1);
    expect(a).toMatchObject({ harness: "claude-code", sessionId: "sess-revert-1" });
    const [before] = (await svc.get("/memory/changes?status=applied&limit=4")).slice(3);
    expect(before.batchId).not.toBe(a.batchId);
  });

  it("reverts a fact a save added by taking it out of Current State and keeping it in History", async () => {
    await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "update", path: ORION, facts: [{ subject: "Sponsor", value: "Margaret", reason: "named in steering" }] }] });
    const [added] = await recent();
    expect(added).toMatchObject({ subject: "Sponsor", oldValue: null, newValue: "Margaret" });
    const { change } = await svc.post(`/memory/changes/${added.id}/revert`);
    expect(change).toMatchObject({ subject: "Sponsor", oldValue: "Margaret", newValue: null });
    const note = readFileSync(join(svc.dataDir, ORION), "utf8");
    expect(note).not.toMatch(/^- \*\*Sponsor\*\*/m);
    expect(note).toMatch(/\*\*Sponsor\*\* was "Margaret".*removed: reverted the change of/);
  });
});
