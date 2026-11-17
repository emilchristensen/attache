import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

type SaveReply = { outcome: "saved" | "declined" | "proposed"; autoAccepted?: boolean; saved?: Array<{ action: string; path: string }>; proposals?: Array<{ id: string }> };

const HOME = process.env.ATTACHE_AGENT_HOME!;
const CLAUDE_CODE_SESSION = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "auto-session-7" };
const CODEX_THREAD = { CODEX_THREAD_ID: "codex-thread-9" };

let svc: TestService;
const mcp = mcpClients();

/** A Harness whose owner accepts every confirmation, keeping what it was shown. */
function owner(action: ElicitResult["action"] = "accept") {
  const shown: Array<ElicitRequest["params"]> = [];
  return { shown, confirm: (params: ElicitRequest["params"]) => (shown.push(params), { action }) };
}

const brainFile = (rel: string) => (existsSync(join(svc.dataDir, rel)) ? readFileSync(join(svc.dataDir, rel), "utf8") : null);

beforeAll(async () => {
  for (const d of [".claude", ".codex"]) mkdirSync(join(HOME, d), { recursive: true });
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  for (const kind of ["claude-code", "codex"]) await svc.post(`/connections/${kind}/configure`, { method: "hooks", fields: {} });
  await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("MCP save with auto-accept", () => {
  it("writes a save from the Harness with auto-accept on without asking, and marks it auto-accepted with its Harness and session", async () => {
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "project", title: "Vega rollout", facts: [{ subject: "Status", value: "Pilot in two teams" }], events: ["Pilot started"] }] });

    expect(r.isError).toBe(false);
    expect(answer.shown).toEqual([]);
    expect(r.data).toMatchObject({ outcome: "saved", autoAccepted: true, saved: [{ action: "created", path: "memory/projects/vega-rollout.md" }] });
    expect(r.text).toContain("auto-accept");
    expect(brainFile("memory/projects/vega-rollout.md")).toContain("Pilot in two teams");

    const { changes } = await svc.get("/memory/recent-changes?limit=20");
    const mine = changes.filter((c: { relPath: string }) => c.relPath === "memory/projects/vega-rollout.md");
    expect(mine.length).toBe(2);
    for (const c of mine) expect(c.source).toMatchObject({ harness: "claude-code", harnessLabel: "Claude Code", sessionId: "auto-session-7", autoAccepted: true });
  });

  it("still asks for a save from another Harness", async () => {
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { env: CODEX_THREAD, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Codex idea", facts: [{ subject: "Idea", value: "Asked first" }] }] });

    expect(answer.shown).toHaveLength(1);
    expect(r.data).toMatchObject({ outcome: "saved" });
    expect(r.data.autoAccepted).toBeFalsy();
    const { changes } = await svc.get("/memory/recent-changes?limit=20");
    const created = changes.find((c: { relPath: string }) => c.relPath === "memory/notes/codex-idea.md");
    expect(created.source).toMatchObject({ harness: "codex", sessionId: "codex-thread-9", autoAccepted: false });
  });

  it("asks again once auto-accept is switched off", async () => {
    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    try {
      const answer = owner("decline");
      const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
      const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Switched off", facts: [{ subject: "Idea", value: "Not written" }] }] });
      expect(answer.shown).toHaveLength(1);
      expect(r.data.outcome).toBe("declined");
      expect(brainFile("memory/notes/switched-off.md")).toBeNull();
    } finally {
      await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    }
  });

  it("never auto-accepts a change to the identity record", async () => {
    const before = brainFile("memory/self.md");
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "update", path: "memory/self.md", facts: [{ subject: "Name", value: "Mallory", reason: "Takeover" }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("identity record");
    expect(brainFile("memory/self.md")).toBe(before);
  });
});
