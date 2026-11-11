/**
 * The Linux secret store and desktop notifications against a real desktop
 * session: GNOME Keyring as the Secret Service and dunst as the notification
 * service. Runs only with JARVIS_TEST_REAL_DESKTOP=1 inside
 * `scripts/linux-desktop-session.sh` (CI's Linux job does this); the
 * stand-in tests in linux-desktop.test.ts cover every other run.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import type { FixtureServer } from "./fixtures/fixture-server.ts";
import { connectGithub, githubAskingForReviews, jarvisCli, newStateDir, runningChildren, serveChild, syncGithub } from "./fixtures/jarvis-child.ts";

const REAL = process.platform === "linux" && process.env.JARVIS_TEST_REAL_DESKTOP === "1";
// Each test starts the service from source, sometimes twice, which is slow under load.
const SLOW = 90_000;
const SECRET = "ghp_RealKeyringSecret0123456789abcdefXYZ";

const fixtures: FixtureServer[] = [];
afterEach(() => {
  for (const c of runningChildren.splice(0)) c.kill("SIGKILL");
});
afterAll(async () => {
  for (const fx of fixtures) await fx.close();
});

const which = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();

/** A `secret-tool` that appends its arguments to a log, then runs the real one. */
function recordingSecretTool(): { path: string; calls: () => string } {
  const dir = tempDir("jarvis-real-keyring-");
  const path = join(dir, "secret-tool");
  const log = join(dir, "calls.log");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${which("secret-tool")}' "$@"\n`, { mode: 0o755 });
  return { path, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

function desktopEnv(extra: Record<string, string | undefined> = {}) {
  return {
    JARVIS_CREDENTIAL_STORE: undefined,
    JARVIS_NO_NOTIFY: undefined,
    JARVIS_TEST_ENDPOINTS: "1",
    JARVIS_INSTANCE: `real-${Math.random().toString(36).slice(2, 8)}`,
    HOME: tempDir("jarvis-real-home-"),
    ...extra,
  };
}

describe.runIf(REAL)("on a real Linux desktop session", () => {
  it(
    "keeps secrets in the desktop keyring and never passes them as process arguments",
    async () => {
      const tool = recordingSecretTool();
      const env = desktopEnv({ JARVIS_SECRET_TOOL_BIN: tool.path });
      const fx = await githubAskingForReviews(SECRET, () => []);
      fixtures.push(fx);
      const stateDir = newStateDir();
      let svc = await serveChild(stateDir, env);
      expect((await svc.api("GET", "/status")).credentialStore).toBe("secret-service");

      await connectGithub(svc, fx, SECRET);
      const lookup = () => spawnSync(which("secret-tool"), ["lookup", "service", `dev.jarvis.${env.JARVIS_INSTANCE}`, "account", "conn:github:token"], { encoding: "utf8" });
      expect(lookup().stdout).toBe(SECRET);
      expect(existsSync(join(stateDir, "secrets.json"))).toBe(false);

      await svc.stop();
      svc = await serveChild(stateDir, env);
      expect((await svc.api("POST", "/connections/github/test")).test.ok).toBe(true);
      expect(tool.calls()).toContain("lookup");
      expect(tool.calls()).not.toContain(SECRET);
      expect(svc.log()).not.toContain(SECRET);

      await svc.stop();
      expect(JSON.parse(jarvisCli(["credentials", "clear", "--state-dir", stateDir], env).stdout)).toEqual({ store: "secret-service", removed: 1 });
      expect(lookup().status).toBe(1);
    },
    SLOW,
  );

  it(
    "shows an urgent inbox item as a desktop notification",
    async () => {
      const fx = await githubAskingForReviews(SECRET, () => [{ number: 7, title: "Ship Linux notifications" }]);
      fixtures.push(fx);
      const svc = await serveChild(newStateDir(), desktopEnv());
      await svc.api("PATCH", "/config", { notifications: { desktop: true } });
      await connectGithub(svc, fx, SECRET);
      expect(await syncGithub(svc)).toBe("succeeded");

      // dunst keeps a notification in its history once it is closed; ask it over the session bus.
      const dunst = (method: string) => spawnSync("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.Notifications", "/org/freedesktop/Notifications", `org.dunstproject.cmd0.${method}`], { encoding: "utf8" }).stdout;
      dunst("NotificationCloseAll");
      const history = dunst("NotificationListHistory");
      expect(history).toContain('string "Review a/b#7: Ship Linux notifications"');
      expect(history).toContain('string "ada requested your review 10 days ago."');
      expect(history).toContain('string "Jarvis"');
      expect(svc.log()).not.toContain("desktop notifications are off");
    },
    SLOW,
  );
});
