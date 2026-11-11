import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const MAIN = join(import.meta.dirname, "../../src/main.ts");

/** Clients a test file opened, closed together when it ends. */
export interface McpClients {
  /**
   * Start Jarvis's MCP server the way a Harness does: the `jarvis` executable
   * with `mcp` as a child process over stdio, with no token in its command or
   * environment.
   */
  connect(stateDir: string): Promise<Client>;
  closeAll(): Promise<void>;
}

export function mcpClients(): McpClients {
  const open: Client[] = [];
  return {
    async connect(stateDir) {
      const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(e[0])));
      const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--state-dir", stateDir], env, stderr: "pipe" });
      const client = new Client({ name: "test-harness", version: "1.0.0" });
      await client.connect(transport);
      open.push(client);
      return client;
    },
    async closeAll() {
      await Promise.all(open.map((c) => c.close()));
    },
  };
}

export async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: T }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  return { isError: r.isError === true, text: content.map((c) => c.text).join("\n"), data: r.structuredContent as T };
}

/** The text of every message a prompt returns, joined. */
export async function promptText(client: Client, name: string, args: Record<string, string> = {}): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  return messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
}
