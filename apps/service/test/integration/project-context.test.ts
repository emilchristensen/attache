import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

// Each check runs the session-start hook through a login shell, many times per test, which is slow under load.
vi.setConfig({ testTimeout: 120_000 });

/**
 * Session context chosen by project (spec seam 2): a project note lists its
 * repositories through a save, and the session-start hook, run in a folder
 * with a git remote, prints that project's context without the service.
 */
const HOME = process.env.JARVIS_AGENT_HOME!;
const work = mkdtempSync(join(tmpdir(), "jarvis-it-projectctx-"));
const ORION = "memory/projects/orion-migration.md";

let svc: TestService;
let stopped = false;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

/** A local repository whose remotes are `remotes`; nothing is ever fetched. */
function repo(name: string, remotes: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [remote, url] of Object.entries(remotes)) git(dir, "remote", "add", remote, url);
  return dir;
}

/** Run the SessionStart command Jarvis registered, from `cwd`, the way Claude Code does. */
function sessionStart(cwd: string, env: Record<string, string> = {}): string {
  const s = JSON.parse(readFileSync(join(HOME, ".claude/settings.json"), "utf8"));
  const command = (s.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks).find((h) => h.command.includes("jarvis-agent-hook"))!.command;
  const out = execFileSync("/bin/sh", ["-lc", command], { cwd, input: JSON.stringify({ session_id: "s1", cwd, source: "startup" }), env: { ...process.env, HOME, ...env }, encoding: "utf8" });
  return out.trim() ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "";
}

async function until<T>(fn: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PROJECT_HEADING = "### This session's project: Orion migration";

beforeAll(async () => {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  await svc.post("/memory/save", {
    items: [
      { action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for October" }, { subject: "Repositories", value: "acme/orion" }] },
      { action: "create", type: "project", title: "Atlas", facts: [{ subject: "Status", value: "Discovery" }] },
    ],
  });
});
afterAll(async () => {
  if (!stopped) await svc?.stop();
});

describe("session context chosen by project", { timeout: 20_000 }, () => {
  it("a session in the project's repository starts with that project's context", async () => {
    const dir = repo("orion-ssh", { origin: "git@github.com:acme/orion.git" });
    const ctx = await until(() => {
      const c = sessionStart(dir);
      return c.includes(PROJECT_HEADING) && c;
    });
    expect(ctx).toContain("**Status**");
    expect(ctx).toContain("Cutover planned for October");
    expect(ctx).toContain(join(svc.dataDir, ORION));
    // The rest of the Brain is still in view.
    expect(ctx).toContain("Name: Alex");
    expect(ctx).toContain("Atlas");
  });

  it("the HTTPS and SSH remotes of the repository both match, from any folder inside it", async () => {
    const https = repo("orion-https", { origin: "https://github.com/Acme/Orion" });
    const sshUrl = repo("orion-ssh-url", { upstream: "ssh://git@github.com:22/acme/orion.git", origin: "https://example.com/forks/orion.git" });
    mkdirSync(join(https, "packages/api"), { recursive: true });
    for (const dir of [https, join(https, "packages/api"), sshUrl]) expect(sessionStart(dir)).toContain(PROJECT_HEADING);
  });

  it("a session in a worktree of the repository gets the project's context", async () => {
    const main = repo("orion-main", { origin: "git@github.com:acme/orion.git" });
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    const tree = join(work, "orion-worktree");
    git(main, "worktree", "add", "-q", tree);
    expect(sessionStart(tree)).toContain(PROJECT_HEADING);
  });

  it("a session elsewhere gets the global context", async () => {
    for (const dir of [repo("other", { origin: "git@github.com:acme/other.git" }), repo("no-remote", {}), mkdtempSync(join(tmpdir(), "jarvis-it-plain-"))]) {
      const ctx = sessionStart(dir);
      expect(ctx).not.toContain("This session's project");
      expect(ctx).toContain("Orion migration");
      expect(ctx).toContain("Name: Alex");
    }
  });

  it("a save that lists something other than repositories is refused whole", async () => {
    const r = await svc.call("POST", "/memory/save", {
      items: [
        { action: "create", type: "project", title: "Hermes", facts: [{ subject: "Repositories", value: "acme/hermes, the API repo" }] },
        { action: "update", path: ORION, events: ["Kick-off held"] },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('"the"');
    expect((await svc.call("GET", "/memory/document?path=memory/projects/hermes.md")).status).toBe(404);
    expect(readFileSync(join(svc.dataDir, ORION), "utf8")).not.toContain("Kick-off held");
    const update = await svc.call("POST", "/memory/save", { items: [{ action: "update", path: ORION, facts: [{ subject: "repository", value: "https://", reason: "typo" }] }] });
    expect(update.status).toBe(400);
    // A Proposal is checked like a save, so it cannot slip a bad list in for the owner to apply.
    const proposal = await svc.call("POST", "/memory/proposals", { item: { action: "update", path: ORION, facts: [{ subject: "Repositories", value: "acme/orion, the API repo", reason: "seen in a session" }] }, reason: "seen in a session" });
    expect(proposal.status).toBe(400);
  });

  it("the context files are rewritten when the Brain changes", async () => {
    const orion = repo("orion-later", { origin: "git@github.com:acme/orion.git" });
    const atlas = repo("atlas", { origin: "git@gitlab.example.com:platform/atlas.git" });
    expect(sessionStart(atlas)).not.toContain("This session's project");

    // A save changes a fact and gives Atlas its repository.
    await svc.post("/memory/save", {
      items: [
        { action: "update", path: ORION, facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }] },
        { action: "update", path: "memory/projects/atlas.md", facts: [{ subject: "Repositories", value: "gitlab.example.com/platform/atlas", reason: "named in the session" }] },
      ],
    });
    await until(() => sessionStart(orion).includes("Cutover moved to November"));
    expect(sessionStart(orion)).not.toContain("Cutover planned for October");
    expect(await until(() => sessionStart(atlas).includes("### This session's project: Atlas"))).toBe(true);

    // A hand edit, or a change arriving from another Machine, counts too: Orion no longer lists the repository.
    const note = join(svc.dataDir, ORION);
    writeFileSync(note, readFileSync(note, "utf8").replace(/^- \*\*Repositories\*\*.*\n/m, ""));
    await until(() => !sessionStart(orion).includes(PROJECT_HEADING));
    expect(sessionStart(orion)).toContain("Cutover moved to November");

    // Reverting the save that named Atlas's repository takes its project context away again.
    const named = (await svc.get("/memory/recent-changes")).changes.find((c: { relPath: string; subject: string | null }) => c.relPath === "memory/projects/atlas.md" && c.subject === "Repositories");
    await svc.post(`/memory/changes/${named.id}/revert`);
    expect(await until(() => !sessionStart(atlas).includes("### This session's project: Atlas"))).toBe(true);

    // An applied Proposal counts as a Brain change too.
    const proposal = await svc.post("/memory/proposals", { item: { action: "update", path: "memory/projects/atlas.md", facts: [{ subject: "Repositories", value: "gitlab.example.com/platform/atlas", reason: "named again" }] }, reason: "named again" });
    await svc.post(`/memory/proposals/${proposal.id}/apply`);
    expect(await until(() => sessionStart(atlas).includes("### This session's project: Atlas"))).toBe(true);
  });

  it("the hook makes no network call and works while the service is stopped", async () => {
    await svc.stop();
    stopped = true;
    // Record every socket, name lookup and fetch the hook process attempts.
    const probe = join(work, "network-probe.mjs");
    const log = join(work, "network.log");
    writeFileSync(
      probe,
      `import net from "node:net";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
const note = (what) => appendFileSync(process.env.NETWORK_LOG, what + "\\n");
note("loaded");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { note("connect"); return connect.apply(this, a); };
for (const name of ["lookup", "resolve"]) { const f = dns[name]; dns[name] = function (...a) { note(name); return f.apply(this, a); }; }
globalThis.fetch = async () => { note("fetch"); throw new Error("offline"); };
`,
    );
    const atlas = repo("atlas-offline", { origin: "https://gitlab.example.com/platform/atlas.git" });
    const ctx = sessionStart(atlas, { NODE_OPTIONS: `--import=${probe}`, NETWORK_LOG: log });
    expect(ctx).toContain("### This session's project: Atlas");
    expect(readFileSync(log, "utf8")).toBe("loaded\n");
  });
});
