import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

// After an Update, a Harness keeps the MCP server it started before the Update:
// the old version's code, talking to the newer service. These tests start the
// server at a chosen version (`ATTACHE_VERSION`, as a release build sets it)
// against a test service that reports its own.

let svc: TestService;
let serviceVersion: string;
const mcp = mcpClients();

/** An MCP server of `version`, started the way a Harness starts it. */
const serverAt = (version: string) => mcp.connect(svc.stateDir, { env: { ATTACHE_VERSION: version } });

const UPDATED = "Attache was updated";

/** The text of each reply to a search, in the order the calls were made. */
async function searches(client: Client, count: number): Promise<string[]> {
  const texts: string[] = [];
  for (let i = 0; i < count; i++) texts.push((await callTool(client, "search", { query: "Orion" })).text);
  return texts;
}

beforeAll(async () => {
  svc = await startTestService();
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }] }] });
  serviceVersion = (await svc.get<{ version: string }>("/health")).version;
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("An open Harness session after an Update", () => {
  it("is told once, in the next tool result, that Attache was updated and that a new session has the latest tools", async () => {
    const client = await serverAt("0.0.1");
    const [first, ...rest] = await searches(client, 3);
    expect(first).toContain(`${UPDATED} to ${serviceVersion} after this session started, so this session still has the tools of 0.0.1. A new session has the latest tools.`);
    // The tool still answers: the notice comes on top of the result.
    expect(first).toContain("memory/projects/orion-migration.md");
    expect(rest.filter((t) => t.includes(UPDATED))).toEqual([]);
    // Other tools in the same session do not repeat it.
    expect((await callTool(client, "read", { path: "memory/projects/orion-migration.md" })).text).not.toContain(UPDATED);
  });

  it("is told in exactly one result when several tool calls run at once", async () => {
    const client = await serverAt("0.0.1");
    const replies = await Promise.all(Array.from({ length: 4 }, () => callTool(client, "search", { query: "Orion" })));
    expect(replies.filter((r) => r.text.includes(UPDATED))).toHaveLength(1);
  });

  it("is told again in each new session that still runs an older version", async () => {
    const first = await serverAt("0.0.1");
    const second = await serverAt("0.0.1");
    expect((await searches(first, 1))[0]).toContain(UPDATED);
    expect((await searches(second, 1))[0]).toContain(UPDATED);
  });

  it("orders prerelease versions below their release", async () => {
    // A prerelease of the service's release: below it whether the service runs x.y.z or x.y.z-beta.N.
    const older = `${serviceVersion.replace(/-.*$/, "")}-alpha.1`;
    const client = await serverAt(older);
    expect((await searches(client, 1))[0]).toContain(`${UPDATED} to ${serviceVersion} after this session started, so this session still has the tools of ${older}.`);
  });

  it("is never told anything when the MCP server runs the service's version", async () => {
    const client = await serverAt(serviceVersion);
    expect((await searches(client, 3)).filter((t) => t.includes(UPDATED))).toEqual([]);
    expect((await callTool(client, "read", { path: "memory/projects/orion-migration.md" })).text).not.toContain(UPDATED);
  });

  it("is never told anything when the MCP server is newer than the service", async () => {
    const client = await serverAt("999.0.0");
    expect((await searches(client, 2)).filter((t) => t.includes(UPDATED))).toEqual([]);
  });
});
