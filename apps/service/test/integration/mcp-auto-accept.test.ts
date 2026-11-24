import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

type SaveReply = { outcome: "saved" | "declined" | "proposed"; autoAccepted?: boolean; message?: string; saved?: Array<{ action: string; path: string }>; proposals?: Array<{ id: string }> };

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
  // A fresh install: Claude Code is connected and its auto-accept was never touched. Codex is not connected.
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("MCP save with auto-accept", () => {
  it("on a fresh install, writes a save from a connected Harness without asking, and marks it auto-accepted with its Harness and session", async () => {
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "project", title: "Vega rollout", facts: [{ subject: "Status", value: "Pilot in two teams" }], events: ["Pilot started"] }] });

    expect(r.isError).toBe(false);
    expect(answer.shown).toEqual([]);
    expect(r.data).toMatchObject({ outcome: "saved", autoAccepted: true, saved: [{ action: "created", path: "memory/projects/vega-rollout.md" }] });
    expect(r.text).toContain("Auto-accept is on for Claude Code");
    // Claude Code hands the agent only the structured reply, so it carries the same words.
    expect(r.data.message).toContain("Auto-accept is on for Claude Code on this Machine, so the save was written without asking");
    expect(brainFile("memory/projects/vega-rollout.md")).toContain("Pilot in two teams");

    const { changes } = await svc.get("/memory/recent-changes?limit=20");
    const mine = changes.filter((c: { relPath: string }) => c.relPath === "memory/projects/vega-rollout.md");
    expect(mine.length).toBe(2);
    for (const c of mine) expect(c.source).toMatchObject({ harness: "claude-code", harnessLabel: "Claude Code", sessionId: "auto-session-7", autoAccepted: true });
  });

  it("still asks for a save from a Harness that is not connected", async () => {
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

  it("still asks for a save from an unknown MCP client", async () => {
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { name: "unknown-harness", confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Unknown client idea", facts: [{ subject: "Idea", value: "Asked first" }] }] });

    expect(answer.shown).toHaveLength(1);
    expect(r.data).toMatchObject({ outcome: "saved" });
    expect(r.data.autoAccepted).toBeFalsy();
  });

  it("asks again once auto-accept is switched off", async () => {
    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    try {
      const answer = owner("accept");
      const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
      const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: "Switched off", facts: [{ subject: "Idea", value: "Written once accepted" }] }] });
      expect(answer.shown).toHaveLength(1);
      expect(r.data).toMatchObject({ outcome: "saved", autoAccepted: false });
      expect(r.data.message).toContain("The owner confirmed the save.");
      expect(brainFile("memory/notes/switched-off.md")).toContain("Written once accepted");
    } finally {
      await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    }
  });

  it("refuses a save that targets the identity record while auto-accept is on", async () => {
    expect(await svc.get("/harnesses")).toEqual([{ id: "claude-code", label: "Claude Code", autoAccept: true }]);
    const before = brainFile("memory/self.md");
    const answer = owner();
    const client = await mcp.connect(svc.stateDir, { env: CLAUDE_CODE_SESSION, confirm: answer.confirm });
    const r = await callTool<SaveReply>(client, "save", { items: [{ action: "update", path: "memory/self.md", facts: [{ subject: "Name", value: "Mallory", reason: "Takeover" }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("identity record");
    expect(answer.shown).toEqual([]);
    expect(brainFile("memory/self.md")).toBe(before);
  });
});

describe("MCP save with auto-accept from Pi, OpenCode and Copilot CLI", () => {
  beforeAll(async () => {
    // Never run or find a real OpenCode or Copilot CLI.
    process.env.ATTACHE_OPENCODE_BIN = join(HOME, "no-opencode-here");
    process.env.ATTACHE_COPILOT_BIN = join(HOME, "no-copilot-here");
    for (const kind of ["pi", "opencode", "copilot-cli"]) await svc.post(`/connections/${kind}/configure`, { method: "hooks", fields: {} });
  });
  afterAll(() => {
    delete process.env.ATTACHE_OPENCODE_BIN;
    delete process.env.ATTACHE_COPILOT_BIN;
  });

  it("each is listed in Settings with auto-accept on, like every connected Harness (ADR 0004)", async () => {
    expect(await svc.get("/harnesses")).toEqual([
      { id: "claude-code", label: "Claude Code", autoAccept: true },
      { id: "pi", label: "Pi", autoAccept: true },
      { id: "opencode", label: "OpenCode", autoAccept: true },
      { id: "copilot-cli", label: "Copilot CLI", autoAccept: true },
    ]);
  });

  // The names each one's MCP client gives itself: Pi's source; seen from OpenCode 1.19.6 and 2.3.2, and from Copilot CLI 1.0.114 (offline, with a stand-in model).
  for (const [name, label] of [["pi", "Pi"], ["opencode", "OpenCode"], ["copilot-cli", "Copilot CLI"]] as const) {
    it(`writes a save from a connected ${label} without asking, and asks again once its switch is off`, async () => {
      const answer = owner();
      const client = await mcp.connect(svc.stateDir, { name, confirm: answer.confirm });
      const r = await callTool<SaveReply>(client, "save", { items: [{ action: "create", type: "note", title: `${label} idea`, facts: [{ subject: "Idea", value: "Written straight away" }] }] });
      expect(answer.shown).toEqual([]);
      expect(r.data).toMatchObject({ outcome: "saved", autoAccepted: true });
      expect(r.text).toContain(`Auto-accept is on for ${label}`);
      const { changes } = await svc.get("/memory/recent-changes?limit=50");
      expect(changes.find((c: { relPath: string }) => c.relPath.includes(`${name === "copilot-cli" ? "copilot-cli" : name}-idea`))?.source).toMatchObject({ harness: name, harnessLabel: label, autoAccepted: true });
      await svc.put(`/harnesses/${name}/auto-accept`, { autoAccept: false });
      const asked = owner();
      const again = await mcp.connect(svc.stateDir, { name, confirm: asked.confirm });
      const r2 = await callTool<SaveReply>(again, "save", { items: [{ action: "create", type: "note", title: `${label} second idea`, facts: [{ subject: "Idea", value: "Asked first" }] }] });
      expect(asked.shown).toHaveLength(1);
      expect(r2.data).toMatchObject({ outcome: "saved", autoAccepted: false });
    });
  }
});
