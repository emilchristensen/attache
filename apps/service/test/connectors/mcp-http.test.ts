import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpHttpClient } from "../../src/connectors/mcp-http.ts";

// A server that answers with SSE headers and then never finishes the body.
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
    res.write(": keep-alive\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const auth = { header: async () => "Bearer t" };

describe("MCP HTTP client", () => {
  it("a stalled response body times out as offline instead of hanging", async () => {
    const c = new McpHttpClient(url, auth, new AbortController().signal, { timeoutMs: 300 });
    await expect(c.initialize()).rejects.toMatchObject({ state: "offline", message: expect.stringMatching(/did not answer/) });
  });

  it("cancellation stops a stalled body read", async () => {
    const ctrl = new AbortController();
    const c = new McpHttpClient(url, auth, ctrl.signal, { timeoutMs: 30_000 });
    setTimeout(() => ctrl.abort(), 200);
    await expect(c.initialize()).rejects.toThrow(/Cancelled/);
  });
});
