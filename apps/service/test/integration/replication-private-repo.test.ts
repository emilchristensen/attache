import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startGitHubGitServer, type GitHubGitServer } from "../fixtures/github-git-server.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, testFolder, type TestService } from "./harness.ts";

// Each test drives git through the credential helper, which runs the CLI from source: slow under load.
vi.setConfig({ testTimeout: 90_000 });

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const CHECK = 60_000;
const AFTER_WRITE = 30_000;
const VISIBILITY_TTL = 5 * 60_000;
const TOKEN = "ghp_brainreplicationtoken0123456789abcd";
const NEW_TOKEN = "ghp_brainreplicationtokenrotated9876543";

let github: GitHubGitServer;
const running: TestService[] = [];

beforeAll(async () => {
  github = await startGitHubGitServer();
  // Git sends https://github.com/ to the stand-in, through git's own configuration in the environment.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${github.gitBase}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
});

afterAll(async () => {
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  await github.close();
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

type Machine = TestService & { clock: ManualClock };

let repoCount = 0;
function newRepo(visibility: "public" | "private" = "private"): { owner: string; name: string; full: string } {
  const name = `brain-${++repoCount}-${Math.random().toString(36).slice(2, 6)}`;
  github.createRepo("owner", name);
  github.setVisibility("owner", name, visibility);
  github.acceptTokens(TOKEN);
  return { owner: "owner", name, full: `owner/${name}` };
}

async function machine(opts: { github?: string | false; setup?: boolean } = {}): Promise<Machine> {
  const clock = new ManualClock();
  const svc = await startTestService({ clock, ...(opts.setup === false ? { setup: false } : {}) });
  running.push(svc);
  if (opts.github !== false) await connectGitHub(svc, opts.github ?? TOKEN);
  return Object.assign(svc, { clock });
}

const connectGitHub = (svc: TestService, token: string) => svc.post("/connections/github/configure", { method: "token", fields: { token, apiBaseUrl: github.apiBase } });

const saveNote = (m: TestService, title: string) => m.post("/memory/save", { items: [{ action: "create", type: "note", title, facts: [{ subject: "Fact", value: `${title} is replicated` }] }] });

const pushedFiles = (repo: { owner: string; name: string }) => github.git(repo.owner, repo.name, "ls-tree", "-r", "--name-only", "main");

/** The `user:password` pairs git sent for the repository; empty when it sent none. */
function basicCredentials(repo: { full: string }): Set<string> {
  return new Set(
    github.requests
      .filter((r) => r.url.startsWith(`/git/${repo.full}.git`))
      .map((r) => r.authorization)
      .filter((a): a is string => !!a?.startsWith("Basic "))
      .map((a) => Buffer.from(a.slice(6), "base64").toString("utf8")),
  );
}

async function inbox(m: TestService): Promise<Array<{ kind: string; title: string; summary: string; why: string }>> {
  return ((await m.get("/attention")).items as Array<{ kind: string; title: string; summary: string; why: string }>).filter((i) => i.kind.startsWith("replication_"));
}

function everyFileUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("Replication to a private GitHub repository", () => {
  it("refuses setup against a public repository, saying why", async () => {
    const repo = newRepo("public");
    const mac = await machine();
    const r = await mac.call("POST", "/replication/setup", { remote: repo.full });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("remote_refused");
    expect(r.body.error.message).toContain(`${repo.full} is public`);
    expect(r.body.error.message).toContain("private");
    expect((await mac.get("/replication")).status).toBe("off");
    expect(existsSync(join(mac.dataDir, ".git"))).toBe(false);
    expect(() => pushedFiles(repo)).toThrow();
  });

  it("refuses a remote whose privacy it cannot check", async () => {
    const mac = await machine();
    const r = await mac.call("POST", "/replication/setup", { remote: "https://gitlab.example.com/owner/brain.git" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("remote_refused");
    expect(r.body.error.message).toContain("only on GitHub");
  });

  it("asks for the GitHub connection before setting up over https", async () => {
    const repo = newRepo();
    const mac = await machine({ github: false });
    const r = await mac.call("POST", "/replication/setup", { remote: repo.full });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("remote_unauthorized");
    expect(r.body.error.message).toContain("GitHub is not connected");
    expect((await mac.get("/replication")).status).toBe("off");
  });

  it("pushes with the GitHub connection's token, which never reaches the address, the configuration or the logs", async () => {
    const repo = newRepo();
    const mac = await machine();
    const view = await mac.post("/replication/setup", { remote: repo.full });
    expect(view.status).toBe("up_to_date");
    expect(view.remote).toBe(`https://github.com/${repo.full}.git`);

    await saveNote(mac, "Quasar budget");
    await mac.clock.advance(AFTER_WRITE);
    expect(pushedFiles(repo)).toContain("memory/notes/quasar-budget.md");
    expect((await mac.get("/replication")).status).toBe("up_to_date");

    // Git authenticated with the token, which the credential helper read from the secret store.
    expect(basicCredentials(repo)).toEqual(new Set([`x-access-token:${TOKEN}`]));
    expect(github.requests.every((r) => !r.url.includes(TOKEN))).toBe(true);

    expect(readFileSync(join(mac.dataDir, ".git", "config"), "utf8")).toContain(`url = https://github.com/${repo.full}.git`);
    for (const file of [...everyFileUnder(join(mac.dataDir, ".git")), ...everyFileUnder(join(mac.stateDir, "logs"))]) {
      expect(readFileSync(file).includes(TOKEN), file).toBe(false);
    }
    expect(JSON.stringify(await mac.get("/replication"))).not.toContain(TOKEN);
  });

  it("blocks pushing when the repository turns public, raises an inbox item, and carries on once it is private again", async () => {
    const repo = newRepo();
    const mac = await machine();
    await mac.post("/replication/setup", { remote: repo.full });

    github.setVisibility(repo.owner, repo.name, "public");
    // GitHub is asked again once the last answer is a few minutes old.
    await mac.clock.advance(VISIBILITY_TTL);
    const blocked = await mac.get("/replication");
    expect(blocked.status).toBe("blocked");
    expect(blocked.cause).toContain(`${repo.full} is public`);

    await saveNote(mac, "Nebula contract");
    await mac.clock.advance(AFTER_WRITE);
    expect(pushedFiles(repo)).not.toContain("memory/notes/nebula-contract.md");
    expect((await mac.get("/replication")).status).toBe("blocked");
    // The save itself worked.
    expect(existsSync(join(mac.dataDir, "memory/notes/nebula-contract.md"))).toBe(true);

    const items = await inbox(mac);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Replication is blocked");
    expect(items[0]!.summary).toContain(`${repo.full} is public`);

    github.setVisibility(repo.owner, repo.name, "private");
    await mac.clock.advance(CHECK);
    expect((await mac.get("/replication")).status).toBe("up_to_date");
    expect(pushedFiles(repo)).toContain("memory/notes/nebula-contract.md");
    expect(await inbox(mac)).toEqual([]);
  });

  it("refuses to join a repository that is public", async () => {
    const repo = newRepo();
    const mac = await machine();
    await mac.post("/replication/setup", { remote: repo.full });
    github.setVisibility(repo.owner, repo.name, "public");

    const pc = await machine({ setup: false });
    const r = await pc.call("POST", "/replication/join", { remote: repo.full, path: pc.dataDir });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("remote_refused");
    expect(r.body.error.message).toContain("is public");
    expect(existsSync(pc.dataDir) && readdirSync(pc.dataDir).length > 0).toBe(false);
  });

  it("joins a private repository with the GitHub connection's token", async () => {
    const repo = newRepo();
    const mac = await machine();
    await saveNote(mac, "Comet roadmap");
    await mac.post("/replication/setup", { remote: repo.full });

    const pc = await machine({ setup: false });
    const view = await pc.post("/replication/join", { remote: repo.full, path: pc.dataDir });
    expect(view.status).toBe("up_to_date");
    expect(readFileSync(join(pc.dataDir, "memory/notes/comet-roadmap.md"), "utf8")).toContain("Comet roadmap is replicated");
    expect(readFileSync(join(pc.dataDir, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  it("sets the status to unauthorized when the repository rejects the token, and asks the owner to reconnect GitHub", async () => {
    const repo = newRepo();
    const mac = await machine();
    await mac.post("/replication/setup", { remote: repo.full });

    // The token is revoked: GitHub now accepts only a new one.
    github.acceptTokens(NEW_TOKEN);
    await saveNote(mac, "Pulsar hiring");
    await mac.clock.advance(AFTER_WRITE);
    const view = await mac.get("/replication");
    expect(view.status).toBe("unauthorized");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const items = await inbox(mac);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Reconnect GitHub so Replication can reach the Brain's repository");
    expect(items[0]!.why).toContain("Reconnect GitHub");

    await connectGitHub(mac, NEW_TOKEN);
    const after = await mac.post("/replication/check");
    expect(after.status).toBe("up_to_date");
    expect(pushedFiles(repo)).toContain("memory/notes/pulsar-hiring.md");
    expect(await inbox(mac)).toEqual([]);
  });

  it("never asks the Machine's own credential helper, as Git for Windows sets up Git Credential Manager", async () => {
    const own = testFolder("own-helper");
    const asked = join(own, "asked").replace(/\\/g, "/");
    const config = join(own, "gitconfig");
    writeFileSync(config, `[credential]\n\thelper = "!f() { echo asked >> '${asked}'; echo username=intruder; echo password=not-the-token; }; f"\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const repo = newRepo();
      const mac = await machine();
      await mac.post("/replication/setup", { remote: repo.full });
      await saveNote(mac, "Aurora budget");
      await mac.clock.advance(AFTER_WRITE);
      expect(pushedFiles(repo)).toContain("memory/notes/aurora-budget.md");
      expect(basicCredentials(repo)).toEqual(new Set([`x-access-token:${TOKEN}`]));
      expect(existsSync(asked)).toBe(false);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  it("runs the credential helper from an install folder whose path has spaces and non-ASCII letters", async () => {
    // As `C:\Users\Søren Ås\AppData\Local\Jarvis` on Windows: the helper's command line must still reach the `jarvis` executable.
    const install = testFolder("install");
    const script = join(install, "jarvis-service.mjs");
    writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(MAIN).href)});\n`);
    const before = process.env.JARVIS_CLI_SCRIPT;
    process.env.JARVIS_CLI_SCRIPT = script;
    try {
      const repo = newRepo();
      const mac = await machine();
      expect((await mac.post("/replication/setup", { remote: repo.full })).status).toBe("up_to_date");
      expect(basicCredentials(repo)).toEqual(new Set([`x-access-token:${TOKEN}`]));
    } finally {
      process.env.JARVIS_CLI_SCRIPT = before;
    }
  });

  it("refuses setup when GitHub rejects the connection's token, asking to reconnect", async () => {
    const repo = newRepo();
    const mac = await machine();
    github.acceptTokens(NEW_TOKEN);
    const r = await mac.call("POST", "/replication/setup", { remote: repo.full });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("remote_unauthorized");
    expect(r.body.error.message).toContain("Reconnect GitHub");
  });
});
