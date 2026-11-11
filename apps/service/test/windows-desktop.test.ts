/**
 * The Windows secret store and desktop notifications, driven through the
 * `jarvis` executable as if on Windows. Windows PowerShell, which Jarvis uses
 * to reach Credential Manager and Windows notifications, is replaced by a
 * recording stand-in, so this runs on any operating system;
 * windows-desktop-real.test.ts covers the real thing on Windows.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import type { FixtureServer } from "./fixtures/fixture-server.ts";
import { connectGithub as connect, githubAskingForReviews, jarvisCli, newStateDir, runningChildren, serveChild as serve, syncGithub, type ChildService, type ReviewRequest } from "./fixtures/jarvis-child.ts";

// Each test starts the service from source, sometimes twice, which is slow under load.
const SLOW = 90_000;
const FAKE_POWERSHELL = join(import.meta.dirname, "fixtures/fake-powershell.mjs");
const FAKE_ICACLS = join(import.meta.dirname, "fixtures/fake-icacls.mjs");
const FAKE_WHOAMI = join(import.meta.dirname, "fixtures/fake-whoami.mjs");
const OWNER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const SECRET = "ghp_WindowsVaultSecret0123456789abcdefXYZ";

interface Desktop {
  /** Folder of the stand-ins: credentials.json, toasts.jsonl, calls.jsonl and acl.jsonl. */
  dir: string;
  env: Record<string, string | undefined>;
}

function windowsDesktop(env: Record<string, string | undefined> = {}): Desktop {
  const dir = tempDir("jarvis-windows-");
  return {
    dir,
    env: {
      JARVIS_TEST_FAKE_PLATFORM: "win32",
      JARVIS_CREDENTIAL_STORE: undefined,
      JARVIS_NO_NOTIFY: undefined,
      JARVIS_TEST_ENDPOINTS: "1",
      JARVIS_POWERSHELL_BIN: FAKE_POWERSHELL,
      JARVIS_ICACLS_BIN: FAKE_ICACLS,
      JARVIS_WHOAMI_BIN: FAKE_WHOAMI,
      FAKE_WINDOWS_DIR: dir,
      USERPROFILE: tempDir("jarvis-windows-home-"),
      JARVIS_INSTANCE: "windows-test",
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

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const readLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const vault = (d: Desktop) => readJson(join(d.dir, "credentials.json"));
const calls = (d: Desktop) => (existsSync(join(d.dir, "calls.jsonl")) ? readFileSync(join(d.dir, "calls.jsonl"), "utf8") : "");
const toasts = (d: Desktop) => readLines(join(d.dir, "toasts.jsonl"));
/** The files icacls was asked to make private, and whether each was still empty then. */
const madePrivate = (d: Desktop) => readLines(join(d.dir, "acl.jsonl")).map((c: { args: string[]; emptyFile: boolean }) => ({ ...c, args: [c.args[0]!.split(/[\\/]/).at(-1)!.replace(/\.[^.]+\.tmp$/, ""), ...c.args.slice(1)] }));
const connectGithub = (svc: ChildService, fx: FixtureServer) => connect(svc, fx, SECRET);

describe("Windows secret store", () => {
  it(
    "keeps secrets in Credential Manager, never in process arguments, logs or files",
    async () => {
      const desktop = windowsDesktop();
      const fx = await github(() => []);
      const stateDir = newStateDir();
      let svc = await serve(stateDir, desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("credential-manager");
      expect(status.credentialStoreNote).toBeNull();

      const configured = await connectGithub(svc, fx);
      expect(JSON.stringify(configured)).not.toContain(SECRET);
      expect(vault(desktop)).toEqual([{ target: "dev.jarvis.windows-test/conn:github:token", user: "conn:github:token", secret: SECRET }]);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);

      // After a restart the token is read back from Credential Manager.
      await svc.stop();
      svc = await serve(stateDir, desktop.env);
      expect((await svc.api("POST", "/connections/github/test")).test.ok).toBe(true);

      expect(calls(desktop)).not.toBe("");
      expect(calls(desktop)).not.toContain(SECRET);
      expect(calls(desktop)).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(svc.log()).not.toBe("");
      expect(svc.log()).not.toContain(SECRET);

      // What the uninstaller runs: every secret this install stored is removed from Credential Manager.
      await svc.stop();
      const cleared = jarvisCli(["credentials", "clear", "--state-dir", stateDir], desktop.env);
      expect(cleared.stderr).toBe("");
      expect(JSON.parse(cleared.stdout)).toEqual({ store: "credential-manager", removed: 1 });
      expect(vault(desktop)).toEqual([]);
    },
    SLOW,
  );

  it(
    "falls back to a private file when Credential Manager is not available, and says so",
    async () => {
      const desktop = windowsDesktop({ FAKE_CREDENTIAL_MANAGER_DOWN: "1" });
      const fx = await github(() => []);
      const stateDir = newStateDir();
      const svc = await serve(stateDir, desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("file");
      expect(status.credentialStoreNote).toBe(
        "Windows Credential Manager is not available (A specified logon session does not exist. It may already have been terminated. (Windows error 1312)), so secrets are kept in a file only you can read.",
      );

      await connectGithub(svc, fx);
      expect(JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"))).toEqual({ "conn:github:token": SECRET });
      // Made private for the owner alone while still empty, whatever the state folder lets others do.
      expect(madePrivate(desktop)).toContainEqual({ args: [".secrets.json", "/inheritance:r", "/grant:r", `*${OWNER_SID}:(F)`], emptyFile: true });
      expect(svc.log()).not.toContain(SECRET);
    },
    SLOW,
  );

  it(
    "says Windows PowerShell is missing when it cannot be found",
    async () => {
      const desktop = windowsDesktop({ JARVIS_POWERSHELL_BIN: join(tempDir("jarvis-no-powershell-"), "powershell.exe") });
      const svc = await serve(newStateDir(), desktop.env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStore).toBe("file");
      expect(status.credentialStoreNote).toMatch(/^Windows Credential Manager is not available \(Windows PowerShell is missing \(.*powershell\.exe\)\), so secrets are kept in a file only you can read\.$/);
    },
    SLOW,
  );

  it(
    "moves secrets from the private file into Credential Manager once it is available",
    async () => {
      const fx = await github(() => []);
      const stateDir = newStateDir();
      const down = windowsDesktop({ FAKE_CREDENTIAL_MANAGER_DOWN: "1" });
      let svc = await serve(stateDir, down.env);
      await connectGithub(svc, fx);
      await svc.stop();

      const up = { ...down, env: { ...down.env, FAKE_CREDENTIAL_MANAGER_DOWN: undefined } };
      svc = await serve(stateDir, up.env);
      expect((await svc.api("GET", "/status")).credentialStore).toBe("credential-manager");
      expect((await svc.api("POST", "/connections/github/test")).test.ok).toBe(true);
      expect(vault(up).map((c: { secret: string }) => c.secret)).toEqual([SECRET]);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);
      expect(calls(up)).not.toContain(SECRET);
    },
    SLOW,
  );
});

describe("Windows notifications", () => {
  const hhmm = (offsetMinutes: number) => {
    const d = new Date(Date.now() + offsetMinutes * 60_000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  it(
    "shows an urgent inbox item as a Windows notification from Jarvis, except in quiet hours",
    async () => {
      const desktop = windowsDesktop();
      const prs: ReviewRequest[] = [{ number: 7, title: "Ship <toast> & “notifications”", author: "<ada>" }];
      const fx = await github(() => prs);
      const svc = await serve(newStateDir(), desktop.env);
      await connectGithub(svc, fx);
      await svc.api("PATCH", "/config", { notifications: { desktop: true } });

      expect(await syncGithub(svc)).toBe("succeeded");
      expect(toasts(desktop)).toEqual([{ app: "dev.jarvis.windows-test", name: "Jarvis (windows-test)", title: "Review a/b#7: Ship <toast> & “notifications”", body: "<ada> requested your review 10 days ago." }]);

      await svc.api("PATCH", "/config", { notifications: { quietHours: { start: hhmm(-60), end: hhmm(60) } } });
      prs.push({ number: 8, title: "Quiet please" });
      expect(await syncGithub(svc)).toBe("succeeded");
      expect((await svc.api("GET", "/attention")).items.map((i: { title: string }) => i.title)).toContain("Review a/b#8: Quiet please");
      expect(toasts(desktop)).toHaveLength(1);
      expect(svc.log()).not.toContain("desktop notifications are off");
    },
    SLOW,
  );

  it(
    "runs with notifications turned off in Windows and logs why",
    async () => {
      const desktop = windowsDesktop({ FAKE_TOAST_SETTING: "DisabledForUser" });
      const svc = await serve(newStateDir(), desktop.env);
      expect((await svc.api("GET", "/status")).version).toBeTruthy();
      // The start-up check runs a (fake) PowerShell, which can take seconds on a loaded machine; poll's default 1 s is too short.
      await expect.poll(() => svc.log(), { timeout: 30_000 }).toContain("desktop notifications are off");
      expect(svc.log()).toContain("notifications are turned off for this Windows user");
    },
    SLOW,
  );

  it(
    "logs that notifications are off when Windows stops showing them, and on again when it shows them",
    async () => {
      const desktop = windowsDesktop();
      const prs: ReviewRequest[] = [{ number: 9, title: "Nobody is listening" }];
      const fx = await github(() => prs);
      const svc = await serve(newStateDir(), desktop.env);
      await connectGithub(svc, fx);
      await svc.api("PATCH", "/config", { notifications: { desktop: true } });
      writeFileSync(join(desktop.dir, "toasts.down"), "");
      expect(await syncGithub(svc)).toBe("succeeded");
      expect(svc.log()).toContain("desktop notifications are off");
      expect(svc.log()).toContain("The notification platform is unavailable. (0x803E0105)");

      rmSync(join(desktop.dir, "toasts.down"));
      prs.push({ number: 10, title: "Back again" });
      expect(await syncGithub(svc)).toBe("succeeded");
      expect(toasts(desktop).map((t: { title: string }) => t.title)).toEqual(["Review a/b#10: Back again"]);
      expect(svc.log()).toContain("desktop notifications are on again");
    },
    SLOW,
  );

  it("forgets Jarvis as a notification sender when asked, as the uninstaller does", () => {
    const desktop = windowsDesktop();
    const r = jarvisCli(["notifications", "forget"], desktop.env);
    expect(r.stderr).toBe("");
    expect(toasts(desktop)).toEqual([{ forgot: "dev.jarvis.windows-test" }]);
  });
});
