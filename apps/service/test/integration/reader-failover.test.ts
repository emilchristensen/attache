import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureServer } from "../fixtures/fixture-server.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { AFTER_WRITE, CHECK, SILENCE, advanceTo, connectGitHub, idOf, readerOn, runSchedules, startGitHub, startSchedules, waitForJobs, waitUntilIdle } from "./reader-helpers.ts";

let world: TestWorld | null = null;
let github: FixtureServer | null = null;

afterEach(async () => {
  await world?.stop();
  await github?.close();
  world = null;
  github = null;
});

/** Marks `m` as standby and lets every other Machine hear about it. */
async function markStandby(m: TestMachine, others: TestMachine[]) {
  await m.put("/replication/standby", { standby: true });
  await m.clock.advance(AFTER_WRITE);
  for (const o of others) await o.clock.advance(CHECK);
}

/** When the Reader's lease lapses, as `m` heard it. */
async function lapseOf(m: TestMachine): Promise<number> {
  const { heartbeatAt } = await readerOn(m);
  return Date.parse(heartbeatAt!) + SILENCE;
}

/**
 * The Mac, the Preferred Reader, goes quiet and the standby PC takes over;
 * then the Mac wakes up (its clock jumps to the PC's time, as after sleep) and
 * makes its first check, while the PC has not checked since.
 */
async function handOverAndBack(world: TestWorld): Promise<{ mac: TestMachine; pc: TestMachine; macId: string; pcId: string }> {
  const [mac, pc] = world.machines as [TestMachine, TestMachine];
  const [macId, pcId] = [await idOf(mac), await idOf(pc)];
  await mac.put("/replication/preferred-reader", { machine: macId });
  await mac.clock.advance(AFTER_WRITE);
  await markStandby(pc, [mac]);

  await advanceTo(pc, (await lapseOf(pc)) + CHECK);
  expect((await readerOn(pc)).machine?.id).toBe(pcId);

  mac.clock.skip(pc.clock.now().getTime() - mac.clock.now().getTime());
  await mac.clock.advance(CHECK);
  return { mac, pc, macId, pcId };
}

describe("Reader failover", () => {
  it("makes a standby Machine with its sources connected the Reader after 30 minutes of silence", async () => {
    github = await startGitHub();
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const pcId = await idOf(pc);
    await connectGitHub(pc, github);
    await markStandby(pc, [mac]);
    // The standby flag is recorded in the Brain, so every Machine reads the same.
    expect(JSON.parse(world.remote.git("show", `main:machines/${pcId}.json`))).toMatchObject({ id: pcId, standby: true });

    // The Mac goes quiet: its clock stops, so it neither checks nor renews.
    const lapse = await lapseOf(pc);
    await advanceTo(pc, lapse - CHECK);
    expect(await readerOn(pc)).toMatchObject({ machine: { name: "Work Mac" }, thisMachine: false, silent: false });
    expect(runSchedules(pc)).toEqual([]);

    await advanceTo(pc, lapse + CHECK);
    expect(await readerOn(pc)).toMatchObject({ machine: { id: pcId, name: "Home PC" }, thisMachine: true, silent: false });
    expect(runSchedules(pc).sort()).toEqual(["attention:briefing", "attention:source-refresh"]);
  });

  it("never hands the role to a Machine not marked standby, or to a standby without connected sources", async () => {
    github = await startGitHub();
    world = await startMachines(["Work Mac", "Home PC", "Laptop"]);
    const [mac, pc, laptop] = world.machines as [TestMachine, TestMachine, TestMachine];
    // The PC can read but is not a standby; the laptop is a standby with nothing to read but the Brain.
    await connectGitHub(pc, github);
    await markStandby(laptop, [mac, pc]);

    const lapse = await lapseOf(pc);
    for (const m of [pc, laptop]) {
      await advanceTo(m, lapse + 5 * CHECK);
      expect(await readerOn(m)).toMatchObject({ machine: { name: "Work Mac" }, thisMachine: false, silent: true });
      expect(runSchedules(m)).toEqual([]);
    }
  });

  it("lets only one of two standby Machines take the lease when both try at the same moment", async () => {
    github = await startGitHub();
    world = await startMachines(["Work Mac", "Home PC", "Laptop"]);
    const [mac, pc, laptop] = world.machines as [TestMachine, TestMachine, TestMachine];
    for (const m of [pc, laptop]) await connectGitHub(m, github);
    await markStandby(pc, [mac, laptop]);
    await markStandby(laptop, [mac, pc]);

    // Both wake past the Mac's silence at the same moment, check together and both find the lease lapsed.
    const lapse = await lapseOf(pc);
    for (const m of [pc, laptop]) m.clock.skip(lapse + CHECK - m.clock.now().getTime());
    const leaseCommits = () => Number(world!.remote.git("rev-list", "--count", "--glob=refs/jarvis/*"));
    const before = leaseCommits();
    const held = world.remote.holdLeaseWrites(2);
    await Promise.all([pc.clock.advance(CHECK), laptop.clock.advance(CHECK)]);
    held.stop();
    expect(held.arrived()).toBe(2);

    // One write won; the other Machine read the winner's lease and left it alone.
    expect(leaseCommits()).toBe(before + 1);
    const [onPc, onLaptop] = [await readerOn(pc), await readerOn(laptop)];
    expect(onPc.machine).toEqual(onLaptop.machine);
    expect([onPc.thisMachine, onLaptop.thisMachine].sort()).toEqual([false, true]);
    const [winner, loser] = onPc.thisMachine ? [pc, laptop] : [laptop, pc];
    expect(runSchedules(winner).sort()).toEqual(["attention:briefing", "attention:source-refresh"]);
    expect(runSchedules(loser)).toEqual([]);
  });

  it("gives the role back to the Preferred Reader when it returns, and the standby stops", async () => {
    github = await startGitHub();
    world = await startMachines(["Work Mac", "Home PC"]);
    await connectGitHub(world.machines[1]!, github);
    const { mac, pc, macId } = await handOverAndBack(world);
    expect(await readerOn(mac)).toMatchObject({ machine: { id: macId, name: "Work Mac" }, thisMachine: true, silent: false });
    expect(runSchedules(mac).sort()).toEqual(["attention:briefing", "attention:source-refresh"]);

    await pc.clock.advance(CHECK);
    expect(await readerOn(pc)).toMatchObject({ machine: { id: macId, name: "Work Mac" }, thisMachine: false, silent: false });
    expect(runSchedules(pc)).toEqual([]);
  });

  it("leaves no duplicate inbox items when both Machines refresh at once around the handover", async () => {
    github = await startGitHub();
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    for (const m of [mac, pc]) await connectGitHub(m, github);
    // A task with a due date, in the Brain on both Machines: the data folder source raises an item for it.
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    mkdirSync(join(mac.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(mac.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${due}\n`);
    await mac.clock.advance(CHECK);
    await waitUntilIdle(mac);
    await handOverAndBack(world);

    // The Mac is the Reader again, and the PC has not heard yet: both refresh every source.
    expect((await readerOn(pc)).thisMachine).toBe(true);
    const [onMac, onPc] = [startSchedules(mac), startSchedules(pc)];
    expect([onMac.length, onPc.length]).toEqual([2, 2]);
    await waitForJobs(mac, onMac);
    await waitForJobs(pc, onPc);
    for (const m of [mac, pc, mac, pc]) await m.clock.advance(AFTER_WRITE + CHECK);

    const inbox = async (m: TestMachine) => ((await m.get("/attention?state=open")).items as Array<{ title: string }>).map((i) => i.title).sort();
    const titles = await inbox(mac);
    expect(titles).toEqual(expect.arrayContaining([expect.stringContaining("Book the venue"), expect.stringContaining("Tidy the release notes")]));
    expect(new Set(titles).size).toBe(titles.length);
    expect(await inbox(pc)).toEqual(titles);
    for (const m of [mac, pc]) expect((await m.get("/replication")).status).toBe("up_to_date");
    // Each Machine's briefing is kept, in a file of its own.
    expect(world.remote.git("ls-tree", "--name-only", "main", "deliverables/briefings/").split("\n")).toHaveLength(2);
  });
});
