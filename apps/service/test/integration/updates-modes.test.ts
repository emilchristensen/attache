// Automatic updates (spec #130, ticket #139): the three modes, when the Updater checks, waiting for Jobs, and Restart now.
// Each Machine runs on a controlled clock and a fake installer runner, against a local stand-in for GitHub Releases.
import { describe, expect, it } from "vitest";
import type { UpdateMode, UpdatesView } from "@attache/contracts";
import type { JobContext } from "../../src/jobs/queue.ts";
import type { ReleaseServer } from "../fixtures/release-server.ts";
import { signedRelease } from "../fixtures/signed-release.ts";
import { installerFinished, updatesWorld, type UpdatesMachine } from "./updates-world.ts";

const { key, releases, machine, restart, outcomeSeen } = updatesWorld();

const HOUR = 60 * 60_000;
const view = (m: UpdatesMachine) => m.get<UpdatesView>("/updates");
const setMode = (m: UpdatesMachine, mode: UpdateMode) => m.put<UpdatesView>("/updates/settings", { mode });
/** Requests for the release list: one per check. */
const checks = (server: ReleaseServer) => server.requests.filter((r) => r.path.endsWith("/releases")).length;
/** Downloads of a release's archive. */
const archiveDownloads = (server: ReleaseServer) => server.requests.filter((r) => /\/download\/.*\.(tar\.gz|zip)$/.test(r.path)).length;

/** A Job that runs until the test lets it finish, as research or a briefing runs for minutes. */
interface HeldJob {
  id: string;
  finish(): void;
}

/** Start a Job that keeps running until `finish()`; resolves once the service reports it running. */
async function runningJob(m: UpdatesMachine, title: string): Promise<HeldJob> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  m.app.jobs.register("demo-long", async () => {
    await done;
    return { ok: true };
  });
  const { job } = m.app.jobs.create({ kind: "demo-long", title, input: {} });
  await m.waitJob(job.id, ["running"]);
  return { id: job.id, finish };
}

describe("when the Updater checks", () => {
  it("checks when the service starts and every 6 hours after", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.7.0", server);
    await m.clock.advance(0);
    expect(checks(server)).toBe(1);
    expect(await view(m)).toMatchObject({ status: "up_to_date", mode: "automatic" });

    await m.clock.advance(6 * HOUR - 1);
    expect(checks(server)).toBe(1);
    await m.clock.advance(1);
    expect(checks(server)).toBe(2);
    await m.clock.advance(6 * HOUR);
    expect(checks(server)).toBe(3);
  });

  it("in Off makes no request at all, not at start, not every 6 hours, not when asked", async () => {
    const server = await releases("0.7.0");
    const first = await machine("0.6.0", server);
    expect(await setMode(first, "off")).toMatchObject({ mode: "off", status: "off", update: null });
    const m = await restart(first, "0.6.0");
    await m.clock.advance(0);
    await m.clock.advance(24 * HOUR);
    expect(await view(m)).toMatchObject({ mode: "off", status: "off", update: null });
    expect(await m.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "off" });
    expect(await m.post<UpdatesView>("/updates/check", { reportOnly: false })).toMatchObject({ status: "off" });
    expect(await m.post<UpdatesView>("/updates/install")).toMatchObject({ status: "off" });
    expect(server.requests).toEqual([]);
    expect(m.runner.requests).toEqual([]);
  });

  it("in Off asks for nothing more, even when Off comes while a check waits for the release list", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    const letThrough = server.hold();
    const checking = m.post<UpdatesView>("/updates/check", { reportOnly: true });
    await expect.poll(() => checks(server)).toBe(1);
    await setMode(m, "off");
    letThrough();
    await checking;
    expect(server.requests.map((r) => r.path).filter((p) => !p.endsWith("/releases"))).toEqual([]);
    expect(await view(m)).toMatchObject({ status: "off", update: null });
  });

  it("checks at once when Automatic updates is turned back on", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    await setMode(m, "off");
    await m.clock.advance(0);
    expect(server.requests).toEqual([]);
    await setMode(m, "ask_first");
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ mode: "ask_first", status: "ready", update: { version: "0.7.0" } });
  });

  it("makes no request on a development install, which reports Updates as unavailable", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server, { releaseInstall: false });
    await m.clock.advance(0);
    await m.clock.advance(6 * HOUR);
    expect(await view(m)).toMatchObject({ status: "unavailable", update: null });
    expect(server.requests).toEqual([]);
  });
});

describe("the mode", () => {
  it("is Automatic by default, kept in this Machine's configuration, and set and read through the API", async () => {
    const m = await machine("0.6.0", await releases());
    expect((await view(m)).mode).toBe("automatic");
    expect((await m.get("/config")).config.updates).toEqual({ channel: "stable", mode: "automatic" });

    expect((await setMode(m, "ask_first")).mode).toBe("ask_first");
    expect((await view(m)).mode).toBe("ask_first");
    expect((await m.get("/config")).config.updates).toEqual({ channel: "stable", mode: "ask_first" });
    expect((await m.call("PUT", "/updates/settings", { mode: "sometimes" })).status).toBe(400);
    expect((await view(await restart(m, "0.6.0"))).mode).toBe("ask_first");
  });
});

describe("while an Update installs", () => {
  // A rollback restores the database from before the Update, never the configuration: a choice made during the install would hold on the version that started and not on the one the rollback returns to.
  it("refuses to change the mode or the Update channel, says why, and takes changes again once the new version runs", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.clock.advance(0);
    expect((await view(m)).status).toBe("installing");
    for (const body of [{ mode: "off" }, { channel: "beta" }]) {
      const r = await m.call("PUT", "/updates/settings", body);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: "update_installing", message: "Automatic updates and the Update channel can change once Attache 0.7.0 has finished installing." });
    }
    expect((await m.get("/config")).config.updates).toEqual({ channel: "stable", mode: "automatic" });

    const after = await restart(m, "0.7.0");
    installerFinished(after.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
    await outcomeSeen(after);
    expect(await setMode(after, "off")).toMatchObject({ mode: "off" });
  });
});

describe("Automatic", () => {
  it("installs a verified Update at once when no Job is running", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ status: "installing", update: { version: "0.7.0" }, jobs: null });
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
  });

  it("waits while Jobs run, with the exact count, and installs when the last one ends", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    const research = await runningJob(m, "Research");
    const briefing = await runningJob(m, "Briefing");
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ status: "waiting_for_jobs", jobs: 2, update: { version: "0.7.0" } });
    expect(m.runner.requests).toEqual([]);

    research.finish();
    await expect.poll(async () => (await view(m)).jobs).toBe(1);
    expect((await view(m)).status).toBe("waiting_for_jobs");
    expect(m.runner.requests).toEqual([]);

    briefing.finish();
    await expect.poll(async () => (await view(m)).status).toBe("installing");
    expect((await view(m)).jobs).toBeNull();
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
  });

  it("looks at the running Jobs again every minute", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    const job = await runningJob(m, "Research");
    await m.clock.advance(0);
    expect((await view(m)).status).toBe("waiting_for_jobs");
    // A Job that ended while nothing told the Updater: the next look a minute later finds none running.
    m.app.db.prepare("update jobs set status = 'succeeded' where id = ?").run(job.id);
    await m.clock.advance(60_000);
    expect((await view(m)).status).toBe("installing");
    job.finish();
  });

  it("installs anyway once it has waited 24 hours for Jobs", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    const job = await runningJob(m, "Research");
    await m.clock.advance(0);
    await m.clock.advance(24 * HOUR - 60_000);
    expect(await view(m)).toMatchObject({ status: "waiting_for_jobs", jobs: 1 });
    expect(m.runner.requests).toEqual([]);

    await m.clock.advance(60_000);
    expect(await view(m)).toMatchObject({ status: "installing", jobs: null });
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
    job.finish();
  });

  it("keeps counting the 24 hours across a restart, so a Machine restarted while always busy still installs", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    const job = await runningJob(m, "Research");
    await m.clock.advance(0);
    await m.clock.advance(20 * HOUR);
    expect(await view(m)).toMatchObject({ status: "waiting_for_jobs", jobs: 1 });

    // Still busy when the service restarts: the Job resumes after it.
    const after = await restart(m, "0.6.0");
    const busy = await runningJob(after, "Briefing");
    await after.clock.advance(0);
    expect(await view(after)).toMatchObject({ status: "waiting_for_jobs" });
    await after.clock.advance(4 * HOUR - 60_000);
    expect(after.runner.requests).toEqual([]);
    await after.clock.advance(60_000);
    expect(await view(after)).toMatchObject({ status: "installing", jobs: null });
    expect(after.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
    busy.finish();
    job.finish();
  });

  it("starts the 24 hours again for a newer Update than the one that waited", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    const job = await runningJob(m, "Research");
    await m.clock.advance(0);
    await m.clock.advance(20 * HOUR);

    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    const after = await restart(m, "0.6.0");
    const busy = await runningJob(after, "Briefing");
    await after.clock.advance(0);
    expect(await view(after)).toMatchObject({ status: "waiting_for_jobs", update: { version: "0.7.1" } });
    await after.clock.advance(4 * HOUR);
    expect(after.runner.requests).toEqual([]);
    await after.clock.advance(20 * HOUR);
    expect(after.runner.requests.map((r) => r.to)).toEqual(["0.7.1"]);
    busy.finish();
    job.finish();
  });

  it("does not install on a check that only reports", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    expect(await m.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "available" });
    expect(m.runner.requests).toEqual([]);
    // Check now from the Dashboard acts as the timer does.
    expect(await m.post<UpdatesView>("/updates/check", { reportOnly: false })).toMatchObject({ status: "installing" });
  });
});

describe("Ask first", () => {
  it("downloads and verifies the Update, stops at ready, and Install now applies it without downloading again", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    await setMode(m, "ask_first");
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ mode: "ask_first", status: "ready", update: { version: "0.7.0" } });
    expect(archiveDownloads(server)).toBe(1);
    await m.clock.advance(24 * HOUR);
    expect((await view(m)).status).toBe("ready");
    expect(m.runner.requests).toEqual([]);

    expect(await m.post<UpdatesView>("/updates/install")).toMatchObject({ status: "installing", update: { version: "0.7.0" } });
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
    expect(archiveDownloads(server)).toBe(1);
  });

  it("stays ready when a later check finds the same Update", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    await setMode(m, "ask_first");
    await m.clock.advance(0);
    expect(await m.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "ready", update: { version: "0.7.0" } });
    await m.clock.advance(6 * HOUR);
    expect((await view(m)).status).toBe("ready");
    expect(archiveDownloads(server)).toBe(1);
  });

  it("installs a waiting Update once switched to Automatic and no Job runs", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await setMode(m, "ask_first");
    await m.clock.advance(0);
    expect(await setMode(m, "automatic")).toMatchObject({ status: "installing" });
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);
  });
});

describe("Install now", () => {
  it("installs nothing when Off is chosen while it downloads", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    const letThrough = server.hold(/\.(tar\.gz|zip)$/);
    const installing = m.post<UpdatesView>("/updates/install");
    await expect.poll(() => archiveDownloads(server)).toBe(1);
    await setMode(m, "off");
    letThrough();
    expect(await installing).toMatchObject({ status: "off" });
    expect(m.runner.requests).toEqual([]);
  });
});

describe("Restart now", () => {
  it("applies the Update at once while Jobs run, and those Jobs resume from their checkpoint after the restart", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    // Research that has done 3 of its 5 steps and saved its place, still working when the service stops under it.
    m.app.jobs.register("demo-long", async (ctx: JobContext) => {
      ctx.saveCheckpoint({ step: 3 });
      await new Promise(() => {});
    });
    const { job } = m.app.jobs.create({ kind: "demo-long", title: "Research", input: { steps: 5, stepMs: 10, effectAtStep: 99 } });
    await m.waitJob(job.id, ["running"]);
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ status: "waiting_for_jobs", jobs: 1 });

    expect(await m.post<UpdatesView>("/updates/install")).toMatchObject({ status: "installing", jobs: null });
    expect(m.runner.requests.map((r) => r.to)).toEqual(["0.7.0"]);

    // The installer restarts the service on the new version, whose own runner picks the Job up where it stopped.
    const after = await restart(m, "0.7.0");
    const done = await after.waitJob(job.id);
    expect(done.job).toMatchObject({ status: "succeeded", result: { completedSteps: 5 } });
    const types: string[] = done.events.map((e: { type: string }) => e.type);
    const resumed = done.events.slice(types.lastIndexOf("recovered")).filter((e: { type: string }) => e.type === "progress");
    expect(resumed.map((e: { data: { note?: string } }) => e.data.note)).toEqual(["Step 4 of 5", "Step 5 of 5"]);
  });
});
