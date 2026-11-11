import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients, promptText } from "./mcp-client.ts";

/**
 * Review dates through the MCP server (spec seam 2): a Harness sets one when
 * it saves, and search and read tell it which facts are past theirs.
 */
type Passage = { path: string; startLine: number; section: string; text: string; review: string | null; unverified: boolean };
type Note = { path: string; text: string; unverified: Array<{ subject: string; review: string; line: number }> };

const IN_A_MONTH = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const NOTE = "memory/projects/orion-migration.md";

let svc: TestService;
const mcp = mcpClients();

beforeAll(async () => {
  svc = await startTestService();
  writeFileSync(
    join(svc.dataDir, NOTE),
    [
      "---",
      "type: project",
      "title: Orion migration",
      "---",
      "# Orion migration",
      "",
      "## Current State",
      "- **Status** (2026-01-10, review 2026-02-01): Orion cutover planned for March",
      `- **Owner** (2026-01-10, review ${IN_A_MONTH}): Orion is owned by Ada`,
      "- **Repository** (2026-01-10): acme/orion",
      "",
    ].join("\n"),
  );
  svc.app.memory.indexer.indexFile(svc.app.memory.rootRef!, NOTE);
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("Review dates through MCP", () => {
  it("search marks a fact past its Review date as unverified, and only that fact", async () => {
    const client = await mcp.connect(svc.stateDir);
    const r = await callTool<{ passages: Passage[] }>(client, "search", { query: "Orion" });
    const fact = (subject: string) => r.data.passages.find((p) => p.path === NOTE && p.text.includes(`**${subject}**`))!;
    expect(fact("Status")).toMatchObject({ review: "2026-02-01", unverified: true });
    expect(fact("Owner")).toMatchObject({ review: IN_A_MONTH, unverified: false });
    expect(fact("Repository")).toMatchObject({ review: null, unverified: false });
    const block = r.text.split("\n\n").find((b) => b.includes("Orion cutover planned for March"))!;
    expect(block.split("\n")[0]).toContain("unverified: Review date 2026-02-01 passed");
    expect(r.text.split("\n\n").find((b) => b.includes("owned by Ada"))!.split("\n")[0]).not.toContain("unverified");
  });

  it("read names the facts past their Review date", async () => {
    const client = await mcp.connect(svc.stateDir);
    const r = await callTool<Note>(client, "read", { path: NOTE });
    expect(r.data.unverified).toEqual([{ subject: "Status", review: "2026-02-01", line: 8 }]);
    expect(r.text).toContain("Unverified (past their Review date): Status (review 2026-02-01, line 8)");
    // A range without the overdue fact names none.
    const owner = await callTool<Note>(client, "read", { path: NOTE, startLine: 9, endLine: 9 });
    expect(owner.data.unverified).toEqual([]);
    expect(owner.text).not.toContain("Unverified");
  });

  it("save sets a Review date per fact, shown to the owner before it is written", async () => {
    const shown: Array<ElicitRequest["params"]> = [];
    const client = await mcp.connect(svc.stateDir, { confirm: (params) => (shown.push(params), { action: "accept" }) });
    const r = await callTool<{ outcome: string }>(client, "save", {
      items: [{ action: "update", path: NOTE, facts: [{ subject: "Status", value: "Orion cutover moved to April", reason: "vendor delay", review: IN_A_MONTH }] }],
    });
    expect(r.isError).toBe(false);
    expect(r.data.outcome).toBe("saved");
    expect(shown[0]!.message).toContain(`Status: Orion cutover moved to April (review after ${IN_A_MONTH})`);
    const status = readFileSync(join(svc.dataDir, NOTE), "utf8").split("\n").find((l) => l.startsWith("- **Status**"))!;
    expect(status).toContain(`, review ${IN_A_MONTH}): Orion cutover moved to April`);
  });

  it("save refuses a Review date that is not after today, writing nothing", async () => {
    const client = await mcp.connect(svc.stateDir, { confirm: () => ({ action: "accept" }) });
    const r = await callTool(client, "save", { items: [{ action: "update", path: NOTE, facts: [{ subject: "Owner", value: "Grace", reason: "handover", review: "2026-01-01" }] }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Review date 2026-01-01");
    expect(readFileSync(join(svc.dataDir, NOTE), "utf8")).toContain("Orion is owned by Ada");
  });

  it("the save prompt tells the agent when to set a Review date", async () => {
    const client = await mcp.connect(svc.stateDir);
    const text = await promptText(client, "save");
    expect(text).toContain('"review"');
    expect(text).toMatch(/Review date/);
  });
});
