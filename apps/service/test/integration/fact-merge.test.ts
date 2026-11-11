import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const DAY = 86_400_000;
const ORION = "memory/projects/orion-migration.md";

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const read = (m: TestMachine, rel: string) => readFileSync(join(m.dataDir, rel), "utf8");

const save = (m: TestMachine, items: unknown[]) => m.post("/memory/save", { items });

const correct = (m: TestMachine, path: string, facts: Array<{ subject: string; value: string; review?: string }>, events: string[] = []) =>
  save(m, [{ action: "update", path, facts: facts.map((f) => ({ ...f, reason: "changed while apart" })), ...(events.length ? { events } : {}) }]);

/** Both Machines hold the Orion note with Status and Owner, replicated. */
async function twoMachinesWithOrion(): Promise<[TestMachine, TestMachine]> {
  world = await startMachines(["Mac", "PC"]);
  const [mac, pc] = world.machines as [TestMachine, TestMachine];
  await save(mac, [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for October" }, { subject: "Owner", value: "Ada" }] }]);
  await mac.clock.advance(AFTER_WRITE);
  await pc.clock.advance(CHECK);
  expect(read(pc, ORION)).toContain("Cutover planned for October");
  return [mac, pc];
}

/** `pusher` pushes first; `merger` merges both and pushes; `pusher` picks the merge up. */
async function replicateBoth(pusher: TestMachine, merger: TestMachine): Promise<void> {
  await pusher.clock.advance(AFTER_WRITE);
  await merger.clock.advance(AFTER_WRITE);
  await pusher.clock.advance(CHECK);
  for (const m of [pusher, merger]) expect((await m.get("/replication")).status).toBe("up_to_date");
}

function expectNoConflictMarkers(text: string): void {
  expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
}

/** The same note, byte for byte, on both Machines. */
function sameOnBoth(mac: TestMachine, pc: TestMachine, rel: string): string {
  const text = read(mac, rel);
  expect(read(pc, rel)).toBe(text);
  expectNoConflictMarkers(text);
  return text;
}

describe("Fact merge rule", () => {
  it("keeps both changes when two Machines changed different facts of one note", async () => {
    const [mac, pc] = await twoMachinesWithOrion();
    await correct(mac, ORION, [{ subject: "Status", value: "Cutover moved to November" }]);
    await correct(pc, ORION, [{ subject: "Owner", value: "Grace" }]);
    await replicateBoth(mac, pc);

    const text = sameOnBoth(mac, pc, ORION);
    expect(text).toMatch(/^- \*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Cutover moved to November/m);
    expect(text).toMatch(/^- \*\*Owner\*\* \(\d{4}-\d{2}-\d{2}\): Grace/m);
    for (const m of [mac, pc]) {
      const doc = await m.get(`/memory/document?path=${encodeURIComponent(ORION)}`);
      expect((doc.state as Array<{ subject: string; value: string }>).map((s) => [s.subject, s.value.replace(/ — source:.*$/, "")])).toEqual([
        ["Status", "Cutover moved to November"],
        ["Owner", "Grace"],
      ]);
    }
  });

  it("lets the newer date win when both changed the same fact, on both Machines, and keeps the other value in History with its Machine", async () => {
    const [mac, pc] = await twoMachinesWithOrion();
    await correct(mac, ORION, [{ subject: "Status", value: "Cutover moved to November" }]);
    // The PC changes the same fact a day later, while the Machines are apart.
    pc.clock.skip(DAY);
    await correct(pc, ORION, [{ subject: "Status", value: "Cutover moved to December" }]);
    await replicateBoth(mac, pc);

    const text = sameOnBoth(mac, pc, ORION);
    const day = (m: TestMachine) => m.clock.now().toISOString().slice(0, 10);
    expect(text).toContain(`- **Status** (${day(pc)}): Cutover moved to December`);
    expect(text).not.toMatch(/^- \*\*Status\*\* .*November/m);
    const lost = text.split("\n").filter((l) => l.includes('**Status** was "Cutover moved to November"'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain(`(dated ${day(mac)}`);
    expect(lost[0]).toContain("this value came from Mac");
    expect(lost[0]).toContain("newer value from PC");

    // Now the Mac is the one that merges, and the newer date still wins.
    mac.clock.skip(3 * DAY);
    await correct(mac, ORION, [{ subject: "Status", value: "Cutover done" }]);
    pc.clock.skip(DAY);
    await correct(pc, ORION, [{ subject: "Status", value: "Cutover moved to January" }]);
    await replicateBoth(pc, mac);
    const later = sameOnBoth(mac, pc, ORION);
    expect(later).toMatch(/^- \*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Cutover done/m);
    expect(later).toContain('**Status** was "Cutover moved to January"');
    expect(later).toContain("this value came from PC");
  });

  it("resolves the same date on both sides the same way on every Machine, by Machine id", async () => {
    const [mac, pc] = await twoMachinesWithOrion();
    const ids = { Mac: (await mac.get("/machine")).id as string, PC: (await pc.get("/machine")).id as string };
    const [winner, loser] = ids.Mac > ids.PC ? ["Mac", "PC"] : ["PC", "Mac"];

    // The PC merges.
    await correct(mac, ORION, [{ subject: "Status", value: "Status from Mac" }]);
    await correct(pc, ORION, [{ subject: "Status", value: "Status from PC" }]);
    await replicateBoth(mac, pc);
    const first = sameOnBoth(mac, pc, ORION);
    expect(first).toMatch(new RegExp(`^- \\*\\*Status\\*\\* \\(\\d{4}-\\d{2}-\\d{2}\\): Status from ${winner}`, "m"));
    expect(first).toContain(`**Status** was "Status from ${loser}"`);
    expect(first).toContain(`kept the value from ${winner}`);

    // The Mac merges: the same Machine wins.
    await correct(mac, ORION, [{ subject: "Owner", value: "Owner from Mac" }]);
    await correct(pc, ORION, [{ subject: "Owner", value: "Owner from PC" }]);
    await replicateBoth(pc, mac);
    const second = sameOnBoth(mac, pc, ORION);
    expect(second).toMatch(new RegExp(`^- \\*\\*Owner\\*\\* \\(\\d{4}-\\d{2}-\\d{2}\\): Owner from ${winner}`, "m"));
    expect(second).toContain(`**Owner** was "Owner from ${loser}"`);
  });

  it("carries the Review date with the winning value, and the losing value's Review date into History", async () => {
    const [mac, pc] = await twoMachinesWithOrion();
    const inDays = (m: TestMachine, n: number) => new Date(m.clock.now().getTime() + n * DAY).toISOString().slice(0, 10);
    const pcReview = inDays(pc, 20);
    await correct(pc, ORION, [{ subject: "Status", value: "Cutover moved to November", review: pcReview }]);
    mac.clock.skip(DAY);
    const macReview = inDays(mac, 40);
    await correct(mac, ORION, [{ subject: "Status", value: "Cutover moved to December", review: macReview }]);
    await replicateBoth(mac, pc);

    const text = sameOnBoth(mac, pc, ORION);
    expect(text).toMatch(new RegExp(`^- \\*\\*Status\\*\\* \\(\\d{4}-\\d{2}-\\d{2}, review ${macReview}\\): Cutover moved to December`, "m"));
    expect(text).toMatch(new RegExp(`\\*\\*Status\\*\\* was "Cutover moved to November" \\(dated \\d{4}-\\d{2}-\\d{2}, review ${pcReview}`));
    for (const m of [mac, pc]) {
      const doc = await m.get(`/memory/document?path=${encodeURIComponent(ORION)}`);
      const status = (doc.state as Array<{ subject: string; review?: string }>).find((s) => s.subject === "Status");
      expect(status?.review).toBe(macReview);
    }
  });

  it("keeps every History line from both sides, once each", async () => {
    const [mac, pc] = await twoMachinesWithOrion();
    // Both Machines also record the same event on the same day: one History line.
    await correct(mac, ORION, [{ subject: "Status", value: "Cutover moved to November" }], ["Mac heard the vendor slipped", "Steering group met"]);
    await correct(pc, ORION, [{ subject: "Owner", value: "Grace" }], ["PC heard Ada moved teams", "Steering group met"]);
    const historyOf = (text: string) => text.slice(text.indexOf("## History")).split("\n").filter((l) => l.startsWith("- "));
    const before = [...historyOf(read(mac, ORION)), ...historyOf(read(pc, ORION))];
    await replicateBoth(mac, pc);

    const after = historyOf(sameOnBoth(mac, pc, ORION));
    expect(new Set(after)).toEqual(new Set(before));
    expect(after).toHaveLength(new Set(after).size);
    expect(after.filter((l) => l.includes("Mac heard the vendor slipped"))).toHaveLength(1);
    expect(after.filter((l) => l.includes("PC heard Ada moved teams"))).toHaveLength(1);
    expect(after.filter((l) => l.includes("created by"))).toHaveLength(1);
    expect(after.filter((l) => l.includes("Steering group met"))).toHaveLength(1);
  });

  it("makes two notes with the same type and title, created on two Machines, one note", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const KESTREL = "memory/projects/kestrel-plan.md";
    await save(mac, [{ action: "create", type: "project", title: "Kestrel plan", facts: [{ subject: "Status", value: "Scoping" }], events: ["Mac started the plan"] }]);
    pc.clock.skip(DAY);
    await save(pc, [{ action: "create", type: "project", title: "Kestrel plan", facts: [{ subject: "Status", value: "Approved" }, { subject: "Budget", value: "Ten days" }], events: ["PC started the plan"] }]);
    await replicateBoth(mac, pc);

    const text = sameOnBoth(mac, pc, KESTREL);
    expect(text.match(/^title: /gm)).toHaveLength(1);
    expect(text.match(/^id: /gm)).toHaveLength(1);
    expect(text.match(/^# Kestrel plan$/gm)).toHaveLength(1);
    expect(text.match(/^## Current State$/gm)).toHaveLength(1);
    expect(text.match(/^## History$/gm)).toHaveLength(1);
    expect(text).toMatch(/^- \*\*Status\*\* \(\d{4}-\d{2}-\d{2}\): Approved/m);
    expect(text).toMatch(/^- \*\*Budget\*\* \(\d{4}-\d{2}-\d{2}\): Ten days/m);
    expect(text).toContain('**Status** was "Scoping"');
    expect(text).toContain("Mac started the plan");
    expect(text).toContain("PC started the plan");
    for (const m of [mac, pc]) {
      expect(existsSync(join(m.dataDir, "memory/projects/kestrel-plan-2.md"))).toBe(false);
      const found = await m.get(`/memory/search?q=${encodeURIComponent("Kestrel plan")}`);
      expect([...new Set((found.hits as Array<{ relPath: string }>).map((h) => h.relPath))]).toEqual([KESTREL]);
      const doc = await m.get(`/memory/document?path=${encodeURIComponent(KESTREL)}`);
      expect((doc.state as Array<{ subject: string }>).map((s) => s.subject).sort()).toEqual(["Budget", "Status"]);
    }
  });
});
