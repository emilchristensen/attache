// A Machine that fell behind asks to be updated (spec #130, ticket #143): Replication paused on a Brain format this
// Machine's Attache cannot read raises one system notification and checks for an Update at once, unless Automatic
// updates is Off, where it makes no request; once the Update is installed, Replication resumes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplicationView, UpdateMode, UpdatesView } from "@attache/contracts";
import { startMachines, type TestWorld } from "./machines.ts";
import { installerFinished, updatesWorld, type UpdatesMachine } from "./updates-world.ts";

const CHECK = 60_000;
/** A later release that reads and writes Brain format 2; no release does yet. */
const READS_2 = { reads: 2, writes: 2 };
const PAUSED_TITLE = "Update this Machine to keep replicating";
const PAUSED_BODY = "Replication is paused: the Brain is in Brain format 2, and this Machine's Attache reads Brain format 1 at most. Saves carry on here and are sent once it is updated.";

const { releases, publish, machine, restart } = updatesWorld();

let world: TestWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

/**
 * Mac, on a later release, set the Brain up in Brain format 2. PC runs 0.6.0, which reads format 1, in `mode`; it has
 * made its check at start (nothing newer then), and 0.7.0 is published since. PC then joins the Brain, and its first
 * check finds the newer format.
 */
async function pcJoinsNewerBrain(mode: UpdateMode): Promise<UpdatesMachine> {
  world = await startMachines(["Mac"], { brainFormat: READS_2 });
  const server = await releases("0.6.0");
  const pc = await machine("0.6.0", server, { setup: false });
  await pc.call("PUT", "/updates/settings", { mode });
  await pc.clock.advance(0);
  publish(server, "0.7.0");
  await pc.post("/replication/join", { remote: world.remote.url, path: pc.dataDir });
  await pc.post("/setup/complete");
  await pc.clock.advance(CHECK);
  expect(await pc.get<ReplicationView>("/replication")).toMatchObject({ status: "paused", pause: { brainFormat: 2, readsBrainFormat: 1 } });
  return pc;
}

describe("a Machine whose Replication paused on a newer Brain format", () => {
  it("in Automatic, checks for an Update at once and installs it, and raises one system notification", async () => {
    const pc = await pcJoinsNewerBrain("automatic");

    // No 6-hour check has come round: the pause itself asked for the Update.
    expect(pc.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
    expect((await pc.get<UpdatesView>("/updates")).status).toBe("installing");
    expect(pc.notifications.shown).toEqual([{ title: PAUSED_TITLE, body: `${PAUSED_BODY} Attache is looking for an Update now.` }]);
  });

  it("in Ask first, checks at once and has the Update ready to install", async () => {
    const pc = await pcJoinsNewerBrain("ask_first");

    expect(await pc.get<UpdatesView>("/updates")).toMatchObject({ status: "ready", update: { version: "0.7.0" } });
    expect(pc.runner.requests).toEqual([]);
    expect(pc.notifications.shown).toEqual([{ title: PAUSED_TITLE, body: `${PAUSED_BODY} Attache is looking for an Update now.` }]);
  });

  it("with Automatic updates Off, makes no request at all and only says so", async () => {
    const pc = await pcJoinsNewerBrain("off");
    await pc.clock.advance(CHECK);

    expect(pc.releaseServer.requests).toEqual([]);
    expect(pc.runner.requests).toEqual([]);
    expect((await pc.get<UpdatesView>("/updates")).status).toBe("off");
    expect(pc.notifications.shown).toEqual([
      { title: PAUSED_TITLE, body: `${PAUSED_BODY} Automatic updates is Off. Attache does not look for Updates and makes no request about them. Install a newer release, or choose Automatic or Ask first in Settings, Updates.` },
    ]);
  });

  it("raises the notification once: later checks and restarts while still paused raise none", async () => {
    const first = await pcJoinsNewerBrain("off");
    await first.clock.advance(3 * CHECK);
    const again = await restart(first, "0.6.0");
    await again.clock.advance(CHECK);
    const third = await restart(again, "0.6.0");
    await third.clock.advance(CHECK);

    expect((await third.get<ReplicationView>("/replication")).status).toBe("paused");
    expect(third.notifications.shown).toHaveLength(1);
  });

  it("raises the notification once per pause, also when a failure of another kind came in between", async () => {
    const pc = await pcJoinsNewerBrain("off");
    // The owner breaks the Brain format record by hand: Replication is blocked on it, then paused again once it is put back.
    const file = join(pc.dataDir, "machines/brain-format.json");
    const record = readFileSync(file, "utf8");
    writeFileSync(file, "{ not json");
    await pc.clock.advance(CHECK);
    expect((await pc.get<ReplicationView>("/replication")).status).toBe("blocked");
    writeFileSync(file, record);
    await pc.clock.advance(CHECK);
    expect((await pc.get<ReplicationView>("/replication")).status).toBe("paused");

    expect(pc.notifications.shown).toHaveLength(1);
  });

  it("resumes Replication once the Update is installed, and raises nothing more", async () => {
    const pc = await pcJoinsNewerBrain("automatic");
    installerFinished(pc.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
    const updated = await restart(pc, "0.7.0", { brainFormat: READS_2 });
    await updated.clock.advance(CHECK);

    expect(await updated.get<ReplicationView>("/replication")).toMatchObject({ status: "up_to_date", pause: null });
    expect((await updated.get<UpdatesView>("/updates")).lastUpdate).toMatchObject({ outcome: "updated", to: "0.7.0" });
    expect(updated.notifications.shown).toHaveLength(1);
  });
});
