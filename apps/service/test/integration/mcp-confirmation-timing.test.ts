import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, isJSONRPCNotification, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { serviceBrain } from "../../src/mcp/brain.ts";
import { CONFIRMATION_TIMEOUT_MS, FASTEST_PERSON_MS } from "../../src/mcp/confirmation.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, type TestService } from "./harness.ts";
import { callTool } from "./mcp-client.ts";

// How long the owner takes to answer is the behaviour under test, so these
// Harnesses talk to Attache's MCP server in this process, over the SDK's
// in-memory transport, with a clock the test moves: no test waits minutes.

type SaveReply = { outcome: "saved" | "declined" | "proposed"; cannotAsk?: string; proposals?: Array<{ id: string; target: string }> };
type Proposal = { id: string; reason: string; item: { title?: string } };

const CLAUDE_CODE_SESSION = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "timing-session-3" };

let svc: TestService;
const open: Client[] = [];

/**
 * A Claude Code session that shows Attache's confirmation through `answer`,
 * timed by `clock`. `received` lists the method of every notification Attache
 * sends it.
 */
async function harness(clock: ManualClock, answer: (request: ElicitRequest["params"]) => Promise<ElicitResult>): Promise<{ client: Client; received: string[] }> {
  const server = createMcpServer(serviceBrain(svc.app.paths), { version: "test", instructions: "", context: { env: CLAUDE_CODE_SESSION, cwd: process.cwd() }, clock });
  const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, (req) => answer(req.params));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const received: string[] = [];
  const deliver = clientSide.onmessage!;
  clientSide.onmessage = (message, extra) => {
    if (isJSONRPCNotification(message)) received.push(message.method);
    deliver(message, extra);
  };
  open.push(client);
  return { client, received };
}

const note = (title: string) => ({ items: [{ action: "create", type: "note", title, facts: [{ subject: "Idea", value: `${title} matters` }] }] });
const brainFile = (rel: string) => (existsSync(join(svc.dataDir, rel)) ? readFileSync(join(svc.dataDir, rel), "utf8") : null);

async function proposalsOf(reply: SaveReply): Promise<Proposal[]> {
  const { proposals } = await svc.get<{ proposals: Proposal[] }>("/memory/proposals?status=proposed");
  return proposals.filter((p) => reply.proposals!.some((x) => x.id === p.id));
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  // These saves go through the owner's confirmation, so Claude Code's auto-accept is off.
  mkdirSync(join(process.env.ATTACHE_AGENT_HOME!, ".claude"), { recursive: true });
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
});
afterAll(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  await svc?.stop();
});

describe("MCP save when nobody answers the confirmation", () => {
  it("stores Proposals after two minutes, withdraws the request, and asks nobody for later saves on that connection", async () => {
    const clock = new ManualClock();
    const asked: Array<ElicitRequest["params"]> = [];
    const { client, received } = await harness(clock, (request) => (asked.push(request), new Promise<never>(() => {})));

    const first = callTool<SaveReply>(client, "save", note("Unseen plan"));
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await clock.advance(CONFIRMATION_TIMEOUT_MS);
    const r = await first;

    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ outcome: "proposed", cannotAsk: "unanswered" });
    expect(r.text).toContain("Nobody answered Attache's confirmation on this connection within 2 minutes");
    expect(r.text).toContain("waits in the Attache Dashboard");
    expect(r.text).not.toMatch(/declined/i);
    // The Harness is told to withdraw the request it never answered.
    await vi.waitFor(() => expect(received).toContain("notifications/cancelled"));
    const [proposal] = await proposalsOf(r.data);
    expect(proposal!.item.title).toBe("Unseen plan");
    expect(proposal!.reason).toBe("Claude Code asked to save this, but nobody answered the confirmation within 2 minutes, so it waits for your review.");
    expect(brainFile("memory/notes/unseen-plan.md")).toBeNull();

    const second = await callTool<SaveReply>(client, "save", note("Second unseen plan"));
    expect(asked).toHaveLength(1);
    expect(second.data).toMatchObject({ outcome: "proposed", cannotAsk: "unanswered" });
    expect((await proposalsOf(second.data)).map((p) => p.item.title)).toEqual(["Second unseen plan"]);

    // A new connection asks again.
    const fresh: Array<ElicitRequest["params"]> = [];
    const { client: other } = await harness(clock, async (request) => (fresh.push(request), await clock.advance(FASTEST_PERSON_MS), { action: "accept" }));
    expect((await callTool<SaveReply>(other, "save", note("Seen plan"))).data.outcome).toBe("saved");
    expect(fresh).toHaveLength(1);
  });
});

describe("MCP save when the confirmation is declined", () => {
  it("counts a decline or close within a second as a Harness that cannot ask, and stores Proposals", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const clock = new ManualClock();
      const { client } = await harness(clock, async () => (await clock.advance(FASTEST_PERSON_MS - 1), { action }));
      const r = await callTool<SaveReply>(client, "save", note(`Quick ${action}`));
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ outcome: "proposed", cannotAsk: "instant" });
      expect(r.text).toContain("This Harness answered the confirmation faster than a person could, so the owner never saw it.");
      expect(r.text).not.toMatch(/declined/i);
      const [proposal] = await proposalsOf(r.data);
      expect(proposal!.reason).toBe("Claude Code asked to save this, but it answered the confirmation faster than a person could, so nobody saw it. It waits for your review.");
      expect(brainFile(`memory/notes/quick-${action}.md`)).toBeNull();
    }
  });

  it("takes a decline or close after a second or more as the owner's, and writes nothing", async () => {
    const before = (await svc.get<{ proposals: Proposal[] }>("/memory/proposals?status=proposed")).proposals.length;
    for (const action of ["decline", "cancel"] as const) {
      const clock = new ManualClock();
      const { client } = await harness(clock, async () => (await clock.advance(FASTEST_PERSON_MS), { action }));
      const r = await callTool<SaveReply>(client, "save", note(`Read and ${action}`));
      expect(r.data.outcome).toBe("declined");
      expect(r.text).toContain("nothing was written");
      expect(brainFile(`memory/notes/read-and-${action}.md`)).toBeNull();
    }
    expect((await svc.get<{ proposals: Proposal[] }>("/memory/proposals?status=proposed")).proposals.length).toBe(before);
  });
});
