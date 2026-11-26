import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isNewerVersion } from "../updates/version.ts";

/** What the agent is told, in the glossary's words, naming only the two versions this server has seen. */
export function updateNoticeText(serviceVersion: string, ownVersion: string): string {
  return `Attache was updated to ${serviceVersion} after this session started, so this session still has the tools of ${ownVersion}. A new session has the latest tools.`;
}

/**
 * After an Update, a Harness keeps the MCP server it started before it: the
 * earlier version's code, still working through `/api/v1`. Every tool call
 * asks the service for its version alongside the call, and the first result
 * after the service reports a newer version than this server's carries the
 * notice. A session is told once; after that the server stops asking.
 */
export function withUpdateNotice(server: McpServer, ownVersion: string, serviceVersion: () => Promise<string>): McpServer {
  let told = false;

  /** The newer version the service reports, or null. */
  const newerService = async (): Promise<string | null> => {
    if (told) return null;
    try {
      const reported = await serviceVersion();
      return isNewerVersion(reported, ownVersion) ? reported : null;
    } catch {
      // Safe to skip: a service that cannot answer fails the tool call itself with
      // how to start it, and the next call asks again.
      return null;
    }
  };

  const addNotice = async (call: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const [result, newer] = await Promise.all([call(), newerService()]);
    // Checked and set in one step after both settle, so of calls running at once only one is told.
    if (newer === null || told) return result;
    told = true;
    return { ...result, content: [...result.content, { type: "text", text: updateNoticeText(newer, ownVersion) }] };
  };

  const register = server.registerTool.bind(server);
  const registerTool: McpServer["registerTool"] = (name, config, callback) =>
    register(name, config, ((...args: unknown[]) => addNotice(async () => (callback as (...a: unknown[]) => CallToolResult | Promise<CallToolResult>)(...args))) as typeof callback);
  return Object.assign(server, { registerTool });
}
