import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;
/** Far enough ahead that every schedule is due. */
const TOMORROW = () => new Date(Date.now() + 86_400_000);

interface ReaderView {
  machine: { id: string; name: string } | null;
  thisMachine: boolean;
  replicated: boolean;
  heartbeatAt: string | null;
  silent: boolean;
  lastRefreshAt: string | null;
}

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const readerOn = (m: TestMachine) => m.get<ReaderView>("/reader");
const idOf = async (m: TestMachine) => ((await m.get("/machine")) as { id: string }).id;

/** Every schedule falls due on `m`; returns the kinds of job it started. */
function runSchedules(m: TestMachine): string[] {
  return m.app.scheduler
    .tick(TOMORROW())
    .filter((r) => r.jobId !== null)
    .map((r) => r.id);
}

/** Waits until `m` runs no job, e.g. the first Source refresh that finishing setup starts. */
async function waitUntilIdle(m: TestMachine) {
  for (;;) {
    const jobs = (await m.get("/jobs")) as Array<{ id: string; status: string }>;
    const busy = jobs.find((j) => j.status === "queued" || j.status === "running");
    if (!busy) return;
    await m.waitJob(busy.id);
  }
}

/** Waits for the jobs to succeed; returns when each finished. */
async function waitForJobs(m: TestMachine, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const { job } = await m.waitJob(id);
    expect(job.status).toBe("succeeded");
    out.push(job.finishedAt);
  }
  return out;
}

describe("two Machines sharing a Brain", () => {
  it("run scheduled Source refresh and briefings only on the Reader, which every Machine names the same", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const macId = await idOf(mac);
    // The Machine that set Replication up stays the Reader; the one that joined hears so at its first check.
    await pc.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      const view = await readerOn(m);
      expect(view).toMatchObject({ machine: { id: macId, name: "Work Mac" }, thisMachine: m === mac, replicated: true, silent: false });
      expect(view.heartbeatAt).not.toBeNull();
    }
    expect(runSchedules(mac).sort()).toEqual(["attention:briefing", "attention:sync"]);
    expect(runSchedules(pc)).toEqual([]);
    // Joining started no Source refresh on the PC either.
    expect((await pc.get("/jobs")).filter((j: { kind: string }) => j.kind === "sync" || j.kind === "briefing")).toEqual([]);
  });

  it("hand the role to the Preferred Reader the owner names, recorded in the Brain", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const pcId = await idOf(pc);
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    // Named on the Mac; the PC reads it from the Brain and takes the role.
    await mac.put("/replication/preferred-reader", { machine: pcId });
    await mac.clock.advance(AFTER_WRITE);
    await pc.clock.advance(CHECK);
    expect(world.remote.git("show", "main:machines/preferred-reader.json")).toContain(pcId);
    expect(await readerOn(pc)).toMatchObject({ machine: { id: pcId, name: "Home PC" }, thisMachine: true });
    await mac.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      expect((await m.get("/replication/machines")).preferredReader).toBe(pcId);
      expect((await readerOn(m)).machine).toEqual({ id: pcId, name: "Home PC" });
    }
    expect(runSchedules(mac)).toEqual([]);
    expect(runSchedules(pc).sort()).toEqual(["attention:briefing", "attention:sync"]);
  });
});

describe("the Reader's Source refresh", () => {
  it("shows on every Machine when the Reader last refreshed every source", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await waitUntilIdle(mac);
    // The scheduled Source refresh and briefing both refresh every source; the later one counts.
    const ran = mac.app.scheduler.tick(TOMORROW());
    const finishedAt = (await waitForJobs(mac, ran.map((r) => r.jobId!))).sort().at(-1);
    expect((await readerOn(mac)).lastRefreshAt).toBe(finishedAt);
    // The Reader tells the others at its next check, which a finished Source refresh starts at once.
    await mac.clock.advance(0);
    await pc.clock.advance(CHECK);
    expect((await readerOn(pc)).lastRefreshAt).toBe(finishedAt);
  });

  it("still runs on the Machine the owner is on when started by hand", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(CHECK);
    expect((await readerOn(pc)).thisMachine).toBe(false);
    const { job } = await pc.post("/connections/vault-data/sync");
    await waitForJobs(pc, [job.id]);
    const source = ((await pc.get("/connections")) as Array<{ id: string; lastSuccessAt: string | null }>).find((c) => c.id === "vault-data")!;
    expect(source.lastSuccessAt).not.toBeNull();
  });

  it("raises Review-date inbox items on the Reader only, and every Machine shows them", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(CHECK);
    // A fact whose Review date has passed, written by hand on the PC and replicated to the Mac.
    mkdirSync(join(pc.dataDir, "memory/projects"), { recursive: true });
    writeFileSync(join(pc.dataDir, "memory/projects/orion-rollout.md"), ["---", "type: project", "title: Orion rollout", "---", "# Orion rollout", "", "## Current State", "- **Budget** (2026-01-10, review 2026-03-01): 90k EUR", ""].join("\n"));
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    const reviewItems = async (m: TestMachine) => ((await m.get("/attention?state=open")).items as Array<{ kind: string; title: string }>).filter((i) => i.kind === "fact-review");

    expect(runSchedules(pc)).toEqual([]);
    expect(await reviewItems(pc)).toEqual([]);

    const sync = mac.app.scheduler.tick(TOMORROW()).find((r) => r.id === "attention:sync")!;
    await waitForJobs(mac, [sync.jobId!]);
    expect((await reviewItems(mac)).map((i) => i.title)).toEqual(["Review date passed: “Budget” in Orion rollout"]);
    await mac.clock.advance(AFTER_WRITE);
    await pc.clock.advance(CHECK);
    expect((await reviewItems(pc)).map((i) => i.title)).toEqual(["Review date passed: “Budget” in Orion rollout"]);
  });
});

describe("the Reader lease", () => {
  it("is renewed on a heartbeat that adds no commit to the Brain's history", async () => {
    world = await startMachines(["Work Mac", "Home PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    const history = world.remote.git("rev-list", "--count", "main");
    const first = (await readerOn(mac)).heartbeatAt!;
    await mac.clock.advance(25 * 60_000);
    expect(world.remote.git("rev-list", "--count", "main")).toBe(history);
    const renewed = (await readerOn(mac)).heartbeatAt!;
    expect(Date.parse(renewed) - Date.parse(first)).toBeGreaterThanOrEqual(20 * 60_000);
    // The lease lives on a ref of its own, never on a branch, so a clone of the Brain does not carry it.
    expect(world.remote.git("for-each-ref", "--format=%(refname)")).toBe(["refs/heads/main", "refs/jarvis/reader"].join("\n"));
    await pc.clock.advance(CHECK);
    expect((await readerOn(pc)).heartbeatAt).toBe(renewed);
  });

  it("lapses while the Reader cannot reach the repository, and the Reader catches up once it renews", async () => {
    world = await startMachines(["Work Mac"]);
    const [mac] = world.machines as [TestMachine];
    world.remote.goOffline();
    await mac.clock.advance(31 * 60_000);
    expect(await readerOn(mac)).toMatchObject({ thisMachine: true, silent: true });
    // Asleep or offline, the Reader cannot be sure it still is one: scheduled reading waits.
    expect(runSchedules(mac)).toEqual([]);
    world.remote.goOnline();
    await mac.clock.advance(CHECK);
    expect((await readerOn(mac)).silent).toBe(false);
    expect(runSchedules(mac).sort()).toEqual(["attention:briefing", "attention:sync"]);
  });
});

describe("a Machine without Replication", () => {
  it("is its own Reader and runs scheduled Source refresh and briefings as before", async () => {
    world = await startMachines([]);
    const lone = await world.addMachine("Lone", { join: false });
    const before = await readerOn(lone);
    expect(before).toMatchObject({ machine: { id: await idOf(lone), name: "Lone" }, thisMachine: true, replicated: false, heartbeatAt: null, silent: false });

    await waitUntilIdle(lone);
    const ran = lone.app.scheduler.tick(TOMORROW());
    expect(ran.map((r) => r.id).sort()).toEqual(["attention:briefing", "attention:sync"]);
    expect(ran.every((r) => r.jobId !== null)).toBe(true);
    const finished = await waitForJobs(lone, ran.map((r) => r.jobId!));

    expect((await readerOn(lone)).lastRefreshAt).toBe(finished.sort().at(-1));
  });
});
