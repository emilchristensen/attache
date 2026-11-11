import { HooksFileError } from "./hooks-config.ts";
import { foreignEntryError, isPlainObject, ourNames, type IsOurServer, type McpConfigFormat } from "./mcp-config-format.ts";

/** `{ "mcpServers": { "<name>": { command, args } } }`: Claude Code (`~/.claude.json`), Claude Desktop and Antigravity. */
const KEY = "mcpServers";

function parse(text: string, path: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); Jarvis will not change it.`);
  }
  if (!isPlainObject(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; Jarvis will not change it.`);
  return parsed;
}

function serversOf(settings: Record<string, unknown>, path: string): Record<string, unknown> {
  const servers = settings[KEY];
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) throw new HooksFileError(`${path} has an \`${KEY}\` value that is not an object; Jarvis will not change it.`);
  return servers;
}

const render = (settings: Record<string, unknown>) => JSON.stringify(settings, null, 2) + "\n";

/** The settings without this install's entries; the list itself goes when Jarvis's entry was its last. */
function without(settings: Record<string, unknown>, path: string, isOurs: IsOurServer): Record<string, unknown> {
  const servers = serversOf(settings, path);
  const drop = new Set(ourNames(servers, isOurs));
  if (!drop.size) return settings;
  const kept = Object.fromEntries(Object.entries(servers).filter(([k]) => !drop.has(k)));
  const { [KEY]: _servers, ...rest } = settings;
  return Object.keys(kept).length ? { ...rest, [KEY]: kept } : rest;
}

export const jsonMcpConfig: McpConfigFormat = {
  servers: (text, path) => serversOf(parse(text, path), path),
  withServer(text, path, name, entry, isOurs) {
    const base = without(parse(text, path), path, isOurs);
    const servers = serversOf(base, path);
    if (name in servers) throw foreignEntryError(path, name);
    return render({ ...base, [KEY]: { ...servers, [name]: entry } });
  },
  withoutServers(text, path, isOurs) {
    const settings = parse(text, path);
    const next = without(settings, path, isOurs);
    return next === settings ? text : render(next);
  },
};
