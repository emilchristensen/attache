import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { databaseBefore } from "../fixtures/old-database.ts";
import { startTestService, type TestService } from "./harness.ts";

const HOME = process.env.ATTACHE_AGENT_HOME!;
const running: TestService[] = [];

async function start(opts: Parameters<typeof startTestService>[0] = {}): Promise<TestService> {
  const svc = await startTestService(opts);
  running.push(svc);
  return svc;
}

async function stop(svc: TestService): Promise<void> {
  await svc.stop();
  running.splice(running.indexOf(svc), 1);
}

/** Every file under `dir` with its contents, so a test can tell whether anything in the Brain changed. */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
      const rel = join(prefix, e.name);
      return e.isDirectory() ? Object.entries(snapshot(dir, rel)) : [[rel, readFileSync(join(dir, rel), "utf8")]];
    }),
  );
}

/**
 * Turn a stopped service's database into the one the version before ADR 0004 left: the schema of every migration
 * before the one that switches stored settings on, holding the same rows, so the next start runs that migration
 * and every later one, as an upgrade does.
 */
function asBeforeAutoAcceptDefault(stateDir: string): void {
  const file = join(stateDir, "attache.sqlite");
  const current = `${file}.current`;
  const live = new DatabaseSync(file);
  live.exec("pragma wal_checkpoint(truncate)");
  live.close();
  renameSync(file, current);
  for (const side of ["-wal", "-shm"]) rmSync(`${file}${side}`, { force: true });
  const old = databaseBefore(file, /update harness_settings set auto_accept = 1/);
  old.prepare("attach database ? as current").run(current);
  // Every table the old schema has gets the rows in the columns it had. A full-text index cannot be copied (SQLite
  // refuses writes to its storage), so it starts empty, which nothing here searches.
  const virtual = (old.prepare("select name from main.sqlite_master where sql like 'create virtual%'").all() as Array<{ name: string }>).map((t) => t.name);
  const tables = (old.prepare("select name from main.sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>).filter(
    (t) => !virtual.some((v) => t.name === v || t.name.startsWith(`${v}_`)),
  );
  const columns = (schema: string, table: string) => (old.prepare(`select name from pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>).map((c) => `"${c.name}"`);
  for (const { name } of tables) {
    const now = new Set(columns("current", name));
    const kept = columns("main", name).filter((c) => now.has(c)).join(", ");
    if (kept) old.exec(`insert or replace into main."${name}" (${kept}) select ${kept} from current."${name}"`);
  }
  old.exec("detach database current");
  old.close();
  rmSync(current);
}

beforeAll(() => {
  for (const d of [".claude", ".codex"]) mkdirSync(join(HOME, d), { recursive: true });
});
afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
});

const SAVE = (title: string, autoAccept?: boolean) => ({
  origin: { agent: "claude-code", sessionId: "s-1" },
  items: [{ action: "create", type: "note", title, facts: [{ subject: "Idea", value: "Something" }] }],
  ...(autoAccept === undefined ? {} : { autoAccept }),
});

describe("auto-accept settings", () => {
  it("lists each connected Harness with auto-accept on, and only connected ones", async () => {
    const svc = await start();
    expect(await svc.get("/harnesses")).toEqual([]);
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    expect(await svc.get("/harnesses")).toEqual([
      { id: "claude-code", label: "Claude Code", autoAccept: true },
      { id: "codex", label: "Codex", autoAccept: true },
    ]);
  });

  it("switches one Harness off, refuses a Harness that is not connected or not known", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false })).toEqual({ id: "claude-code", label: "Claude Code", autoAccept: false });
    expect(await svc.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: false }]);

    const codex = await svc.call("PUT", "/harnesses/codex/auto-accept", { autoAccept: false });
    expect(codex.status).toBe(409);
    expect(codex.body.error.message).toContain("Connect Codex first");
    const unknown = await svc.call("PUT", "/harnesses/sneaky/auto-accept", { autoAccept: false });
    expect(unknown.status).toBe(404);
    const invalid = await svc.call("PUT", "/harnesses/claude-code/auto-accept", { autoAccept: "no" });
    expect(invalid.status).toBe(400);
  });

  it("is kept in the Machine's local state: switched off, it survives a restart and leaves the Brain untouched", async () => {
    const first = await start();
    await first.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    const before = snapshot(first.dataDir);
    await first.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    expect(snapshot(first.dataDir)).toEqual(before);
    await stop(first);

    const again = await start({ stateDir: first.stateDir, dataDir: first.dataDir });
    expect(await again.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: false }]);

    // Another Machine keeps its own setting, which starts on.
    const other = await start({ dataDir: join(first.dataDir, "..", "other-machine-data") });
    await other.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await other.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);
  });

  it("starts on again when a Harness switched off is disconnected and connected again", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    await svc.post("/connections/claude-code/disconnect", { deleteData: false });
    expect(await svc.get("/harnesses")).toEqual([]);
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await svc.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);
  });

  it("switches every stored setting on when upgrading, once, so a Harness switched off afterwards stays off across restarts", async () => {
    const old = await start();
    await old.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await old.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    await stop(old);
    asBeforeAutoAcceptDefault(old.stateDir);

    const upgraded = await start({ stateDir: old.stateDir, dataDir: old.dataDir });
    expect(await upgraded.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);
    await upgraded.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    await stop(upgraded);

    const restarted = await start({ stateDir: old.stateDir, dataDir: old.dataDir });
    expect(await restarted.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: false }]);
  });

  it("lets a save skip asking only for a connected Harness Attache knows, and refuses an auto-accepted save once it is switched off", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect((await svc.post("/memory/save/check", SAVE("Checked"))).autoAccept).toBe(true);
    expect((await svc.post("/memory/save/check", { ...SAVE("Checked"), origin: { agent: "codex" } })).autoAccept).toBe(false);
    expect((await svc.post("/memory/save/check", { ...SAVE("Checked"), origin: { agent: "test-harness" } })).autoAccept).toBe(false);
    const { origin: _origin, ...noOrigin } = SAVE("No origin", true);
    expect((await svc.call("POST", "/memory/save", noOrigin)).status).toBe(409);

    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    expect((await svc.post("/memory/save/check", SAVE("Checked"))).autoAccept).toBe(false);
    const refused = await svc.call("POST", "/memory/save", SAVE("Not allowed", true));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("auto_accept_off");
    expect(refused.body.error.message).toContain("Auto-accept is off for Claude Code");
    expect(snapshot(svc.dataDir)["memory/notes/not-allowed.md"]).toBeUndefined();
  });
});
