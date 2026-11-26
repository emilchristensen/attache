import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const DAY = 24 * 60 * 60_000;
const FORMAT_FILE = "machines/brain-format.json";
/** What a later release that reads and writes Brain format 2 says; no release does yet. */
const READS_2 = { reads: 2, writes: 2 };
const READS_1 = { reads: 1, writes: 1 };

let world: TestWorld | null = null;
let joining: TestService | null = null;

afterEach(async () => {
  await world?.stop();
  await joining?.stop();
  world = null;
  joining = null;
});

/** The Brain format record as the repository holds it, which is what every Machine reads. */
const pushedFormat = (w: TestWorld) => JSON.parse(w.remote.git("show", `main:${FORMAT_FILE}`)) as Record<string, unknown>;
const idOf = async (m: TestService) => ((await m.get("/machine")) as { id: string }).id;
const pushedRecord = (w: TestWorld, id: string) => JSON.parse(w.remote.git("show", `main:machines/${id}.json`)) as Record<string, unknown>;
const localHead = (m: TestMachine) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: m.dataDir, encoding: "utf8" }).trim();

/** Let every Machine send what it has and hear the others, twice round, so each has heard the others' latest. */
async function settle(machines: readonly TestMachine[]) {
  for (let round = 0; round < 2; round++) for (const m of machines) await m.clock.advance(AFTER_WRITE + CHECK);
}

/** A note the owner wrote by hand in the data folder; the next check commits it. */
function handNote(m: TestMachine, name: string) {
  mkdirSync(join(m.dataDir, "memory/notes"), { recursive: true });
  writeFileSync(join(m.dataDir, `memory/notes/${name}.md`), `# ${name}\n\nWritten on ${m.name}.\n`);
}

describe("The Brain format rises only when every Machine can read it", () => {
  it("is written as format 1 when Replication is set up, and a Machine that joins replicates on it", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    expect(pushedFormat(world)).toMatchObject({ format: 1 });

    handNote(pc, "from-pc");
    await settle([pc, mac]);
    expect((await pc.get("/replication")).status).toBe("up_to_date");
    expect(readFileSync(join(mac.dataDir, "memory/notes/from-pc.md"), "utf8")).toContain("Written on PC");
  });

  it("stays at format 1 while a Machine heard from in the last 30 days cannot read format 2, and rises once every Machine can", async () => {
    world = await startMachines(["Mac", "PC"]);
    let [mac, pc] = world.machines as [TestMachine, TestMachine];
    await settle([pc, mac]);

    mac = await world.restart(mac, { brainFormat: READS_2 });
    await settle([mac, pc]);
    expect(pushedRecord(world, await idOf(mac))).toMatchObject({ readsBrainFormat: 2 });
    expect(pushedFormat(world)).toMatchObject({ format: 1 });
    expect((await pc.get("/replication")).status).toBe("up_to_date");

    pc = await world.restart(pc, { brainFormat: READS_2 });
    await settle([pc, mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 2 });
    for (const m of [mac, pc]) expect((await m.get("/replication")).status).toBe("up_to_date");
  });

  it("rises once the Machine that cannot read it was last heard from more than 30 days ago, keeping fields a later release added to the record", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [first, pc] = world.machines as [TestMachine, TestMachine];
    let mac = first;
    await settle([pc, mac]);
    // A later release recorded something this one does not know.
    const file = join(mac.dataDir, FORMAT_FILE);
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), laterField: { kept: true } }, null, 2)}\n`);
    mac = await world.restart(mac, { brainFormat: READS_2 });
    await settle([mac, pc]);
    expect(pushedFormat(world)).toMatchObject({ format: 1, laterField: { kept: true } });

    // PC is put away: its clock stands still, so its record is not refreshed.
    mac.clock.skip(29 * DAY);
    await settle([mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 1 });
    mac.clock.skip(2 * DAY);
    await settle([mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 2, laterField: { kept: true } });
  });

  it("a Machine that finds a newer format writes nothing, shows Replication as paused with the reason, and resumes once it is updated", async () => {
    world = await startMachines(["Mac", "PC"]);
    let [mac, pc] = world.machines as [TestMachine, TestMachine];
    await settle([pc, mac]);
    const pcId = await idOf(pc);
    const pcRecord = pushedRecord(world, pcId);
    mac = await world.restart(mac, { brainFormat: READS_2 });
    mac.clock.skip(31 * DAY);
    await settle([mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 2 });

    // PC comes back from the drawer, still on a release that reads format 1, with a note written meanwhile.
    pc = await world.restart(pc, { after: 31 * DAY });
    handNote(pc, "while-paused");
    await settle([pc]);
    const sent = world.remote.git("rev-parse", "main");
    await settle([pc]);
    expect(world.remote.git("rev-parse", "main")).toBe(sent);
    expect(pushedRecord(world, pcId)).toEqual(pcRecord);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).not.toContain("memory/notes/while-paused.md");
    const paused = await pc.get("/replication");
    expect(paused).toMatchObject({ status: "paused", pause: { reason: "newer_brain_format", brainFormat: 2, readsBrainFormat: 1 } });
    expect(paused.cause).toContain("Update this Machine to keep replicating");
    // Nothing of the newer Brain was merged into PC's copy.
    expect(JSON.parse(readFileSync(join(pc.dataDir, FORMAT_FILE), "utf8"))).toMatchObject({ format: 1 });
    // The owner's changes to the Machines are refused rather than kept back silently.
    expect((await pc.call("PUT", "/replication/standby", { standby: true })).status).toBe(409);

    // Mac keeps replicating meanwhile.
    handNote(mac, "from-mac");
    await settle([mac, pc]);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain("memory/notes/from-mac.md");
    expect((await pc.get("/replication")).status).toBe("paused");

    pc = await world.restart(pc, { brainFormat: READS_2 });
    await settle([pc, mac]);
    expect(await pc.get("/replication")).toMatchObject({ status: "up_to_date", pause: null });
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain("memory/notes/while-paused.md");
    expect(pushedRecord(world, pcId)).toMatchObject({ readsBrainFormat: 2 });
    expect(readFileSync(join(pc.dataDir, "memory/notes/from-mac.md"), "utf8")).toContain("Written on Mac");
  });

  it("a Machine that joins a Brain in a newer format is paused by the join itself, and writes no record of itself", async () => {
    world = await startMachines(["Mac"], { brainFormat: READS_2 });
    expect(pushedFormat(world)).toMatchObject({ format: 2 });
    const sent = world.remote.git("rev-parse", "main");
    joining = await startTestService({ clock: new ManualClock(), setup: false });
    const pc = joining;

    expect(await pc.post("/replication/join", { remote: world.remote.url, path: pc.dataDir })).toMatchObject({ status: "paused", pause: { brainFormat: 2, readsBrainFormat: 1 } });
    expect(existsSync(join(pc.dataDir, `machines/${await idOf(pc)}.json`))).toBe(false);
    expect(world.remote.git("rev-parse", "main")).toBe(sent);
  });

  it("a Machine that joins a Brain in a newer format writes nothing into it, at the join and after a restart while still paused", async () => {
    world = await startMachines(["Mac"], { brainFormat: READS_2 });
    const [mac] = world.machines as [TestMachine];
    rmSync(join(mac.dataDir, "README.md"));
    await settle([mac]);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).not.toContain("README.md");
    const clock = new ManualClock();
    joining = await startTestService({ clock });
    let pc = joining;
    const due = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    mkdirSync(join(pc.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(pc.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${due}\n`);
    const { job } = await pc.post("/briefings", { kind: "manual" });
    expect((await pc.waitJob(job.id)).job.status).toBe("succeeded");
    expect(readdirSync(join(pc.dataDir, "review/inbox"))).toHaveLength(1);
    const target = join(mkdtempSync(join(tmpdir(), "attache-it-join-")), "brain");

    expect(await pc.post("/replication/join", { remote: world.remote.url, path: target })).toMatchObject({ status: "paused" });
    expect(existsSync(join(target, "review/inbox"))).toBe(false);
    expect(existsSync(join(target, "README.md"))).toBe(false);

    await pc.stop();
    joining = pc = await startTestService({ stateDir: pc.stateDir, clock });
    expect(await pc.get("/replication")).toMatchObject({ status: "paused" });
    expect(existsSync(join(target, "review/inbox"))).toBe(false);
    expect(existsSync(join(target, "README.md"))).toBe(false);
  });

  it("is not raised from what a Machine heard before it was away: it fetches the others' records first", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [first, pc] = world.machines as [TestMachine, TestMachine];
    let mac = first;
    await settle([pc, mac]);
    // PC keeps working for 31 days and sends its record again; Mac is away all that time, so its copy of PC's record is 31 days old.
    pc.clock.skip(31 * DAY);
    await settle([pc]);
    mac = await world.restart(mac, { brainFormat: READS_2, after: 31 * DAY });
    await settle([mac, pc]);
    expect(pushedFormat(world)).toMatchObject({ format: 1 });
    expect((await pc.get("/replication")).status).toBe("up_to_date");
  });

  it("the check that first finds a newer format commits and writes nothing", async () => {
    world = await startMachines(["Mac", "PC"]);
    let [mac, pc] = world.machines as [TestMachine, TestMachine];
    await settle([pc, mac]);
    const recordFile = join(pc.dataDir, `machines/${await idOf(pc)}.json`);
    mac = await world.restart(mac, { brainFormat: READS_2 });
    mac.clock.skip(31 * DAY);
    await settle([mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 2 });

    // PC comes back after 31 days, when its own record is due to be written again, with a note written meanwhile.
    pc = await world.restart(pc, { after: 31 * DAY });
    const head = localHead(pc);
    const record = readFileSync(recordFile, "utf8");
    const format = readFileSync(join(pc.dataDir, FORMAT_FILE), "utf8");
    handNote(pc, "while-paused");
    await settle([pc]);
    expect((await pc.get("/replication")).status).toBe("paused");
    expect(localHead(pc)).toBe(head);
    expect(readFileSync(recordFile, "utf8")).toBe(record);
    expect(readFileSync(join(pc.dataDir, FORMAT_FILE), "utf8")).toBe(format);
  });

  it("a Machine back on a release that cannot read the format, as after a rolled-back Update, pauses at once and commits nothing", async () => {
    world = await startMachines(["Mac", "PC"], { brainFormat: READS_2 });
    const [mac, first] = world.machines as [TestMachine, TestMachine];
    let pc = first;
    await settle([pc, mac]);
    expect(pushedFormat(world)).toMatchObject({ format: 2 });

    pc = await world.restart(pc, { brainFormat: READS_1 });
    const head = localHead(pc);
    handNote(pc, "after-rollback");
    await settle([pc]);
    expect(localHead(pc)).toBe(head);
    expect(await pc.get("/replication")).toMatchObject({ status: "paused", pause: { brainFormat: 2, readsBrainFormat: 1 } });
    expect((await mac.get("/replication")).status).toBe("up_to_date");
  });
});
