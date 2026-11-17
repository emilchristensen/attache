import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

type Passage = { path: string; startLine: number; endLine: number; area: string; section: string; title: string; text: string };
type WrapUp = { stored: true; relPath: string; title: string; date: string; points: number } | { stored: false; reason: string };

let svc: TestService;
const mcp = mcpClients();

/** The wrap-up documents in the Brain, by file name. */
function wrapUps(): string[] {
  const dir = join(svc.dataDir, "evidence/wrap-ups");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("The wrap-up prompt", () => {
  it("is offered to a Harness, and tells the agent how to record the conversation's durable points", async () => {
    const client = await mcp.connect(svc.stateDir, { name: "claude-ai" });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("wrap_up");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("wrap-up");
    const prompt = await client.getPrompt({ name: "wrap-up" });
    expect(prompt.messages).toHaveLength(1);
    const message = prompt.messages[0]!;
    expect(message.role).toBe("user");
    const text = message.content.type === "text" ? message.content.text : "";
    expect(text).toContain("`wrap_up`");
    expect(text).toMatch(/nothing durable/i);
  });

  it("stores one evidence document with the points, the Harness and the date", async () => {
    const client = await mcp.connect(svc.stateDir, { name: "claude-ai", title: "Claude" });
    const before = wrapUps();
    const points = ["Ada decided the Zephyr launch moves to 2026-12-01 because legal review is late.", "Grace owns the Zephyr press release, due 2026-11-20."];
    const r = await callTool<WrapUp>(client, "wrap_up", { title: "Zephyr launch planning", points });
    expect(r.isError).toBe(false);
    const added = wrapUps().filter((f) => !before.includes(f));
    expect(added).toHaveLength(1);
    const relPath = `evidence/wrap-ups/${added[0]}`;
    expect(r.data).toMatchObject({ stored: true, relPath, points: 2 });
    expect(r.text).toContain(relPath);

    const doc = readFileSync(join(svc.dataDir, relPath), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(added[0]).toMatch(new RegExp(`^${today}-`));
    for (const p of points) expect(doc).toContain(`- ${p}`);
    expect(doc).toContain("Claude Desktop");
    expect(doc).toContain(today);
    expect(doc).toContain("Zephyr launch planning");
    // Evidence, not curated memory: nothing in it reads as a current fact.
    expect(doc).not.toMatch(/^## Current State/im);
    expect(doc).toMatch(/^type: wrap-up$/m);
  });

  it("is searchable, and search labels its points as evidence, never as a current fact", async () => {
    const client = await mcp.connect(svc.stateDir, { name: "claude-ai" });
    const stored = await callTool<WrapUp>(client, "wrap_up", { title: "Quasar vendor call", points: ["The Quasar vendor contract renews on 2027-03-01 unless cancelled by 2027-01-15."] });
    expect(stored.data.stored).toBe(true);
    const relPath = (stored.data as { relPath: string }).relPath;

    const r = await callTool<{ passages: Passage[] }>(client, "search", { query: "Quasar vendor contract renews" });
    expect(r.isError).toBe(false);
    const hit = r.data.passages.find((p) => p.path === relPath && p.text.includes("2027-03-01"));
    expect(hit).toMatchObject({ area: "evidence", section: "body", title: "Quasar vendor call" });
    expect(r.data.passages.filter((p) => p.path === relPath).map((p) => p.section)).not.toContain("state");
    expect(r.text).toContain(`${relPath}:${hit!.startLine}-${hit!.endLine} · Quasar vendor call · evidence`);
  });

  it("stores nothing for a conversation with nothing durable, and says so", async () => {
    const client = await mcp.connect(svc.stateDir, { name: "claude-ai" });
    const before = wrapUps();
    const r = await callTool<WrapUp>(client, "wrap_up", { title: "Small talk", points: [] });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ stored: false, reason: expect.stringMatching(/nothing durable/i) });
    expect(r.text).toMatch(/nothing durable.*nothing was stored/i);
    expect(wrapUps()).toEqual(before);
  });

  it("keeps secrets out of the record", async () => {
    const client = await mcp.connect(svc.stateDir, { name: "claude-code" });
    const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const key = `sk-ant-${"x9Y8z7W6v5".repeat(3)}`;
    const r = await callTool<WrapUp>(client, "wrap_up", { title: `Deploy keys ${key}`, points: [`The deploy bot now uses token ${token} for the Nimbus repository.`, "Nimbus deploys run nightly at 02:00."] });
    expect(r.data.stored).toBe(true);
    const doc = readFileSync(join(svc.dataDir, (r.data as { relPath: string }).relPath), "utf8");
    expect(doc).not.toContain(token);
    expect(doc).not.toContain(key);
    expect(doc).toContain("[REDACTED]");
    expect(doc).toContain("Nimbus deploys run nightly at 02:00.");
    expect(doc).toContain("Claude Code");
    // Not in the file name or the answer either.
    expect(JSON.stringify(r.data).toLowerCase()).not.toContain(key.toLowerCase());
    expect(r.text.toLowerCase()).not.toContain(key.toLowerCase());
  });

  it("says how to start Attache when the service is stopped", async () => {
    const stopped = await startTestService();
    await stopped.stop();
    const client = await mcp.connect(stopped.stateDir, { name: "claude-ai" });
    const r = await callTool(client, "wrap_up", { points: ["Something worth keeping."] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Start it with `attache start`");
  });
});
