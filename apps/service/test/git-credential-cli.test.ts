import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import { githubRepoOf } from "../src/replication/github.ts";

// Each test starts the CLI from source, several times: slow when the Machine is busy.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../src/main.ts");
const TOKEN = "ghp_credentialhelpertoken0123456789abcd";

/** A state folder whose file secret store holds the GitHub connection's token. */
function stateWithToken(): string {
  const stateDir = tempDir("attache-cred-state-");
  writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({ "conn:gh-1:token": TOKEN }), { mode: 0o600 });
  return stateDir;
}

/** Run the helper the way git does: the action last, the request on stdin. */
function helper(stateDir: string, action: string, request: string) {
  const r = spawnSync(process.execPath, [MAIN, "git-credential", "--connection", "gh-1", action], {
    env: { ...process.env, ATTACHE_STATE_DIR: stateDir, ATTACHE_CREDENTIAL_STORE: "file" },
    input: request,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("the credential helper git runs for Replication", () => {
  it("answers a request for GitHub with the GitHub connection's token from the secret store", () => {
    const r = helper(stateWithToken(), "get", "protocol=https\nhost=github.com\npath=owner/brain.git\n\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(r.stderr).toBe("");
  });

  it("never stores or erases the token when git asks it to", () => {
    const stateDir = stateWithToken();
    for (const action of ["erase", "store"]) {
      const r = helper(stateDir, action, `protocol=https\nhost=github.com\nusername=x-access-token\npassword=something-else\n\n`);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"))).toEqual({ "conn:gh-1:token": TOKEN });
  });

  it("answers nothing when the connection has no token", () => {
    const r = helper(tempDir("attache-cred-empty-"), "get", "protocol=https\nhost=github.com\n\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("which remotes are GitHub repositories", () => {
  it("recognises GitHub over https and ssh, and nothing else", () => {
    expect(githubRepoOf("https://github.com/owner/attache-brain.git")).toEqual({ owner: "owner", name: "attache-brain", transport: "https" });
    expect(githubRepoOf("https://github.com/owner/attache-brain")).toEqual({ owner: "owner", name: "attache-brain", transport: "https" });
    expect(githubRepoOf("git@github.com:owner/attache-brain.git")).toEqual({ owner: "owner", name: "attache-brain", transport: "ssh" });
    expect(githubRepoOf("ssh://git@github.com/owner/attache.brain.git")).toEqual({ owner: "owner", name: "attache.brain", transport: "ssh" });
    expect(githubRepoOf("https://github.com.evil.example/owner/brain.git")).toBeNull();
    expect(githubRepoOf("https://gitlab.com/owner/brain.git")).toBeNull();
    expect(githubRepoOf("/srv/brain.git")).toBeNull();
  });
});
