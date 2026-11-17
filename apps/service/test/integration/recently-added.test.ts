import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, type TestService } from "./harness.ts";

const HOME = process.env.ATTACHE_AGENT_HOME!;
const DAY = 86_400_000;
const ORION = "memory/projects/orion-migration.md";
const origin = { agent: "claude-code", sessionId: "sess-home-1", cwd: "/Users/alex/code/attache" };

let svc: TestService;
const clock = new ManualClock();

/** What Home lists: every change written without the owner reviewing it in the last 7 days. */
async function recentlyAdded(): Promise<any[]> {
  return (await svc.get("/memory/recent-changes?unreviewed=1")).changes;
}

beforeAll(async () => {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  svc = await startTestService({ clock });
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
});
afterAll(async () => {
  await svc?.stop();
});

describe("recently added without review", () => {
  it("lists an auto-accepted save with its Harness and session, and leaves out a save the owner confirmed", async () => {
    await svc.post("/memory/save", { autoAccept: true, origin, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for October" }], events: ["Kick-off held"] }] });
    await svc.post("/memory/save", { confirmed: true, origin, items: [{ action: "create", type: "person", title: "Grace Hopper", facts: [{ subject: "Role", value: "Reviewer" }] }] });

    const list = await recentlyAdded();
    expect(list.map((c) => [c.relPath, c.kind])).toEqual([
      [ORION, "append"],
      [ORION, "create"],
    ]);
    for (const c of list) expect(c.source).toMatchObject({ harness: "claude-code", harnessLabel: "Claude Code", sessionId: "sess-home-1", label: "Claude Code, session sess-home-1", autoAccepted: true, consolidation: null });
    // The full recent-saves list still has the confirmed save.
    expect((await svc.get("/memory/recent-changes")).changes.some((c: any) => c.title === "Grace Hopper")).toBe(true);
  });

  it("shows a correction's old and new value with its reason", async () => {
    await svc.post("/memory/save", { autoAccept: true, origin, items: [{ action: "update", path: ORION, facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }] }] });
    const [latest] = await recentlyAdded();
    expect(latest).toMatchObject({ relPath: ORION, title: "Orion migration", kind: "correct", subject: "Status", oldValue: "Cutover planned for October", newValue: "Cutover moved to November", reason: "vendor delay", revertedBy: null, revert: { allowed: true } });
  });

  it("reverts an entry in one click: the old value comes back and the entry shows as reverted, without listing the revert", async () => {
    const [correction] = await recentlyAdded();
    const { change } = await svc.post(`/memory/changes/${correction.id}/revert`);
    expect(change).toMatchObject({ revertOf: correction.id, oldValue: "Cutover moved to November", newValue: "Cutover planned for October" });
    expect(readFileSync(join(svc.dataDir, ORION), "utf8")).toMatch(/- \*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Cutover planned for October/);

    const list = await recentlyAdded();
    expect(list.some((c) => c.id === change.id)).toBe(false);
    expect(list[0]).toMatchObject({ id: correction.id, revertedBy: change.id, revert: { allowed: false, reason: "Already reverted." } });
  });

  it("drops a change once it is older than 7 days, with nothing to mark as seen", async () => {
    // The change log stamps changes with the system clock; moving this Machine's clock ages them.
    expect((await recentlyAdded()).length).toBe(3);
    clock.skip(7 * DAY - 60_000);
    expect((await recentlyAdded()).length).toBe(3);
    clock.skip(2 * 60_000);
    expect(await recentlyAdded()).toEqual([]);
    // Still in the full list, which has no window.
    expect((await svc.get("/memory/recent-changes")).changes.some((c: any) => c.subject === "Status")).toBe(true);
  });

  it("refuses an unreviewed value other than 1", async () => {
    const r = await svc.call("GET", "/memory/recent-changes?unreviewed=yes");
    expect(r.status).toBe(400);
  });
});

describe("a busy week", () => {
  let busy: TestService;
  beforeAll(async () => {
    busy = await startTestService();
    await busy.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  });
  afterAll(async () => {
    await busy?.stop();
  });

  it("lists every change written without review in the window, however many there are", async () => {
    // 2 saves × 20 new notes × (1 create + 20 events) = 840 changes, more than one page of the change log.
    const events = Array.from({ length: 20 }, (_, e) => `Step ${e + 1} done`);
    for (const batch of [1, 2]) {
      const items = Array.from({ length: 20 }, (_, i) => ({ action: "create", type: "project", title: `Busy project ${batch}-${i + 1}`, facts: [{ subject: "Status", value: "Running" }], events }));
      await busy.post("/memory/save", { autoAccept: true, origin: { ...origin, sessionId: `sess-busy-${batch}` }, items });
    }
    const list = (await busy.get("/memory/recent-changes?unreviewed=1")).changes as any[];
    expect(list.length).toBe(840);
    expect(list.filter((c) => c.kind === "create").map((c) => c.title)).toContain("Busy project 1-1");
  });
});
