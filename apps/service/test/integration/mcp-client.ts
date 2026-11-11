import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

const MAIN = join(import.meta.dirname, "../../src/main.ts");

/** Variables a Harness sets for the processes it starts; the test runner may itself run inside one. */
const HARNESS_ENV = /^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/;

export interface HarnessClientOptions {
  /** The client name the Harness reports when it connects. */
  name?: string;
  /** The client title the Harness reports when it connects. */
  title?: string;
  /** The folder the Harness starts the server in, as a Harness does with its working folder. */
  cwd?: string;
  /** Environment the Harness gives the server, on top of a clean one. */
  env?: Record<string, string>;
  /** How the owner answers a confirmation request. Without it the client cannot show one. */
  confirm?: (request: ElicitRequest["params"]) => ElicitResult | Promise<ElicitResult>;
  /** Claim the confirmation request without handling it, as a Harness that advertises more than it does. */
  claimsConfirmation?: boolean;
}

/** Clients a test file opened, closed together when it ends. */
export interface McpClients {
  /**
   * Start Jarvis's MCP server the way a Harness does: the `jarvis` executable
   * with `mcp` as a child process over stdio, with no token in its command or
   * environment.
   */
  connect(stateDir: string, opts?: HarnessClientOptions): Promise<Client>;
  /** Start the server a Harness configuration names, exactly as that Harness would: its command and arguments. */
  connectRegistered(entry: RegisteredServer, opts?: HarnessClientOptions): Promise<Client>;
  closeAll(): Promise<void>;
}

/** An MCP server entry in a Harness's configuration. */
export interface RegisteredServer {
  command: string;
  args: string[];
}

export function mcpClients(): McpClients {
  const open: Client[] = [];
  const track = (client: Client) => {
    open.push(client);
    return client;
  };
  return {
    connect: async (stateDir, opts = {}) => track(await connectHarness({ command: process.execPath, args: [MAIN, "mcp", "--state-dir", stateDir] }, opts)),
    connectRegistered: async (entry, opts = {}) => track(await connectHarness(entry, opts)),
    async closeAll() {
      await Promise.all(open.splice(0).map((c) => c.close()));
    },
  };
}

async function connectHarness(server: RegisteredServer, opts: HarnessClientOptions): Promise<Client> {
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !HARNESS_ENV.test(e[0])));
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { ...base, ...opts.env }, ...(opts.cwd ? { cwd: opts.cwd } : {}), stderr: "pipe" });
  const info = { name: opts.name ?? "test-harness", version: "1.0.0", ...(opts.title ? { title: opts.title } : {}) };
  const client = new Client(info, { capabilities: opts.confirm || opts.claimsConfirmation ? { elicitation: { form: {} } } : {} });
  const confirm = opts.confirm;
  if (confirm) client.setRequestHandler(ElicitRequestSchema, async (req) => confirm(req.params));
  await client.connect(transport);
  return client;
}

export interface ToolReply<T> {
  isError: boolean;
  text: string;
  data: T;
}

export async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply<T>> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  return { isError: r.isError === true, text: content.map((c) => c.text).join("\n"), data: r.structuredContent as T };
}

/** The text of every message a prompt returns, joined. */
export async function promptText(client: Client, name: string, args: Record<string, string> = {}): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  return messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
}
