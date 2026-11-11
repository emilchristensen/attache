import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";

const CHECK = 60_000;
const AFTER_WRITE = 30_000;

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

const saveProject = (m: TestMachine, title: string, status: string) =>
  m.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: status }] }] });

describe("Replication as the Dashboard shows it", () => {
  it("reports the last time this Machine was up to date, which an offline spell does not move", async () => {
    world = await startMachines(["Mac"]);
    const [mac] = world.machines as [TestMachine];
    const atSetup = await mac.get("/replication");
    expect(atSetup.status).toBe("up_to_date");
    expect(atSetup.upToDateAt).toBe(mac.clock.now().toISOString());

    world.remote.goOffline();
    await mac.clock.advance(CHECK);
    const offline = await mac.get("/replication");
    expect(offline.status).toBe("offline");
    expect(offline.upToDateAt).toBe(atSetup.upToDateAt);
    expect(offline.lastCheckedAt).not.toBe(atSetup.lastCheckedAt);

    world.remote.goOnline();
    await saveProject(mac, "Back online", "Yes");
    await mac.clock.advance(AFTER_WRITE);
    const back = await mac.get("/replication");
    expect(back.status).toBe("up_to_date");
    expect(back.upToDateAt).toBe(mac.clock.now().toISOString());
  });

  it("switches off and leaves the Brain on this Machine intact, and switches on again where it left off", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await saveProject(mac, "Kept after off", "Still here");
    await mac.clock.advance(AFTER_WRITE);
    const pushed = world.remote.git("rev-parse", "main");

    const off = await mac.post("/replication/off");
    expect(off.status).toBe("off");
    expect((await mac.get("/replication")).status).toBe("off");
    expect(readFileSync(join(mac.dataDir, "memory/projects/kept-after-off.md"), "utf8")).toContain("Still here");
    expect(existsSync(join(mac.dataDir, ".git"))).toBe(true);
    expect((await mac.get("/memory/search?q=Kept%20after%20off")).hits.length).toBeGreaterThan(0);

    // Saves carry on locally and nothing is sent while off.
    await saveProject(mac, "Written while off", "Local only");
    await mac.clock.advance(AFTER_WRITE + CHECK);
    expect(world.remote.git("rev-parse", "main")).toBe(pushed);
    await saveProject(pc, "Written on the PC meanwhile", "Shared");
    await pc.clock.advance(AFTER_WRITE);

    // Setting up again with the same repository picks up where it left off, in both directions.
    const on = await mac.post("/replication/setup", { remote: world.remote.url });
    expect(on.status).toBe("up_to_date");
    await mac.clock.advance(CHECK);
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain("memory/projects/written-while-off.md");
    expect(existsSync(join(mac.dataDir, "memory/projects/written-on-the-pc-meanwhile.md"))).toBe(true);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
  });

  it("switching off when it is already off changes nothing", async () => {
    world = await startMachines([]);
    const lone = await world.addMachine("Lone", { join: false });
    expect((await lone.post("/replication/off")).status).toBe("off");
    expect(existsSync(join(lone.dataDir, ".git"))).toBe(false);
  });

  const machinesOn = async (m: TestMachine) => (await m.get("/replication/machines")) as { machines: Array<{ id: string; name: string; standby: boolean; thisMachine: boolean; lastChangeAt: string | null }>; preferredReader: string | null };
  const idOf = async (m: TestMachine) => ((await m.get("/machine")) as { id: string }).id;

  it("lists every Machine on every Machine, with the one it runs on marked and when each last changed the Brain", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      const { machines } = await machinesOn(m);
      expect(machines.map((x) => x.name).sort()).toEqual(["Mac", "PC"]);
      expect(machines.filter((x) => x.thisMachine).map((x) => x.name)).toEqual([m.name]);
      for (const x of machines) expect(x.standby).toBe(false);
    }
    const pcOnMac = (await machinesOn(mac)).machines.find((x) => x.name === "PC")!;
    expect(pcOnMac.id).toBe(await idOf(pc));
    // Git keeps commit times to the second.
    expect(Math.abs(Date.parse(pcOnMac.lastChangeAt!) - pc.clock.now().getTime())).toBeLessThan(1_000);
  });

  it("renaming a Machine shows the new name on the others", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    await pc.call("PATCH", "/machine", { name: "Omarchy" });
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    expect((await machinesOn(mac)).machines.map((x) => x.name).sort()).toEqual(["Mac", "Omarchy"]);
  });

  it("records standby and the Preferred Reader in the Brain, so every Machine reads the same", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const pcId = await idOf(pc);
    // The PC's record, written when it joined, reaches the Mac.
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    expect((await pc.put("/replication/standby", { standby: true })).machines.find((x: { id: string }) => x.id === pcId).standby).toBe(true);
    expect((await mac.put("/replication/preferred-reader", { machine: pcId })).preferredReader).toBe(pcId);
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(AFTER_WRITE);
    await pc.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      const view = await machinesOn(m);
      expect(view.preferredReader).toBe(pcId);
      expect(view.machines.find((x) => x.id === pcId)!.standby).toBe(true);
    }
    expect(world.remote.git("ls-tree", "-r", "--name-only", "main")).toContain(`machines/${pcId}.json`);

    expect((await mac.put("/replication/preferred-reader", { machine: null })).preferredReader).toBeNull();
    const unknown = await mac.call("PUT", "/replication/preferred-reader", { machine: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("unknown_machine");
  });

  it("settles two Machines naming a different Preferred Reader at once: the later choice wins and nothing blocks", async () => {
    world = await startMachines(["Mac", "PC"]);
    const [mac, pc] = world.machines as [TestMachine, TestMachine];
    const [macId, pcId] = [await idOf(mac), await idOf(pc)];
    await pc.clock.advance(AFTER_WRITE);
    await mac.clock.advance(CHECK);
    world.remote.goOffline();
    await mac.put("/replication/preferred-reader", { machine: macId });
    // The PC chooses a minute later than the Mac by both clocks.
    await pc.clock.advance(CHECK);
    await pc.put("/replication/preferred-reader", { machine: pcId });
    await mac.clock.advance(AFTER_WRITE);
    await pc.clock.advance(AFTER_WRITE);
    world.remote.goOnline();
    await mac.clock.advance(CHECK);
    await pc.clock.advance(CHECK);
    await mac.clock.advance(CHECK);
    for (const m of [mac, pc]) {
      expect((await m.get("/replication")).status).toBe("up_to_date");
      expect((await machinesOn(m)).preferredReader).toBe(pcId);
    }
  });

  it("refuses standby and a Preferred Reader while Replication is off: a lone Machine is its own Reader", async () => {
    world = await startMachines([]);
    const lone = await world.addMachine("Lone", { join: false });
    const view = await machinesOn(lone);
    expect(view.machines.map((x) => [x.name, x.thisMachine])).toEqual([["Lone", true]]);
    expect(view.preferredReader).toBeNull();
    for (const [path, body] of [["/replication/standby", { standby: true }], ["/replication/preferred-reader", { machine: await idOf(lone) }]] as const) {
      const r = await lone.call("PUT", path, body);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("replication_off");
    }
    expect(existsSync(join(lone.dataDir, "machines"))).toBe(false);
  });
});
