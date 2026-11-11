import { HooksFileError } from "./hooks-config.ts";

/** How a Harness starts Jarvis's MCP server: a local process over stdio. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Recognises the entry of this Jarvis install, whatever name it is listed under. */
export type IsOurServer = (entry: unknown) => boolean;

/**
 * Editing the MCP server list in a Harness's configuration file. Every
 * function takes and returns the file's whole text, and changes only
 * Jarvis's own entry: other servers and every other setting are kept as they
 * were. A file that cannot be parsed, or an entry under Jarvis's name that
 * Jarvis did not add, is refused with a `HooksFileError`.
 */
export interface McpConfigFormat {
  /** The servers the file lists, by name. */
  servers(text: string, path: string): Record<string, unknown>;
  /** The text with Jarvis's entry set to `entry` under `name`, replacing any earlier entry of this install. */
  withServer(text: string, path: string, name: string, entry: McpServerEntry, isOurs: IsOurServer): string;
  /** The text without any entry of this install. Unchanged when there is none. */
  withoutServers(text: string, path: string, isOurs: IsOurServer): string;
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

export function foreignEntryError(path: string, name: string): HooksFileError {
  return new HooksFileError(`${path} already has an MCP server named "${name}" that Jarvis did not add; Jarvis will not change it. Remove or rename that entry, then connect again.`);
}

/** Names of this install's entries in a server list. */
export const ourNames = (servers: Record<string, unknown>, isOurs: IsOurServer): string[] => Object.keys(servers).filter((k) => isOurs(servers[k]));
