import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { testFolder } from "./harness.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const DAY = 24 * 60 * 60_000;

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

interface ListedMachine {
  id: string;
  name: string;
  version: string | null;
}

const machinesOn = async (m: TestMachine) => ((await m.get("/replication/machines")) as { machines: ListedMachine[] }).machines;
const idOf = async (m: TestMachine) => ((await m.get("/machine")) as { id: string }).id;
/** A Machine's record as the repository holds it, which is what every other Machine reads. */
const pushedRecord = (w: TestWorld, id: string) => JSON.parse(w.remote.git("show", `main:machines/${id}.json`)) as Record<string, unknown>;

describe("Machine records carry the version and the newest readable Brain format", () => {
  it("each Machine records its version and Brain format 1, and every Machine lists the others' versions", async () => {
    world = await startMachines(["Mac", "PC"], { version: "0.7.0" });
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);

    for (const m of [mac, pc]) {
      const record = pushedRecord(world, await idOf(m));
      expect(record).toMatchObject({ name: m.name, version: "0.7.0", readsBrainFormat: 1 });
      expect((await machinesOn(m)).map((x) => [x.name, x.version]).sort()).toEqual([
        ["Mac", "0.7.0"],
        ["PC", "0.7.0"],
      ]);
    }
  });

  it("a Machine restarted on a newer version, as after an Update, says so at start and the others list it", async () => {
    world = await startMachines(["Mac", "PC"], { version: "0.7.0" });
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);

    const updated = await world.restart(pc, { version: "0.7.1" });
    await updated.clock.advance(CHECK);
    await mac.clock.advance(CHECK);

    expect(pushedRecord(world, await idOf(updated))).toMatchObject({ version: "0.7.1", readsBrainFormat: 1 });
    expect((await machinesOn(mac)).find((x) => x.name === "PC")!.version).toBe("0.7.1");
  });

  it("a Machine back on an earlier version, as after a rolled-back Update, keeps the fields the newer version added to its record", async () => {
    world = await startMachines(["Mac"], { version: "0.7.1" });
    const [mac] = world.machines as [TestMachine];
    const id = await idOf(mac);
    // What 0.7.1 might record that 0.7.0 does not know.
    const file = join(mac.dataDir, "machines", `${id}.json`);
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), laterField: { kept: true } }, null, 2)}\n`);
    await mac.clock.advance(AFTER_WRITE + CHECK);

    const back = await world.restart(mac, { version: "0.7.0" });
    await back.clock.advance(AFTER_WRITE + CHECK);
    expect(pushedRecord(world, id)).toMatchObject({ version: "0.7.0", readsBrainFormat: 1, laterField: { kept: true } });
  });

  it("refreshes the record at least once a week while running, and commits nothing before the week has passed", async () => {
    world = await startMachines(["Mac"], { version: "0.7.0" });
    const [mac] = world.machines as [TestMachine];
    const id = await idOf(mac);
    await mac.clock.advance(AFTER_WRITE + CHECK);
    const head = world.remote.git("rev-parse", "main");
    const first = pushedRecord(world, id);

    // Six days on, with nothing changed: no commit.
    mac.clock.skip(6 * DAY);
    await mac.clock.advance(CHECK);
    await mac.clock.advance(AFTER_WRITE + CHECK);
    expect(world.remote.git("rev-parse", "main")).toBe(head);

    // Past the week: the record says the Machine was heard from now, and it reaches the remote.
    mac.clock.skip(DAY);
    await mac.clock.advance(CHECK);
    await mac.clock.advance(AFTER_WRITE + CHECK);
    expect(world.remote.git("rev-parse", "main")).not.toBe(head);
    const refreshed = pushedRecord(world, id);
    expect(Date.parse(refreshed.updatedAt as string) - Date.parse(first.updatedAt as string)).toBeGreaterThanOrEqual(7 * DAY);
    expect(refreshed).toMatchObject({ name: "Mac", version: "0.7.0", readsBrainFormat: 1, standby: false });
  });

  it("lists a Machine on an earlier version, whose record has no version or Brain format, as version unknown", async () => {
    world = await startMachines(["Mac"], { version: "0.7.0" });
    const [mac] = world.machines as [TestMachine];
    // A Machine on 0.6.0 joined and pushed its record, as that version writes it.
    const old = "6b1f0c7e-2d4a-4c55-9a8e-1f2e3d4c5b6a";
    const clone = join(testFolder("old-machine"), "brain");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: clone, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Old Laptop", GIT_AUTHOR_EMAIL: "old@example.invalid", GIT_COMMITTER_NAME: "Old Laptop", GIT_COMMITTER_EMAIL: "old@example.invalid" } });
    execFileSync("git", ["clone", "--quiet", world.remote.url, clone], { stdio: "pipe" });
    mkdirSync(join(clone, "machines"), { recursive: true });
    writeFileSync(join(clone, "machines", `${old}.json`), `${JSON.stringify({ id: old, name: "Old Laptop", standby: false, updatedAt: mac.clock.now().toISOString() }, null, 2)}\n`);
    git("add", "machines");
    git("commit", "--quiet", "-m", "Old Laptop: join");
    git("push", "--quiet", "origin", "main");

    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    const listed = await machinesOn(mac);
    expect(listed.map((x) => [x.name, x.version])).toEqual([
      ["Mac", "0.7.0"],
      ["Old Laptop", null],
    ]);
  });
});
