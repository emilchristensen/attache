import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A task with a due date in a note: the data folder source raises an inbox item for it. */
function writeTask(m: TestMachine, due: string) {
  mkdirSync(join(m.dataDir, "memory/projects"), { recursive: true });
  writeFileSync(join(m.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${due}\n`);
}

/** Source refresh on this Machine, through a manual briefing. */
async function refresh(m: TestMachine) {
  const { job } = await m.post("/briefings", { kind: "manual" });
  const done = await m.waitJob(job.id);
  expect(done.job.status).toBe("succeeded");
}

interface Item {
  id: string;
  key: string;
  title: string;
  state: string;
  changedSinceDecision: boolean;
  snoozeUntil: string | null;
}

async function venue(m: TestMachine): Promise<Item | null> {
  const items = (await m.get("/attention?state=open,dismissed,snoozed,resolved")).items as Item[];
  return items.find((i) => i.title.includes("Book the venue")) ?? null;
}

/** Push what `from` changed and let `to` pick it up. */
async function replicate(from: TestMachine, to: TestMachine) {
  await from.clock.advance(AFTER_WRITE);
  await to.clock.advance(CHECK);
}

describe("The inbox replicates", () => {
  it("shows an inbox item raised on one Machine on another", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    const raised = (await venue(mac))!;
    expect(raised.state).toBe("open");
    expect(await venue(pc)).toBeNull();

    await replicate(mac, pc);
    expect(await venue(pc)).toMatchObject({ id: raised.id, key: raised.key, state: "open" });
  });

  it("applies a dismiss or a snooze made on one Machine on the others", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    await replicate(mac, pc);
    const item = (await venue(pc))!;

    await pc.post(`/attention/${item.id}/decision`, { decision: "dismiss" });
    await replicate(pc, mac);
    expect(await venue(mac)).toMatchObject({ id: item.id, state: "dismissed" });
    expect((await mac.get("/attention")).items.some((i: Item) => i.id === item.id)).toBe(false);

    const until = new Date(mac.clock.now().getTime() + 3_600_000).toISOString();
    await mac.post(`/attention/${item.id}/decision`, { decision: "snooze", until });
    await replicate(mac, pc);
    expect(await venue(pc)).toMatchObject({ state: "snoozed", snoozeUntil: until });
  });

  it("reopens a dismissed item on every Machine when its source changed, saying it changed", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    await replicate(mac, pc);
    await pc.post(`/attention/${(await venue(pc))!.id}/decision`, { decision: "dismiss" });
    await replicate(pc, mac);
    expect((await venue(mac))!.state).toBe("dismissed");

    // A Source refresh that finds the same evidence keeps it dismissed.
    await refresh(mac);
    expect((await venue(mac))!.state).toBe("dismissed");

    writeTask(mac, day(0));
    await refresh(mac);
    expect(await venue(mac)).toMatchObject({ state: "open", changedSinceDecision: true });
    await replicate(mac, pc);
    expect(await venue(pc)).toMatchObject({ state: "open", changedSinceDecision: true, title: expect.stringMatching(/Due today/) });
  });

  it.each([
    { later: "PC", expected: "snoozed" },
    { later: "Mac", expected: "dismissed" },
  ])("settles different decisions made on two Machines at once on the later one ($later)", async ({ later, expected }) => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    await replicate(mac, pc);
    const id = (await venue(mac))!.id;

    // Both Machines decide before either hears of the other's decision.
    const dismiss = () => mac.post(`/attention/${id}/decision`, { decision: "dismiss" });
    const snooze = () => pc.post(`/attention/${id}/decision`, { decision: "snooze", until: new Date(pc.clock.now().getTime() + 86_400_000).toISOString() });
    if (later === "PC") {
      await dismiss();
      await pc.clock.advance(10_000);
      await snooze();
    } else {
      await snooze();
      await mac.clock.advance(Math.max(0, pc.clock.now().getTime() - mac.clock.now().getTime()) + 10_000);
      await dismiss();
    }

    await mac.clock.advance(AFTER_WRITE); // Mac pushes its decision
    await pc.clock.advance(AFTER_WRITE); // PC commits, merges Mac's, pushes the result
    await mac.clock.advance(CHECK); // Mac picks the result up
    expect((await venue(mac))!.state).toBe(expected);
    expect((await venue(pc))!.state).toBe(expected);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    expect((await pc.get("/replication")).status).toBe("up_to_date");
  });

  it("keeps inbox items out of recall", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    await replicate(mac, pc);
    expect(readdirSync(join(pc.dataDir, "review/inbox"))).toHaveLength(1);

    for (const m of [mac, pc]) {
      const hits = (await m.get(`/memory/search?q=${encodeURIComponent("Book the venue")}`)).hits as Array<{ relPath: string }>;
      expect(hits.map((h) => h.relPath)).not.toContainEqual(expect.stringMatching(/^review\//));
    }
    // Not even a Markdown file someone put there by hand.
    writeFileSync(join(pc.dataDir, "review/inbox/notes.md"), "# Venue booking notes\n\nBook the venue early.\n");
    pc.app.memory.indexer.scan(pc.app.memory.rootRef!);
    const hits = (await pc.get(`/memory/search?q=${encodeURIComponent("venue booking notes")}`)).hits as Array<{ relPath: string }>;
    expect(hits.map((h) => h.relPath)).not.toContain("review/inbox/notes.md");
  });
});
