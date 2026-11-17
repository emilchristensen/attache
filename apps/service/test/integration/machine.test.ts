import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const running: TestService[] = [];
const children: ChildProcess[] = [];

async function start(opts: Parameters<typeof startTestService>[0] = {}): Promise<TestService> {
  const svc = await startTestService(opts);
  running.push(svc);
  return svc;
}

async function stop(svc: TestService) {
  running.splice(running.indexOf(svc), 1);
  await svc.stop();
}

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
  for (const c of children.splice(0)) c.kill("SIGKILL");
});

/** Every file under `dir`, relative to it. */
function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, join(prefix, e.name)) : [join(prefix, e.name)]));
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("Machine identity", () => {
  it("a Machine has a stable id and is named after its hostname by default", async () => {
    let svc = await start();
    const first = await svc.get("/machine");
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.name).toBe(hostname().split(".")[0]);
    const { stateDir, dataDir } = svc;
    await stop(svc);
    svc = await start({ stateDir, dataDir });
    expect(await svc.get("/machine")).toEqual(first);
  });

  it("the owner can rename the Machine, and the name survives a restart", async () => {
    let svc = await start();
    const before = await svc.get("/machine");
    const renamed = (await svc.call("PATCH", "/machine", { name: "  Home PC  " })).body;
    expect(renamed).toEqual({ id: before.id, name: "Home PC" });
    const { stateDir, dataDir } = svc;
    await stop(svc);
    svc = await start({ stateDir, dataDir });
    expect(await svc.get("/machine")).toEqual({ id: before.id, name: "Home PC" });
  });

  it("refuses an empty or overlong name", async () => {
    const svc = await start();
    for (const name of ["", "   ", "x".repeat(65)]) expect((await svc.call("PATCH", "/machine", { name })).status).toBe(400);
    expect((await svc.get("/machine")).name).toBe(hostname().split(".")[0]);
  });
});

describe("per-Machine evidence", () => {
  let fx: FixtureServer | null = null;
  afterAll(async () => {
    await fx?.close();
  });

  it("connector snapshots are written to a file that carries the Machine's name", async () => {
    fx = await startFixtureServer();
    fx.route("GET", "/user", () => ({ json: { login: "t" } }));
    fx.route("GET", "/search/issues", () => ({
      json: { incomplete_results: false, items: [{ number: 9, title: "Snapshot per Machine", html_url: "https://github.com/a/b/pull/9", state: "open", draft: false, user: { login: "x" }, repository_url: "https://api.github.com/repos/a/b", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] },
    }));
    const svc = await start();
    await svc.call("PATCH", "/machine", { name: "Work Mac" });
    await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    await svc.waitJob((await svc.post("/connections/github/refresh")).job.id);
    const files = readdirSync(join(svc.dataDir, "evidence/connectors/github"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${today()}-work-mac-[0-9a-f]{8}\\.md$`));
    const snapshot = readFileSync(join(svc.dataDir, "evidence/connectors/github", files[0]!), "utf8");
    expect(snapshot).toContain("machine: Work Mac");
    expect(snapshot).toContain("Snapshot per Machine");
  });
});

describe("evidence written before the change", () => {
  it("is still found by search and the audit", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-legacy-")), "data");
    const yesterday = daysAgo(1);
    mkdirSync(join(dataDir, "evidence/sessions"), { recursive: true });
    mkdirSync(join(dataDir, "evidence/connectors/slack"), { recursive: true });
    mkdirSync(join(dataDir, "memory/projects"), { recursive: true });
    writeFileSync(
      join(dataDir, "evidence/sessions", `${yesterday}.md`),
      `---\ntype: session-log\ntitle: Agent sessions on ${yesterday}\ndate: ${yesterday}\nprovenance: agent-session-summary\n---\n# Agent sessions on ${yesterday}\n\n## Claude Code · Quasar rollout\n\n- Quasar rollout status moved to paused because the vendor contract lapsed.\n`,
    );
    writeFileSync(
      join(dataDir, "evidence/connectors/slack", `${yesterday}.md`),
      `---\ntype: connector-snapshot\ntitle: Slack on ${yesterday}\nsource: slack\nobserved_at: ${yesterday}T09:00:00.000Z\nprovenance: connector\n---\n# Slack on ${yesterday}\n\n- **message** C1: Heliotrope budget was approved by finance\n`,
    );
    writeFileSync(
      join(dataDir, "memory/projects/quasar-rollout.md"),
      `---\nid: q1\ntype: project\ntitle: Quasar rollout\nprovenance: user-stated\ncreated: ${daysAgo(30)}\nupdated: ${daysAgo(30)}\n---\n# Quasar rollout\n\n## Current State\n- **Status** (${daysAgo(30)}): Rolling out to all teams\n\n## History\n- ${daysAgo(30)} — created by user\n`,
    );
    const svc = await start({ dataDir, features: { sessions: true } });

    const sessionHits = (await svc.get(`/memory/search?q=${encodeURIComponent("Quasar vendor contract lapsed")}`)).hits;
    expect(sessionHits.some((h: { relPath: string }) => h.relPath === `evidence/sessions/${yesterday}.md`)).toBe(true);
    const snapshotHits = (await svc.get(`/memory/search?q=${encodeURIComponent("Heliotrope budget approved")}`)).hits;
    expect(snapshotHits.some((h: { relPath: string }) => h.relPath === `evidence/connectors/slack/${yesterday}.md`)).toBe(true);

    const audit = await svc.get("/memory/audit");
    const status = audit.findings.find((f: { relPath: string }) => f.relPath === "memory/projects/quasar-rollout.md").entries[0];
    expect(status.newerEvidence.map((e: { relPath: string }) => e.relPath)).toContain(`evidence/sessions/${yesterday}.md`);
  });

  it("a project's session context reads every Machine's log of a day", async () => {
    const svc = await start({ features: { sessions: true } });
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Quasar rollout", facts: [{ subject: "Repositories", value: "acme/quasar" }] }] });
    const date = today();
    const other = `---\ntype: session-log\ntitle: Agent sessions on ${date}\ndate: ${date}\nmachine: Desk\nprovenance: agent-session-summary\n---\n# Agent sessions on ${date}\n\n## 08:00 · Claude Code · quasar\n\n**Before lunch**\n\nRepository: github.com/acme/quasar\n\n- Written on the other Machine.\n`;
    writeFileSync(join(svc.dataDir, "evidence/sessions", `${date}-desk-12345678.md`), other);
    svc.app.memory.appendSessionLog(date, "## 14:00 · Codex · quasar\n\n**After lunch**\n\nRepository: github.com/acme/quasar\n\n- Written on this Machine.");
    svc.app.sessions.refreshContext();
    const context = readFileSync(join(svc.stateDir, "agents/projects/quasar-rollout.md"), "utf8");
    expect(context).toContain(`##### ${date} 14:00 · Codex · quasar`);
    expect(context).toContain(`##### ${date} 08:00 · Claude Code · quasar`);
    expect(context.indexOf("Written on this Machine.")).toBeLessThan(context.indexOf("Written on the other Machine."));
  });
});

describe("the writer lock", () => {
  const START_WAIT_MS = 60_000;
  /** A second Attache service, as its own process, on its own state folder. */
  async function otherService(dataDir: string): Promise<ChildProcess> {
    const stateDir = mkdtempSync(join(tmpdir(), "attache-it-other-state-"));
    const env = { ...process.env, ATTACHE_INSTANCE: "other-machine-test" };
    const child = spawn(process.execPath, [MAIN, "serve", "--state-dir", stateDir, "--port", "0"], { env, stdio: "ignore" });
    children.push(child);
    let url = "";
    // A cold service process can take well over 15 s to start while the whole suite runs in parallel.
    const deadline = Date.now() + START_WAIT_MS;
    while (!url && child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const rt = join(stateDir, "runtime.json");
      if (existsSync(rt) && JSON.parse(readFileSync(rt, "utf8")).pid === child.pid) url = JSON.parse(readFileSync(rt, "utf8")).url;
    }
    if (!url) throw new Error(child.exitCode === null ? "the other service did not start" : `the other service exited with code ${child.exitCode}`);
    const code = JSON.parse(execFileSync(process.execPath, [MAIN, "pair", "--state-dir", stateDir, "--json"], { env, encoding: "utf8" })).code;
    const paired = await (await fetch(`${url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ code, kind: "cli", clientName: "other" }) })).json();
    const res = await fetch(`${url}/api/v1/setup/data-folder`, { method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ path: dataDir }) });
    if (res.status !== 200) throw new Error(`the other service could not open the folder: ${await res.text()}`);
    return child;
  }

  it("is not inside the data folder, and a second service on the same folder is refused", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-shared-")), "data");
    const other = await otherService(dataDir);
    expect(walk(dataDir).filter((f) => /lock/i.test(f))).toEqual([]);

    const svc = await start({ setup: false });
    const refused = await svc.call("POST", "/setup/data-folder", { path: dataDir });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/Another Attache service \(pid \d+\) owns this data folder/);

    other.kill("SIGKILL");
    await new Promise((r) => other.once("exit", r));
    // The other service is gone, so its lock no longer holds the folder.
    expect((await svc.call("POST", "/setup/data-folder", { path: dataDir })).status).toBe(200);
    expect(walk(dataDir).filter((f) => /lock/i.test(f))).toEqual([]);
  }, 120_000);

  it("removes a lock an earlier version left inside the data folder", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-oldlock-")), "data");
    mkdirSync(join(dataDir, ".attache"), { recursive: true });
    writeFileSync(join(dataDir, ".attache/writer.lock"), JSON.stringify({ pid: 2 ** 22 + 7, instance: "old", at: "2026-01-01T00:00:00.000Z" }));
    await start({ dataDir });
    expect(existsSync(join(dataDir, ".attache/writer.lock"))).toBe(false);
  });
});
