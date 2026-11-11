import { jsonMcpConfig } from "./mcp-config-json.ts";
import { tomlMcpConfig } from "./mcp-config-toml.ts";
import type { McpConfigFormat } from "./mcp-config-format.ts";

export type { IsOurServer, McpConfigFormat, McpServerEntry } from "./mcp-config-format.ts";

/** The file formats Harnesses keep their MCP servers in. */
export type McpConfigKind = "json" | "toml";

/** The editor for a Harness's MCP configuration format. */
export function mcpConfigFormat(kind: McpConfigKind): McpConfigFormat {
  return kind === "toml" ? tomlMcpConfig : jsonMcpConfig;
}
