/**
 * The credentials file and the CLI token stay private to the owner even in a
 * state folder that others may read, such as `D:\Jarvis` on Windows, whose
 * access-control list would otherwise pass read access on to new files.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accessOutsideOwner, tempDir } from "./helpers.ts";
import type { FixtureServer } from "./fixtures/fixture-server.ts";
import { connectGithub, githubAskingForReviews, jarvisCli, runningChildren, serveChild } from "./fixtures/jarvis-child.ts";

// Starts the service from source, which is slow under load.
const SLOW = 90_000;
const SECRET = "ghp_PrivateFileSecret0123456789abcdefXYZ";
/** BUILTIN\Users: every local account. */
const USERS_SID = "S-1-5-32-545";

/** A folder whose new files everyone on the computer can read. */
function folderOthersCanRead(): string {
  const dir = join(tempDir("jarvis-shared-"), "state");
  mkdirSync(dir);
  if (process.platform === "win32") execFileSync("icacls", [dir, "/grant", `*${USERS_SID}:(OI)(CI)(RX)`], { encoding: "utf8" });
  else chmodSync(dir, 0o755);
  return dir;
}

const fixtures: FixtureServer[] = [];
afterEach(() => {
  for (const c of runningChildren.splice(0)) c.kill("SIGKILL");
});
afterAll(async () => {
  for (const fx of fixtures) await fx.close();
});

describe("private files in a state folder others can read", () => {
  it(
    "keeps the credentials file and the CLI token readable by the owner alone",
    async () => {
      const stateDir = folderOthersCanRead();
      // The folder does pass access on: a file written there without care is readable by others.
      writeFileSync(join(stateDir, "plain.txt"), "not private");
      expect(accessOutsideOwner(join(stateDir, "plain.txt"))).not.toEqual([]);

      const env = { JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", JARVIS_TEST_ENDPOINTS: "1", JARVIS_INSTANCE: "private-files" };
      const fx = await githubAskingForReviews(SECRET, () => []);
      fixtures.push(fx);
      const svc = await serveChild(stateDir, env);
      await connectGithub(svc, fx, SECRET);
      const secretsFile = join(stateDir, "secrets.json");
      expect(JSON.parse(readFileSync(secretsFile, "utf8"))).toEqual({ "conn:github:token": SECRET });
      expect(accessOutsideOwner(secretsFile)).toEqual([]);

      const audit = jarvisCli(["audit", "--json", "--state-dir", stateDir], env);
      expect(audit.stderr).toBe("");
      expect(audit.status).toBe(0);
      expect(accessOutsideOwner(join(stateDir, "cli-token"))).toEqual([]);
    },
    SLOW,
  );
});
