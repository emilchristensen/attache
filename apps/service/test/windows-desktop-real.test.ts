/**
 * The Windows secret store and notifications against the real Windows:
 * Credential Manager and Windows notifications, through Windows PowerShell.
 * Runs only on Windows with JARVIS_TEST_REAL_DESKTOP=1 (CI's Windows job does
 * this), because it shows notifications and writes to the user's Credential
 * Manager; the stand-in tests in windows-desktop.test.ts cover every other run.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import type { FixtureServer } from "./fixtures/fixture-server.ts";
import { connectGithub, githubAskingForReviews, jarvisCli, newStateDir, runningChildren, serveChild, syncGithub } from "./fixtures/jarvis-child.ts";
import { createSecretStore } from "../src/platform/secret-store/index.ts";

const REAL = process.platform === "win32" && process.env.JARVIS_TEST_REAL_DESKTOP === "1";
// Each test starts the service from source, sometimes twice, and Windows PowerShell for every secret, which is slow.
const SLOW = 180_000;
const SECRET = "ghp_RealVaultSecret0123456789abcdefXYZ";
const RECORDING_POWERSHELL = join(import.meta.dirname, "fixtures/recording-powershell.mjs");

const fixtures: FixtureServer[] = [];
afterEach(() => {
  for (const c of runningChildren.splice(0)) c.kill("SIGKILL");
});
afterAll(async () => {
  for (const fx of fixtures) await fx.close();
});

const instanceName = () => `real-${Math.random().toString(36).slice(2, 8)}`;

/** Windows PowerShell started through a recorder of its process arguments. */
function recordingPowerShell(): { env: Record<string, string>; args: () => string } {
  const log = join(tempDir("jarvis-real-powershell-"), "calls.jsonl");
  return { env: { JARVIS_POWERSHELL_BIN: RECORDING_POWERSHELL, RECORD_POWERSHELL_LOG: log }, args: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

function desktopEnv(instance: string, extra: Record<string, string | undefined> = {}) {
  return { JARVIS_CREDENTIAL_STORE: undefined, JARVIS_NO_NOTIFY: undefined, JARVIS_TEST_ENDPOINTS: "1", JARVIS_INSTANCE: instance, ...extra };
}

/** The generic credentials Credential Manager lists for an install, by target, as `cmdkey` shows them. */
function storedTargets(instance: string): string[] {
  const out = spawnSync("cmdkey", ["/list"], { encoding: "utf8" }).stdout;
  const prefix = `dev.jarvis.${instance}/`;
  return [...out.matchAll(/target=(\S+)/g)]
    .map((m) => m[1]!)
    .filter((t) => t.startsWith(prefix))
    .sort();
}

function powershell(script: string): string {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout;
}

describe.runIf(REAL)("on a real Windows desktop", () => {
  it(
    "keeps secrets in Credential Manager and never passes them as process arguments",
    async () => {
      const instance = instanceName();
      const ps = recordingPowerShell();
      const env = desktopEnv(instance, ps.env);
      const fx = await githubAskingForReviews(SECRET, () => []);
      fixtures.push(fx);
      const stateDir = newStateDir();
      let svc = await serveChild(stateDir, env);
      const status = await svc.api("GET", "/status");
      expect(status.credentialStoreNote).toBeNull();
      expect(status.credentialStore).toBe("credential-manager");

      await connectGithub(svc, fx, SECRET);
      expect(storedTargets(instance)).toEqual([`dev.jarvis.${instance}/conn:github:token`]);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);

      await svc.stop();
      svc = await serveChild(stateDir, env);
      expect((await svc.api("POST", "/connections/github/test")).test.ok).toBe(true);
      expect(ps.args()).toContain("-EncodedCommand");
      expect(ps.args()).not.toContain(SECRET);
      expect(ps.args()).not.toContain(Buffer.from(SECRET).toString("base64"));
      expect(svc.log()).not.toContain(SECRET);

      await svc.stop();
      expect(JSON.parse(jarvisCli(["credentials", "clear", "--state-dir", stateDir], env).stdout)).toEqual({ store: "credential-manager", removed: 1 });
      expect(storedTargets(instance)).toEqual([]);
    },
    SLOW,
  );

  it(
    "stores values longer than one credential holds, and text outside ASCII, unchanged",
    async () => {
      const instance = instanceName();
      const stateDir = newStateDir();
      const store = createSecretStore({ os: "windows", stateDir, secretsFile: join(stateDir, "secrets.json"), instance, env: desktopEnv(instance) });
      expect(store.kind).toBe("credential-manager");
      const long = `eyJ${"x".repeat(6000)}-ÆØÅ-東京-🔑`;
      await store.set("oauth:access", long);
      expect(await store.get("oauth:access")).toBe(long);
      expect(storedTargets(instance)).toEqual([`dev.jarvis.${instance}/oauth:access`, `dev.jarvis.${instance}/oauth:access#2`, `dev.jarvis.${instance}/oauth:access#3`]);

      // A shorter value leaves no stale parts behind.
      await store.set("oauth:access", "short");
      expect(await store.get("oauth:access")).toBe("short");
      expect(storedTargets(instance)).toEqual([`dev.jarvis.${instance}/oauth:access`]);

      await store.delete("oauth:access");
      expect(await store.get("oauth:access")).toBeNull();
      expect(storedTargets(instance)).toEqual([]);
    },
    SLOW,
  );

  it(
    "shows an urgent inbox item as a Windows notification from Jarvis",
    async () => {
      const instance = instanceName();
      const app = `dev.jarvis.${instance}`;
      const env = desktopEnv(instance, { JARVIS_CREDENTIAL_STORE: "file" });
      const fx = await githubAskingForReviews(SECRET, () => [{ number: 7, title: "Ship Windows notifications" }]);
      fixtures.push(fx);
      const svc = await serveChild(newStateDir(), env);
      try {
        await svc.api("PATCH", "/config", { notifications: { desktop: true } });
        await connectGithub(svc, fx, SECRET);
        expect(await syncGithub(svc)).toBe("succeeded");
        expect(svc.log()).not.toContain("desktop notifications are off");

        // Windows keeps a shown notification in the Action Center history of its sender.
        const history = powershell(
          `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('${app}') | ForEach-Object { $_.Content.GetXml() }`,
        );
        expect(history).toContain("<text>Review a/b#7: Ship Windows notifications</text>");
        expect(history).toContain("<text>ada requested your review 10 days ago.</text>");
        expect(powershell(`(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Classes\\AppUserModelId\\${app}').DisplayName`).trim()).toBe(`Jarvis (${instance})`);
      } finally {
        await svc.stop();
        powershell(`$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; [Windows.UI.Notifications.ToastNotificationManager]::History.Clear('${app}')`);
      }

      // What the uninstaller runs: the sender registration is removed.
      const forgot = jarvisCli(["notifications", "forget"], env);
      expect(forgot.stderr).toBe("");
      expect(powershell(`Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\AppUserModelId\\${app}'`).trim()).toBe("False");
    },
    SLOW,
  );
});
