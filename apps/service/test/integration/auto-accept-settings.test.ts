import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

const HOME = process.env.JARVIS_AGENT_HOME!;
const running: TestService[] = [];

async function start(opts: Parameters<typeof startTestService>[0] = {}): Promise<TestService> {
  const svc = await startTestService(opts);
  running.push(svc);
  return svc;
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
  it("lists each connected Harness with auto-accept off, and only connected ones", async () => {
    const svc = await start();
    expect(await svc.get("/harnesses")).toEqual([]);
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    expect(await svc.get("/harnesses")).toEqual([
      { id: "claude-code", label: "Claude Code", autoAccept: false },
      { id: "codex", label: "Codex", autoAccept: false },
    ]);
  });

  it("switches one Harness on, refuses a Harness that is not connected or not known", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true })).toEqual({ id: "claude-code", label: "Claude Code", autoAccept: true });
    expect(await svc.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);

    const codex = await svc.call("PUT", "/harnesses/codex/auto-accept", { autoAccept: true });
    expect(codex.status).toBe(409);
    expect(codex.body.error.message).toContain("Connect Codex first");
    const unknown = await svc.call("PUT", "/harnesses/sneaky/auto-accept", { autoAccept: true });
    expect(unknown.status).toBe(404);
    const invalid = await svc.call("PUT", "/harnesses/claude-code/auto-accept", { autoAccept: "yes" });
    expect(invalid.status).toBe(400);
  });

  it("is kept in the Machine's local state: it survives a restart and leaves the Brain untouched", async () => {
    const first = await start();
    await first.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    const before = snapshot(first.dataDir);
    await first.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    expect(snapshot(first.dataDir)).toEqual(before);
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const again = await start({ stateDir: first.stateDir, dataDir: first.dataDir });
    expect(await again.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);

    // Another Machine keeps its own setting, which starts off.
    const other = await start({ dataDir: join(first.dataDir, "..", "other-machine-data") });
    await other.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await other.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: false }]);
  });

  it("turns off when the Harness is disconnected, so connecting it again starts off", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    await svc.post("/connections/claude-code/disconnect", { deleteData: false });
    expect(await svc.get("/harnesses")).toEqual([]);
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(await svc.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: false }]);
  });

  it("says in the save check whether the save may skip asking, and refuses an auto-accepted save while it is off", async () => {
    const svc = await start();
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect((await svc.post("/memory/save/check", SAVE("Checked"))).autoAccept).toBe(false);

    const refused = await svc.call("POST", "/memory/save", SAVE("Not allowed", true));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("auto_accept_off");
    expect(refused.body.error.message).toContain("Auto-accept is off for Claude Code");
    expect(snapshot(svc.dataDir)["memory/notes/not-allowed.md"]).toBeUndefined();

    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    expect((await svc.post("/memory/save/check", SAVE("Checked"))).autoAccept).toBe(true);
    expect((await svc.post("/memory/save/check", { ...SAVE("Checked"), origin: { agent: "codex" } })).autoAccept).toBe(false);
    const { origin: _origin, ...noOrigin } = SAVE("No origin", true);
    expect((await svc.call("POST", "/memory/save", noOrigin)).status).toBe(409);
  });
});
