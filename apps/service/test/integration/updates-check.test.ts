// Finding the right Update (spec #130, ticket #136): the Updater against a local stand-in for GitHub Releases, through the HTTP API.
import { describe, expect, it } from "vitest";
import type { UpdatesView } from "@attache/contracts";
import { manifestFileName, signatureFileName } from "../../src/release/manifest.ts";
import { markVersionBad } from "../../src/updates/bad-versions.ts";
import { signedRelease, testReleaseKeys } from "../fixtures/signed-release.ts";
import type { TestService } from "./harness.ts";
import { updatesWorld } from "./updates-world.ts";

const { key, releases, machine } = updatesWorld();

/** Event types the Dashboard's event stream carries while `act` runs. */
async function eventsDuring(svc: TestService, act: () => Promise<unknown>): Promise<string[]> {
  const ctrl = new AbortController();
  const res = await fetch(`${svc.url}/api/v1/events`, { headers: { authorization: `Bearer ${svc.token}` }, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const types: string[] = [];
  let buf = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
          const data = /^data: (.*)$/m.exec(buf.slice(0, end))?.[1];
          if (data) types.push((JSON.parse(data) as { type: string }).type);
          buf = buf.slice(end + 2);
        }
      }
    } catch {
      // The stream was closed below.
    }
  })();
  await expect.poll(() => types).toContain("hello");
  await act();
  // The last event of a check is sent before its answer; give the stream a moment to carry it.
  await expect.poll(() => types.filter((t) => t === "updates.changed").length).toBeGreaterThanOrEqual(2);
  ctrl.abort();
  await reading;
  return types;
}

const check = (svc: TestService) => svc.post<UpdatesView>("/updates/check", { reportOnly: true });
const setChannel = (svc: TestService, channel: "stable" | "beta") => svc.put<UpdatesView>("/updates/settings", { channel });

describe("finding the right Update", () => {
  it("offers the newest Stable release to a Machine on Stable, from its signed manifest", async () => {
    const server = await releases("0.6.0", "0.6.1", "0.7.0-beta.1");
    const svc = await machine("0.6.0", server);
    expect(await svc.get<UpdatesView>("/updates")).toMatchObject({ version: "0.6.0", channel: "stable", status: "not_checked", update: null, lastCheckedAt: null });

    const view = await check(svc);
    expect(view).toMatchObject({ version: "0.6.0", channel: "stable", status: "available", reason: null });
    expect(view.update).toEqual({ version: "0.6.1", channel: "stable", publishedAt: "2026-11-26T09:00:00.000Z", notes: "## 0.6.1\n\nWhat changed in 0.6.1.\n" });
    expect(view.lastCheckedAt).not.toBeNull();
    expect(await svc.get<UpdatesView>("/updates")).toEqual(view);
  });

  it("keeps a Machine on Stable off Beta releases, and gives a Machine on Beta a newer Stable release", async () => {
    const server = await releases("0.7.0-beta.1", "0.7.0", "0.8.0-beta.1");
    const svc = await machine("0.6.0", server);
    expect((await check(svc)).update?.version).toBe("0.7.0");

    expect(await setChannel(svc, "beta")).toMatchObject({ channel: "beta", status: "not_checked", update: null });
    expect((await check(svc)).update).toMatchObject({ version: "0.8.0-beta.1", channel: "beta" });

    const onBeta = await machine("0.7.0-beta.1", server);
    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    await setChannel(onBeta, "beta");
    expect((await check(onBeta)).update?.version).toBe("0.8.0-beta.1");
  });

  it("keeps a Machine switched from Beta to Stable on its version until Stable passes it", async () => {
    const server = await releases("0.7.0", "0.8.0-beta.1");
    const svc = await machine("0.8.0-beta.1", server);
    await setChannel(svc, "beta");
    await setChannel(svc, "stable");
    expect(await check(svc)).toMatchObject({ status: "up_to_date", update: null, reason: null });

    server.publish("0.8.0", signedRelease({ version: "0.8.0", key }));
    expect(await check(svc)).toMatchObject({ status: "available", update: { version: "0.8.0" } });
  });

  it("says a Machine is up to date when no release is newer than the one it runs", async () => {
    const svc = await machine("0.7.0", await releases("0.6.0", "0.6.1", "0.7.0"));
    const view = await check(svc);
    expect(view).toMatchObject({ status: "up_to_date", update: null, reason: null });
    expect(view.lastCheckedAt).not.toBeNull();
  });

  it("skips a version that failed on this Machine, and still takes a newer one", async () => {
    const server = await releases("0.6.1", "0.7.0");
    const svc = await machine("0.6.0", server);
    markVersionBad(svc.stateDir, { version: "0.7.0", reason: "Attache 0.7.0 did not start.", at: new Date() });
    expect((await check(svc)).update?.version).toBe("0.6.1");

    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    expect((await check(svc)).update?.version).toBe("0.7.1");
  });

  it("tells the Dashboard as the status changes", async () => {
    const svc = await machine("0.6.0", await releases("0.7.0"));
    const types = await eventsDuring(svc, () => check(svc));
    expect(types.filter((t) => t === "updates.changed")).toHaveLength(2);
  });

  it("keeps the channel in this Machine's configuration, Stable by default", async () => {
    const svc = await machine("0.6.0", await releases());
    expect((await svc.get("/config")).config.updates).toEqual({ channel: "stable", mode: "automatic" });
    await setChannel(svc, "beta");
    expect((await svc.get("/config")).config.updates).toEqual({ channel: "beta", mode: "automatic" });
    expect((await svc.get<UpdatesView>("/updates")).channel).toBe("beta");
    expect((await svc.call("PUT", "/updates/settings", { channel: "nightly" })).status).toBe(400);
    expect((await svc.call("PUT", "/updates/settings", {})).status).toBe(400);
  });
});

describe("refusing a release that is not Attache's", () => {
  it("never offers a release whose manifest is signed with another key or has no signature", async () => {
    const server = await releases("0.6.1");
    server.publish("0.7.0", signedRelease({ version: "0.7.0", key: testReleaseKeys() }));
    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }), { without: [signatureFileName("0.7.1")] });
    const svc = await machine("0.6.0", server);
    expect((await check(svc)).update?.version).toBe("0.6.1");
  });

  it("reports the refusal when every newer release is refused, rather than saying the Machine is up to date", async () => {
    const server = await releases("0.6.0");
    server.publish("0.7.0", signedRelease({ version: "0.7.0", key: testReleaseKeys() }));
    const svc = await machine("0.6.0", server);
    const view = await check(svc);
    expect(view.status).toBe("check_failed");
    expect(view.update).toBeNull();
    expect(view.reason).toContain(`${manifestFileName("0.7.0")} is not signed with Attache's key`);
  });

  it("refuses a release that carries no manifest for the version its tag names", async () => {
    const server = await releases("0.6.0");
    server.publish("0.9.0", signedRelease({ version: "0.7.0", key }), { tag: "v0.9.0" });
    const svc = await machine("0.6.0", server);
    const view = await check(svc);
    expect(view.status).toBe("check_failed");
    expect(view.reason).toContain(`${manifestFileName("0.9.0")} is missing from Attache 0.9.0's release`);
  });
});

describe("a check that fails", () => {
  it("says the network could not be reached, and never looks up to date", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server);
    await server.close();
    const view = await check(svc);
    expect(view.status).toBe("check_failed");
    expect(view.reason).toMatch(/^Could not reach 127\.0\.0\.1:\d+ to look for an Update\./);
    expect(view.lastCheckedAt).not.toBeNull();
  });

  it("says what the release list answered when it fails", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server);
    server.failWith(404);
    const view = await check(svc);
    expect(view).toMatchObject({ status: "check_failed", update: null });
    expect(view.reason).toMatch(/answered HTTP 404/);
  });

  it("keeps a release found earlier when a later check fails", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server);
    await check(svc);
    server.failWith(404);
    expect(await check(svc)).toMatchObject({ status: "check_failed", update: { version: "0.7.0" } });
  });
});

describe("a copy that does not update itself", () => {
  it("shows Updates as unavailable on a source checkout, and makes no request", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server, { releaseInstall: false });
    const view = await check(svc);
    expect(view).toMatchObject({ status: "unavailable", update: null, lastCheckedAt: null });
    expect(view.reason).toContain("source checkout");
    expect(server.requests).toEqual([]);
  });

  it("shows Updates as unavailable in a build without a release key", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server);
    delete process.env.ATTACHE_RELEASE_PUBLIC_KEY;
    try {
      const view = await check(svc);
      expect(view.status).toBe("unavailable");
      expect(view.reason).toContain("holds no release key");
      expect(server.requests).toEqual([]);
    } finally {
      process.env.ATTACHE_RELEASE_PUBLIC_KEY = key.publicKey;
    }
  });
});
