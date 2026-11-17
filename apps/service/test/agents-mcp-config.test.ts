import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { mcpConfigFormat, type McpServerEntry } from "../src/agents/mcp-config.ts";
import { HooksFileError } from "../src/agents/hooks-config.ts";

const STATE = "/Users/owner/Library/Application Support/Attache/state";
const ours: McpServerEntry = { command: "/opt/attache/current/runtime/node", args: ["/opt/attache/current/service/attache-service.mjs", "mcp", "--state-dir", STATE] };
const isOurs = (e: unknown) => Array.isArray((e as McpServerEntry)?.args) && (e as McpServerEntry).args.includes(STATE);
const FILE = "/home/owner/.codex/config.toml";

describe("MCP servers in a TOML config (Codex)", () => {
  const toml = mcpConfigFormat("toml");
  const theirs = `model = "gpt-5" # pinned

[mcp_servers.rea]
command = "rea"

[mcp_servers.rea.env]
REA_HOME = "/opt/rea"
`;

  it("adds Attache's server as its own table and leaves the rest of the text as it was", () => {
    const next = toml.withServer(theirs, FILE, "attache", ours, isOurs);
    expect(next.startsWith(theirs)).toBe(true);
    expect(parseToml(next)).toEqual({ model: "gpt-5", mcp_servers: { rea: { command: "rea", env: { REA_HOME: "/opt/rea" } }, attache: ours } });
    expect(toml.servers(next, FILE)).toMatchObject({ attache: ours });
  });

  it("removing Attache's server gives back the exact text, even with tables and comments after it", () => {
    const middle = `[mcp_servers.attache]\ncommand = "old"\nargs = ["mcp", "--state-dir", "${STATE}"]\n\n[mcp_servers.attache.env]\nX = "1"\n\n`;
    const after = `# Railway, added by hand\n[mcp_servers.railway]\ncommand = "npx"\n`;
    expect(toml.withoutServers(`${theirs}\n${middle}${after}`, FILE, isOurs)).toBe(`${theirs}\n${after}`);
    expect(toml.withoutServers(toml.withServer(theirs, FILE, "attache", ours, isOurs), FILE, isOurs)).toBe(theirs);
  });

  it("replaces an older Attache entry instead of adding a second one", () => {
    const once = toml.withServer(theirs, FILE, "attache", { ...ours, command: "/old/node" }, isOurs);
    const twice = toml.withServer(once, FILE, "attache", ours, isOurs);
    expect((parseToml(twice).mcp_servers as Record<string, unknown>).attache).toEqual(ours);
    expect(twice.match(/\[mcp_servers\.attache\]/g)).toHaveLength(1);
  });

  it("works on a missing or empty file, and on one without a final newline", () => {
    expect(parseToml(toml.withServer("", FILE, "attache", ours, isOurs))).toEqual({ mcp_servers: { attache: ours } });
    const next = toml.withServer('model = "gpt-5"', FILE, "attache", ours, isOurs);
    expect(parseToml(next)).toEqual({ model: "gpt-5", mcp_servers: { attache: ours } });
  });

  it("refuses a file that is not valid TOML", () => {
    expect(() => toml.withServer("model = ", FILE, "attache", ours, isOurs)).toThrow(HooksFileError);
    expect(() => toml.withServer("model = ", FILE, "attache", ours, isOurs)).toThrow(/config\.toml is not valid TOML .*Attache will not change it/);
  });

  it("refuses to replace a server under Attache's name that Attache did not add", () => {
    const mine = `${theirs}\n[mcp_servers.attache]\ncommand = "my-own"\n`;
    expect(() => toml.withServer(mine, FILE, "attache", ours, isOurs)).toThrow(/already has an MCP server named "attache" that Attache did not add/);
  });

  it("refuses to edit Attache's server when it is written in a form Attache cannot take out on its own", () => {
    const inline = `mcp_servers = { attache = { command = "node", args = ["mcp", "--state-dir", "${STATE}"] }, rea = { command = "rea" } }\n`;
    expect(() => toml.withoutServers(inline, FILE, isOurs)).toThrow(/cannot change without touching other entries/);
    expect(() => toml.withServer(`mcp_servers = { rea = { command = "rea" } }\n`, FILE, "attache", ours, isOurs)).toThrow(/cannot change without touching other entries/);
  });

  it("refuses an mcp_servers value that is not a table", () => {
    expect(() => toml.withServer('mcp_servers = "none"\n', FILE, "attache", ours, isOurs)).toThrow(/not a table/);
  });
});

describe("MCP servers in a JSON config", () => {
  const json = mcpConfigFormat("json");
  const path = "/home/owner/.claude.json";
  const theirs = { numStartups: 3, mcpServers: { granola: { type: "http", url: "https://example.com/mcp" } } };

  it("adds and removes only Attache's server", () => {
    const next = json.withServer(JSON.stringify(theirs), path, "attache", ours, isOurs);
    expect(JSON.parse(next)).toEqual({ ...theirs, mcpServers: { ...theirs.mcpServers, attache: ours } });
    expect(JSON.parse(json.withoutServers(next, path, isOurs))).toEqual(theirs);
    expect(JSON.parse(json.withServer("", path, "attache", ours, isOurs))).toEqual({ mcpServers: { attache: ours } });
  });

  it("drops the mcpServers object once Attache's server was the last one in it", () => {
    const next = json.withServer(JSON.stringify({ numStartups: 3 }), path, "attache", ours, isOurs);
    expect(JSON.parse(json.withoutServers(next, path, isOurs))).toEqual({ numStartups: 3 });
  });

  it("refuses invalid JSON, a value that is not an object, and an entry under Attache's name it did not add", () => {
    expect(() => json.withServer("{ // comment", path, "attache", ours, isOurs)).toThrow(/not valid JSON.*Attache will not change it/);
    expect(() => json.withServer(JSON.stringify({ mcpServers: [] }), path, "attache", ours, isOurs)).toThrow(/mcpServers.*not an object/);
    expect(() => json.withServer(JSON.stringify({ mcpServers: { attache: { command: "mine" } } }), path, "attache", ours, isOurs)).toThrow(/already has an MCP server named "attache" that Attache did not add/);
  });
});
