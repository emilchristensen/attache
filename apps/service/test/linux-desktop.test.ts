/**
 * The Linux secret store and desktop notifications, driven through the
 * `attache` executable as if on Linux. libsecret's `secret-tool` and
 * libnotify's `notify-send` are replaced by recording stand-ins, so this runs
 * on any operating system.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import type { FixtureServer } from "./fixtures/fixture-server.ts";
import { connectGithub as connect, githubAskingForReviews, attacheCli, newStateDir, runningChildren, serveChild as serve, syncGithub, type ChildService, type ReviewRequest } from "./fixtures/attache-child.ts";

// Each test starts the service from source, sometimes twice, which is slow under load.
const SLOW = 90_000;
const FAKE_SECRET_TOOL = join(import.meta.dirname, "fixtures/fake-secret-tool.mjs");
const FAKE_NOTIFY_SEND = join(import.meta.dirname, "fixtures/fake-notify-send.mjs");
const SECRET = "ghp_LinuxKeyringSecret0123456789abcdefXYZ";

interface Desktop {
  /** Folder of the stand-in Secret Service: items.json and calls.jsonl. */
  keyring: string;
  notifyLog: string;
  env: Record<string, string | undefined>;
}

function linuxDesktop(env: Record<string, string | undefined> = {}): Desktop {
  const keyring = tempDir("attache-keyring-");
  const notifyLog = join(tempDir("attache-notify-"), "notifications.jsonl");
  return {
    keyring,
    notifyLog,
    env: {
      ATTACHE_TEST_FAKE_PLATFORM: "linux",
      ATTACHE_CREDENTIAL_STORE: undefined,
      ATTACHE_NO_NOTIFY: undefined,
      ATTACHE_TEST_ENDPOINTS: "1",
      ATTACHE_SECRET_TOOL_BIN: FAKE_SECRET_TOOL,
      ATTACHE_NOTIFY_SEND_BIN: FAKE_NOTIFY_SEND,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      FAKE_SECRET_SERVICE_DIR: keyring,
      FAKE_NOTIFY_LOG: notifyLog,
      HOME: tempDir("attache-linux-home-"),
      ATTACHE_INSTANCE: "linux-test",
      ...env,
    },
  };
}

const fixtures: FixtureServer[] = [];
afterEach(() => {
  for (const c of runningChildren.splice(0)) c.kill("SIGKILL");
});
afterAll(async () => {
  for (const fx of fixtures) await fx.close();
});

async function github(prs: () => ReviewRequest[]) {
  const fx = await githubAskingForReviews(SECRET, prs);
  fixtures.push(fx);
  return fx;
}

const keyringItems = (d: Desktop) => (existsSync(join(d.keyring, "items.json")) ? JSON.parse(readFileSync(join(d.keyring, "items.json"), "utf8")) : []);
const toolCalls = (d: Desktop) => (existsSync(join(d.keyring, "calls.jsonl")) ? readFileSync(join(d.keyring, "calls.jsonl"), "utf8") : "");
const notifications = (d: Desktop): string[][] => (existsSync(d.notifyLog) ? readFileSync(d.notifyLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const connectGithub = (svc: ChildService, fx: FixtureServer) => connect(svc, fx, SECRET);

describe("Linux secret store", () => {
  it(
    "keeps secrets in the Secret Service when one is reachable, never in process arguments, logs or files",
    async () => {
      const desktop = linuxDesktop();
      const fx = await github(() => []);
      const stateDir = newStateDir();
      let svc = await serve(stateDir, desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status).toMatchObject({ credentialStore: "secret-service", credentialStoreNote: null });

      const configured = await connectGithub(svc, fx);
      expect(JSON.stringify(configured)).not.toContain(SECRET);
      expect(keyringItems(desktop)).toEqual([{ label: "Attache: conn:github:token", attributes: { service: "dev.attache.linux-test", account: "conn:github:token" }, secret: SECRET }]);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);

      // After a restart the token is read back from the Secret Service.
      await svc.stop();
      svc = await serve(stateDir, desktop.env);
      expect(await svc.api("GET", "/status")).toMatchObject({ credentialStore: "secret-service", credentialStoreNote: null });
      expect((await svc.api("POST", "/connections/github/test")).test).toMatchObject({ ok: true });

      expect(toolCalls(desktop)).not.toBe("");
      expect(toolCalls(desktop)).not.toContain(SECRET);
      expect(svc.log()).not.toBe("");
      expect(svc.log()).not.toContain(SECRET);

      // What the uninstaller runs: every secret this install stored is removed from the Secret Service.
      await svc.stop();
      const cleared = attacheCli(["credentials", "clear", "--state-dir", stateDir], desktop.env);
      expect(cleared.stderr).toBe("");
      expect(JSON.parse(cleared.stdout)).toEqual({ store: "secret-service", removed: 1 });
      expect(keyringItems(desktop)).toEqual([]);
    },
    SLOW,
  );

  it("removes a reachability check item a stopped check left behind when credentials are cleared", () => {
    const desktop = linuxDesktop();
    // A check stopped between writing its throwaway item and removing it, as a slow keyring can make it.
    const probe = { label: "Attache: reachability check", attributes: { service: "dev.attache.linux-test", account: "attache-reachability-check" }, secret: "0123abcd" };
    writeFileSync(join(desktop.keyring, "items.json"), JSON.stringify([probe]));
    const cleared = attacheCli(["credentials", "clear", "--state-dir", newStateDir()], desktop.env);
    expect(cleared.stderr).toBe("");
    expect(JSON.parse(cleared.stdout)).toEqual({ store: "secret-service", removed: 0 });
    expect(keyringItems(desktop)).toEqual([]);
  });

  it(
    "falls back to the private file without a Secret Service and says so",
    async () => {
      const desktop = linuxDesktop({ FAKE_SECRET_SERVICE_DOWN: "1" });
      const fx = await github(() => []);
      const stateDir = newStateDir();
      const svc = await serve(stateDir, desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("file");
      expect(status.credentialStoreNote).toBe("No Secret Service is reachable (secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY), so secrets are kept in a file only you can read.");

      await connectGithub(svc, fx);
      expect(JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"))).toEqual({ "conn:github:token": SECRET });
      expect(svc.log()).not.toContain(SECRET);
    },
    SLOW,
  );

  it(
    "says the secret tool is missing when libsecret is not installed",
    async () => {
      const desktop = linuxDesktop({ ATTACHE_SECRET_TOOL_BIN: "/nonexistent/secret-tool" });
      const svc = await serve(newStateDir(), desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("file");
      expect(status.credentialStoreNote).toBe("No Secret Service is reachable (secret-tool is not installed; it comes with libsecret), so secrets are kept in a file only you can read.");
    },
    SLOW,
  );

  it(
    "uses the private file when the Secret Service answers but cannot store anything",
    async () => {
      const desktop = linuxDesktop({ FAKE_SECRET_SERVICE_NO_COLLECTION: "1" });
      const fx = await github(() => []);
      const stateDir = newStateDir();
      const svc = await serve(stateDir, desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("file");
      expect(status.credentialStoreNote).toBe("No Secret Service is reachable (secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”), so secrets are kept in a file only you can read.");
      await connectGithub(svc, fx);
      expect((await svc.api("POST", "/connections/github/test")).test.ok).toBe(true);
    },
    SLOW,
  );

  it(
    "moves secrets from the private file into the Secret Service once one is reachable",
    async () => {
      const fx = await github(() => []);
      const stateDir = newStateDir();
      const down = linuxDesktop({ FAKE_SECRET_SERVICE_DOWN: "1" });
      let svc = await serve(stateDir, down.env);
      await connectGithub(svc, fx);
      await svc.stop();

      const up = { ...down, env: { ...down.env, FAKE_SECRET_SERVICE_DOWN: undefined } };
      svc = await serve(stateDir, up.env);
      expect(await svc.api("GET", "/status")).toMatchObject({ credentialStore: "secret-service", credentialStoreNote: null });
      expect((await svc.api("POST", "/connections/github/test")).test).toMatchObject({ ok: true });
      expect(keyringItems(up).map((i: { secret: string }) => i.secret)).toEqual([SECRET]);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);
      expect(toolCalls(up)).not.toContain(SECRET);
    },
    SLOW,
  );
});

describe("Linux desktop notifications", () => {
  const hhmm = (offsetMinutes: number) => {
    const d = new Date(Date.now() + offsetMinutes * 60_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  it(
    "shows an urgent inbox item through the desktop's notification service, except in quiet hours",
    async () => {
      const desktop = linuxDesktop();
      const prs: ReviewRequest[] = [{ number: 7, title: "Ship the <b>keyring</b> & notifications", author: "<ada>" }];
      const fx = await github(() => prs);
      const svc = await serve(newStateDir(), desktop.env);
      await connectGithub(svc, fx);
      await svc.api("PATCH", "/config", { notifications: { desktop: true } });

      expect(await syncGithub(svc)).toBe("succeeded");
      expect(notifications(desktop)).toEqual([["--app-name=Attache", "--", "Review a/b#7: Ship the <b>keyring</b> & notifications", "&lt;ada&gt; requested your review 10 days ago."]]);

      await svc.api("PATCH", "/config", { notifications: { quietHours: { start: hhmm(-60), end: hhmm(60) } } });
      prs.push({ number: 8, title: "Quiet please" });
      expect(await syncGithub(svc)).toBe("succeeded");
      expect((await svc.api("GET", "/attention")).items.map((i: { title: string }) => i.title)).toContain("Review a/b#8: Quiet please");
      expect(notifications(desktop)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "runs without notify-send and logs that notifications are off",
    async () => {
      const desktop = linuxDesktop({ ATTACHE_NOTIFY_SEND_BIN: "/nonexistent/notify-send" });
      const svc = await serve(newStateDir(), desktop.env);
      expect((await svc.api("GET", "/status")).version).toBeTruthy();
      await expect.poll(() => svc.log()).toContain("desktop notifications are off");
      expect(svc.log()).toContain("notify-send is not installed");
    },
    SLOW,
  );

  it(
    "runs without a desktop session bus and logs that notifications are off",
    async () => {
      const desktop = linuxDesktop({ DBUS_SESSION_BUS_ADDRESS: undefined, XDG_RUNTIME_DIR: tempDir("attache-runtime-") });
      const svc = await serve(newStateDir(), desktop.env);
      await expect.poll(() => svc.log()).toContain("desktop notifications are off");
      expect(svc.log()).toContain("no desktop session bus");
    },
    SLOW,
  );

  it(
    "logs that notifications are off when the notification service stops answering, and on again when it returns",
    async () => {
      const desktop = linuxDesktop();
      const prs: ReviewRequest[] = [{ number: 9, title: "Nobody is listening" }];
      const fx = await github(() => prs);
      const svc = await serve(newStateDir(), desktop.env);
      await connectGithub(svc, fx);
      await svc.api("PATCH", "/config", { notifications: { desktop: true } });
      writeFileSync(`${desktop.notifyLog}.down`, "");
      expect(await syncGithub(svc)).toBe("succeeded");
      expect(svc.log()).toContain("desktop notifications are off");
      expect(svc.log()).toContain("org.freedesktop.Notifications was not provided");

      rmSync(`${desktop.notifyLog}.down`);
      prs.push({ number: 10, title: "Back again" });
      expect(await syncGithub(svc)).toBe("succeeded");
      expect(notifications(desktop).map((n) => n[2])).toEqual(["Review a/b#10: Back again"]);
      expect(svc.log()).toContain("desktop notifications are on again");
    },
    SLOW,
  );
});
