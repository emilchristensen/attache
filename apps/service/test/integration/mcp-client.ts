import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAIN = join(import.meta.dirname, "../../src/main.ts");

/** What a Harness reports about itself when it connects, e.g. `claude-ai` for Claude Desktop. */
export interface HarnessInfo {
  name: string;
  version?: string;
  title?: string;
}

const open: Client[] = [];

/**
 * Start Jarvis's MCP server the way a Harness does: the `jarvis` executable
 * with `mcp` as a child process over stdio, with no token in its command or
 * environment. The Harness's own session variables are left out, so the
 * server cannot learn anything from the test runner's environment.
 */
export async function connectMcp(stateDir: string, harness: HarnessInfo = { name: "test-harness" }): Promise<Client> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(e[0])));
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--state-dir", stateDir], env, stderr: "pipe" });
  const client = new Client({ version: "1.0.0", ...harness });
  await client.connect(transport);
  open.push(client);
  return client;
}

/** Close every client `connectMcp` opened, which ends their server processes. */
export async function closeMcpClients(): Promise<void> {
  await Promise.all(open.splice(0).map((c) => c.close()));
}

export async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: T }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  return { isError: r.isError === true, text: content.map((c) => c.text).join("\n"), data: r.structuredContent as T };
}
