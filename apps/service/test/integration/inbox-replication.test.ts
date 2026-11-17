import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  updatedAt: string;
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

  it("keeps another Machine's newer report of an item after a snooze ends here (#65)", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    await replicate(mac, pc);
    const id = (await venue(mac))!.id;
    await mac.post(`/attention/${id}/decision`, { decision: "snooze", until: new Date(mac.clock.now().getTime() + 3_600_000).toISOString() });
    await replicate(mac, pc);
    const snoozed = (await venue(mac))!;
    expect(snoozed.state).toBe("snoozed");

    // PC's source reports a newer version, and pushes it; Mac is offline and has not heard of it.
    await pc.clock.advance(60_000);
    writeTask(pc, day(0));
    await refresh(pc);
    await pc.clock.advance(AFTER_WRITE);
    expect((await venue(pc))!.title).toMatch(/Due today/);
    world.remote.goOffline();

    // Mac's snooze ends, on Mac's own clock, and the Dashboard hears of it.
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    mac.app.bus.on("event", listen);
    await mac.clock.advance(Math.max(0, pc.clock.now().getTime() - mac.clock.now().getTime()) + 2 * 3_600_000);
    mac.app.bus.off("event", listen);
    expect(events).toContain("attention.changed");
    expect(await venue(mac)).toMatchObject({ state: "open", snoozeUntil: null, updatedAt: snoozed.updatedAt });

    // Mac writes the item's record again; Replication merges it with PC's.
    await mac.post(`/attention/${id}/decision`, { decision: "dismiss" });
    world.remote.goOnline();
    await replicate(mac, pc);
    await mac.clock.advance(CHECK);
    for (const m of [mac, pc]) expect(await venue(m)).toMatchObject({ title: expect.stringMatching(/Due today/), state: "open", changedSinceDecision: true });
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

  it("shows the state its record gives on a Machine whose database kept another one, as after an upgrade (#60)", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    writeTask(mac, day(2));
    await refresh(mac);
    const id = (await venue(mac))!.id;
    await mac.post(`/attention/${id}/decision`, { decision: "done" });
    await replicate(mac, pc);
    expect((await venue(pc))!.state).toBe("resolved");

    // An earlier release left such rows open, and the upgrade carried the decision over without working the state out again.
    const db = new DatabaseSync(join(mac.stateDir, "attache.sqlite"));
    db.prepare("update attention_items set state = 'open' where id = ?").run(id);
    db.close();
    const restarted = await world.restart(mac);

    expect((await venue(restarted))!.state).toBe("resolved");
    const openKeys = async (m: TestMachine) => ((await m.get("/attention")).items as Item[]).map((i) => i.key).sort();
    expect(await openKeys(restarted)).toEqual(await openKeys(pc));
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

  it("shows a fact past its Review date on every Machine, as one item for the whole Brain", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    mkdirSync(join(mac.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(mac.dataDir, "memory/projects/orion.md"), ["---", "type: project", "title: Orion", "---", "# Orion", "", "## Current State", `- **Owner** (2026-01-10, review ${day(-1)}): Ingrid`, ""].join("\n"));
    await refresh(mac);
    const factItems = async (m: TestMachine) => ((await m.get("/attention?state=open,dismissed,snoozed,resolved")).items as Array<Item & { kind: string }>).filter((i) => i.kind === "fact-review");
    const [raised] = await factItems(mac);
    expect(raised).toMatchObject({ title: "Review date passed: “Owner” in Orion", state: "open" });
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).not.toMatch(/review\/inbox\/fact-review/);

    await replicate(mac, pc);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toMatch(/review\/inbox\/fact-review/);
    expect(await factItems(pc)).toEqual([expect.objectContaining({ id: raised!.id, key: raised!.key, state: "open" })]);
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

  it("keeps an item about one Machine's own Replication on that Machine", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const note = join(mac.dataDir, "memory/notes/deploy.md");
    writeFileSync(note, `# Deploy\n\nToken: ${["ghp", "Q7f2Lk9Xw3Rt8Vb1Nm4Pz6Hc0Jd5Gs2Ya8Ue"].join("_")}\n`);
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("blocked");
    expect((await mac.get("/attention")).items.map((i: Item) => i.title)).toContain("Replication is blocked");
    // What the service does when it starts again: open the data folder, bringing inbox and Brain together.
    mac.app.openDataFolder(mac.dataDir);

    writeFileSync(note, "# Deploy\n\nToken: kept in the password manager\n");
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    await pc.clock.advance(CHECK);
    const onPc = (await pc.get("/attention?state=open,dismissed,snoozed,resolved")).items as Item[];
    expect(onPc.map((i) => i.title)).not.toContain("Replication is blocked");
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).not.toMatch(/review\/inbox\/replication/);
  });
});
