import { parse, stringify } from "smol-toml";
import { HooksFileError } from "./hooks-config.ts";
import { foreignEntryError, isPlainObject, ourNames, type IsOurServer, type McpConfigFormat } from "./mcp-config-format.ts";

/**
 * `[mcp_servers.<name>]` tables in a TOML file (Codex's `~/.codex/config.toml`).
 *
 * TOML has no editor that keeps comments and layout, so Jarvis edits the text:
 * it takes out the tables of its own entry and appends a fresh one. A real
 * parser checks the file before the edit, and checks afterwards that the only
 * change is Jarvis's entry; anything else is refused rather than written.
 */
const KEY = "mcp_servers";

function parseToml(text: string, path: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new HooksFileError(`${path} is not valid TOML (${(e as Error).message.split("\n")[0]}); Jarvis will not change it.`);
  }
}

function serversOf(doc: Record<string, unknown>, path: string): Record<string, unknown> {
  const servers = doc[KEY];
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) throw new HooksFileError(`${path} has an \`${KEY}\` value that is not a table; Jarvis will not change it.`);
  return servers;
}

const cannotEdit = (path: string) =>
  new HooksFileError(`${path} lists MCP servers in a form Jarvis cannot change without touching other entries (an inline table or dotted keys); Jarvis will not change it. Write each server as its own [${KEY}.<name>] table, then connect again.`);

/** The document with `servers` as its server list; no list at all when it is empty. */
function withServers(doc: Record<string, unknown>, servers: Record<string, unknown>): Record<string, unknown> {
  const { [KEY]: _servers, ...rest } = doc;
  return Object.keys(servers).length ? { ...rest, [KEY]: servers } : rest;
}

/** A form of a parsed document that compares equal whatever the key order and value classes. */
function canonical(v: unknown): unknown {
  if (v instanceof Date) return { date: v.toISOString() };
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** Whether `text` parses to exactly `expected`; Jarvis writes nothing else. */
function parsesTo(text: string, expected: Record<string, unknown>): boolean {
  try {
    const actual = parse(text) as Record<string, unknown>;
    return JSON.stringify(canonical(withServers(actual, serversOf(actual, "")))) === JSON.stringify(canonical(expected));
  } catch {
    return false;
  }
}

const isBlank = (line: string) => !line.trim();
const isBlankOrComment = (line: string) => isBlank(line) || line.trim().startsWith("#");

/** The key path a table header line opens (`[a."b".c]` → a, b, c), or null when the line is no header. */
function headerPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  let cur: unknown;
  try {
    cur = parse(trimmed);
  } catch {
    return null;
  }
  const path: string[] = [];
  while (isPlainObject(cur) && Object.keys(cur).length === 1) {
    const key = Object.keys(cur)[0]!;
    path.push(key);
    cur = cur[key];
    if (Array.isArray(cur)) cur = cur[0];
  }
  return path.length ? path : null;
}

/** Line ranges `[first, last]` of the tables that hold the named servers, in file order. */
function tableRanges(lines: string[], names: Set<string>): Array<[number, number]> {
  const headers = lines.flatMap((line, i) => {
    const path = headerPath(line);
    return path ? [{ line: i, path }] : [];
  });
  return headers.flatMap((h, i): Array<[number, number]> => {
    if (h.path[0] !== KEY || !names.has(h.path[1] ?? "")) return [];
    // A comment just above the next table belongs to that table.
    let last = (headers[i + 1]?.line ?? lines.length) - 1;
    while (last > h.line && isBlankOrComment(lines[last]!)) last--;
    return [[h.line, last]];
  });
}

/**
 * The lines without the tables of the named servers. Tables separated only by
 * blank lines go as one run, and a run that followed a blank line takes the
 * blank lines after it too, so the file does not gain gaps.
 */
function withoutTables(lines: string[], names: Set<string>): string[] {
  const runs: Array<[number, number]> = [];
  for (const [first, last] of tableRanges(lines, names)) {
    const prev = runs.at(-1);
    if (prev && lines.slice(prev[1] + 1, first).every(isBlank)) runs[runs.length - 1] = [prev[0], last];
    else runs.push([first, last]);
  }
  const drop = new Set<number>();
  for (const [first, last] of runs) {
    let end = last;
    if (first === 0 || isBlank(lines[first - 1]!)) while (end + 1 < lines.length && isBlank(lines[end + 1]!)) end++;
    for (let i = first; i <= end; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i));
}

function without(text: string, path: string, isOurs: IsOurServer): string {
  const doc = parseToml(text, path);
  const servers = serversOf(doc, path);
  const ours = new Set(ourNames(servers, isOurs));
  if (!ours.size) return text;
  const next = withoutTables(text.split("\n"), ours).join("\n");
  const kept = Object.fromEntries(Object.entries(servers).filter(([k]) => !ours.has(k)));
  if (!parsesTo(next, withServers(doc, kept))) throw cannotEdit(path);
  return next;
}

export const tomlMcpConfig: McpConfigFormat = {
  servers: (text, path) => serversOf(parseToml(text, path), path),
  withServer(text, path, name, entry, isOurs) {
    const base = without(text, path, isOurs);
    const doc = parseToml(base, path);
    const servers = serversOf(doc, path);
    if (name in servers) throw foreignEntryError(path, name);
    const separator = !base.trim() ? "" : base.endsWith("\n") ? "\n" : "\n\n";
    const next = `${base.trim() ? base : ""}${separator}${stringify({ [KEY]: { [name]: entry } })}`;
    if (!parsesTo(next, withServers(doc, { ...servers, [name]: entry }))) throw cannotEdit(path);
    return next;
  },
  withoutServers: without,
};
