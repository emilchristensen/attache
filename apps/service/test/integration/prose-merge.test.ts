import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const ORION = "memory/projects/orion-migration.md";
const NOTES = ["The vendor prefers a weekend cutover.", "Ada owns the runbook.", "Rollback takes two hours."];

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

interface InboxItem {
  id: string;
  title: string;
  summary: string;
  kind: string;
  state: string;
  evidence: Array<{ relPath?: string }>;
}

const read = (m: TestMachine, rel: string) => readFileSync(join(m.dataDir, rel), "utf8");
const write = (m: TestMachine, rel: string, text: string) => writeFileSync(join(m.dataDir, rel), text);

/** The owner edits the note in an editor: one line of its Notes section replaced. */
function editNoteLine(m: TestMachine, from: string, to: string): void {
  const text = read(m, ORION);
  expect(text).toContain(from);
  write(m, ORION, text.replace(from, to));
}

const proseItems = async (m: TestMachine, state = "open"): Promise<InboxItem[]> =>
  ((await m.get(`/attention?state=${state}`)).items as InboxItem[]).filter((i) => i.kind === "replication_prose_versions");

const saveProject = (m: TestMachine, title: string, status: string) =>
  m.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: status }] }] });

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    last = await read();
  }
  return last;
}

/** Both Machines hold the Orion note with a Notes section of three lines, replicated. */
async function twoMachinesWithNotes(): Promise<[TestMachine, TestMachine]> {
  world = await startMachines(["Mac", "PC"]);
  const [mac, pc] = world.machines as [TestMachine, TestMachine];
  await saveProject(mac, "Orion migration", "Cutover planned for October");
  write(mac, ORION, read(mac, ORION).replace("## History", `## Notes\n${NOTES.join("\n")}\n\n## History`));
  await mac.clock.advance(CHECK);
  await pc.clock.advance(CHECK);
  expect(read(pc, ORION)).toContain(NOTES[1]);
  return [mac, pc];
}

/** Mac pushes its edits first; PC merges both and pushes; Mac picks the merge up. */
async function replicateBoth(mac: TestMachine, pc: TestMachine): Promise<void> {
  await mac.clock.advance(CHECK);
  await pc.clock.advance(CHECK);
  await mac.clock.advance(CHECK);
  for (const m of [mac, pc]) expect((await m.get("/replication")).status).toBe("up_to_date");
}

/** The same note, byte for byte, on both Machines, never with conflict markers. */
function sameOnBoth(mac: TestMachine, pc: TestMachine, rel: string): string {
  const text = read(mac, rel);
  expect(read(pc, rel)).toBe(text);
  expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
  return text;
}

describe("Prose merge rule", () => {
  it("merges changes to different lines of the Notes section without any marker", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    // Neighbouring lines, which git alone would call a conflict.
    editNoteLine(mac, NOTES[0]!, "The vendor now prefers a Sunday cutover.");
    editNoteLine(pc, NOTES[1]!, "Grace owns the runbook now.");
    await replicateBoth(mac, pc);

    const text = sameOnBoth(mac, pc, ORION);
    expect(text).toContain("## Notes\nThe vendor now prefers a Sunday cutover.\nGrace owns the runbook now.\nRollback takes two hours.\n");
    expect(text).not.toContain("Version from");
    for (const m of [mac, pc]) expect(await proseItems(m)).toEqual([]);
  });

  it("keeps both versions of the same lines under headings naming each Machine, with one inbox item, while every other file replicates", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[1]!, "Grace owns the runbook now.");
    await saveProject(mac, "Kestrel plan", "Scoping");
    editNoteLine(pc, NOTES[1]!, "Ada and Lin share the runbook.");
    await saveProject(pc, "Takahe count", "Counted in spring");
    await replicateBoth(mac, pc);

    // Every Machine puts the versions in the same order: by Machine id.
    const ids = { Mac: (await mac.get("/machine")).id as string, PC: (await pc.get("/machine")).id as string };
    const versions = [
      ["Mac", "Grace owns the runbook now."],
      ["PC", "Ada and Lin share the runbook."],
    ].sort(([a], [b]) => (ids[a as "Mac"] < ids[b as "Mac"] ? -1 : 1));
    const text = sameOnBoth(mac, pc, ORION);
    expect(text).toContain(
      [
        "## Notes",
        NOTES[0],
        "",
        ...versions.flatMap(([name, line]) => [`### Version from ${name}`, "", line, ""]),
        NOTES[2],
        "",
        "## History",
      ].join("\n"),
    );
    // Replication carried on for every other file, both ways.
    for (const m of [mac, pc]) {
      expect(read(m, "memory/projects/kestrel-plan.md")).toContain("Scoping");
      expect(read(m, "memory/projects/takahe-count.md")).toContain("Counted in spring");
    }

    // PC brought the two versions together, so PC raised the item.
    const items = await proseItems(pc);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain("Orion migration");
    expect(items[0]!.summary).toMatch(/Mac/);
    expect(items[0]!.summary).toMatch(/PC/);
    expect(items[0]!.evidence[0]?.relPath).toBe(ORION);
    // Later checks do not raise it again or settle it.
    await pc.clock.advance(CHECK);
    expect(await proseItems(pc)).toHaveLength(1);
  });

  it("shows the item on every Machine, as one item, and settling it on one settles it on all", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[1]!, "Grace owns the runbook now.");
    editNoteLine(pc, NOTES[1]!, "Ada and Lin share the runbook.");
    await replicateBoth(mac, pc);
    // PC made the merge; the Mac sees the same item once the inbox file reaches it.
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    const [onPc] = await proseItems(pc);
    const onMac = await proseItems(mac);
    expect(onMac).toHaveLength(1);
    expect(onMac[0]).toMatchObject({ title: onPc!.title, summary: onPc!.summary });

    // The owner settles the note on the Mac; the item is resolved there and, once the file replicates, on the PC.
    write(mac, ORION, read(mac, ORION).replace("### Version from Mac\n\nGrace owns the runbook now.\n\n", "").replace("### Version from PC\n\n", ""));
    expect(await eventually(() => proseItems(mac), (items) => items.length === 0)).toEqual([]);
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    expect(await proseItems(pc)).toEqual([]);
  });

  it("raises one item for a note with two versions in several places, also when a later merge adds more", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[0]!, "Mac: Saturday cutover.");
    editNoteLine(mac, NOTES[2]!, "Mac: rollback in one hour.");
    editNoteLine(pc, NOTES[0]!, "PC: Sunday cutover.");
    editNoteLine(pc, NOTES[2]!, "PC: rollback in three hours.");
    await replicateBoth(mac, pc);
    expect(sameOnBoth(mac, pc, ORION).match(/^### Version from /gm)).toHaveLength(4);
    expect(await proseItems(pc)).toHaveLength(1);

    editNoteLine(mac, NOTES[1]!, "Mac: Grace owns the runbook.");
    editNoteLine(pc, NOTES[1]!, "PC: Lin owns the runbook.");
    await replicateBoth(mac, pc);
    expect(sameOnBoth(mac, pc, ORION).match(/^### Version from /gm)).toHaveLength(6);
    expect(await proseItems(pc)).toHaveLength(1);
  });

  it("resolves the item when the owner removes one version on the Machine that has it", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[1]!, "Grace owns the runbook now.");
    editNoteLine(pc, NOTES[1]!, "Ada and Lin share the runbook.");
    await replicateBoth(mac, pc);
    const [item] = await proseItems(pc);
    expect(item).toBeDefined();

    // Keeping both texts but only one heading is not settled yet...
    const merged = read(pc, ORION);
    write(pc, ORION, merged.replace("### Version from Mac\n\nGrace owns the runbook now.\n\n", "Unrelated edit.\n\n### Version from Mac\n\nGrace owns the runbook now.\n\n"));
    await pc.clock.advance(CHECK);
    expect(await proseItems(pc)).toHaveLength(1);

    // ...removing Mac's version is.
    write(pc, ORION, read(pc, ORION).replace("### Version from Mac\n\nGrace owns the runbook now.\n\n", ""));
    const open = await eventually(() => proseItems(pc), (items) => items.length === 0);
    expect(open).toEqual([]);
    const resolved = await proseItems(pc, "resolved");
    expect(resolved.map((i) => i.id)).toEqual([item!.id]);

    // The settled note replicates like any edit.
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    expect(sameOnBoth(mac, pc, ORION)).not.toContain("Grace owns the runbook now.");
  });

  it("resolves the item when the owner settles the note on another Machine", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[1]!, "Grace owns the runbook now.");
    editNoteLine(pc, NOTES[1]!, "Ada and Lin share the runbook.");
    await replicateBoth(mac, pc);
    expect(await proseItems(pc)).toHaveLength(1);

    // On the Mac, the owner keeps the PC's text and deletes both headings.
    const merged = read(mac, ORION);
    write(mac, ORION, merged.replace("### Version from Mac\n\nGrace owns the runbook now.\n\n", "").replace("### Version from PC\n\n", ""));
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);

    expect(sameOnBoth(mac, pc, ORION)).toContain(`${NOTES[0]}\n\nAda and Lin share the runbook.\n\n${NOTES[2]}`);
    expect(await proseItems(pc)).toEqual([]);
    expect(await proseItems(pc, "resolved")).toHaveLength(1);
  });

  it("raises the item again when the same note gets two versions after it was settled", async () => {
    const [mac, pc] = await twoMachinesWithNotes();
    editNoteLine(mac, NOTES[1]!, "Grace owns the runbook now.");
    editNoteLine(pc, NOTES[1]!, "Ada and Lin share the runbook.");
    await replicateBoth(mac, pc);
    write(pc, ORION, read(pc, ORION).replace("### Version from Mac\n\nGrace owns the runbook now.\n\n", "").replace("### Version from PC\n\n", ""));
    await eventually(() => proseItems(pc), (items) => items.length === 0);
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);

    editNoteLine(mac, NOTES[2]!, "Mac: rollback in one hour.");
    editNoteLine(pc, NOTES[2]!, "PC: rollback in three hours.");
    await replicateBoth(mac, pc);
    expect(await proseItems(pc)).toHaveLength(1);
  });
});
