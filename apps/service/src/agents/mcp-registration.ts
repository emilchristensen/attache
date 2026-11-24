import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { currentOs } from "../platform/os.ts";
import { harnessMcpConfigs } from "../platform/harness-locations.ts";
import { writeConfigText } from "./hooks-config.ts";
import { mcpConfigFormat, type McpServerEntry } from "./mcp-config.ts";
import type { AgentIntegration } from "./integrations.ts";

/** A change to one Harness's MCP configuration, worked out before anything is written. */
export interface McpPlan {
  path: string;
  /** The file's text now; empty for a missing file. */
  before: string;
  /** The text to write; equal to `before` when nothing changes. */
  after: string;
}

/**
 * Attache's MCP server in each Harness's configuration: one entry per Attache
 * install, named after the install, whose command starts `attache mcp` pinned
 * to this install's state folder. Only that entry is ever added, replaced or
 * removed.
 */
export class McpRegistration {
  private readonly stateDir: string;
  private readonly backupDir: string;
  private readonly home: () => string;
  private readonly name: () => string;
  private readonly entry: () => McpServerEntry;

  constructor(opts: { stateDir: string; backupDir: string; home: () => string; name: () => string; entry: () => McpServerEntry }) {
    this.stateDir = opts.stateDir;
    this.backupDir = opts.backupDir;
    this.home = opts.home;
    this.name = opts.name;
    this.entry = opts.entry;
  }

  /** The file a Harness lists its MCP servers in. */
  path(a: AgentIntegration): string {
    return join(this.home(), ...harnessMcpConfigs(currentOs())[a.kind].file.split("/"));
  }

  /** An entry that runs `attache mcp` for this install's state folder, whatever its name. */
  isOurs = (entry: unknown): boolean => {
    const args = (entry as { args?: unknown } | null)?.args;
    if (!Array.isArray(args) || !args.includes("mcp")) return false;
    const i = args.indexOf("--state-dir");
    return i >= 0 && args[i + 1] === this.stateDir;
  };

  /** Same command and arguments; fields a Harness adds on its own (such as `type` or an empty `env`) do not count. */
  sameCommand(e: unknown): boolean {
    const want = this.entry();
    const { command, args } = (e ?? {}) as Partial<McpServerEntry>;
    return command === want.command && Array.isArray(args) && isDeepStrictEqual([...args], want.args);
  }

  private format(a: AgentIntegration) {
    return mcpConfigFormat(harnessMcpConfigs(currentOs())[a.kind].format);
  }

  private read(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** Whether this install's server is listed, and listed exactly as this version would write it. Throws on a file it cannot parse. */
  status(a: AgentIntegration): { path: string; registered: boolean; current: boolean } {
    const path = this.path(a);
    const servers = this.format(a).servers(this.read(path), path);
    const ours = Object.entries(servers).filter(([, e]) => this.isOurs(e));
    const current = ours.length === 1 && ours[0]![0] === this.name() && this.sameCommand(ours[0]![1]);
    return { path, registered: ours.length > 0, current };
  }

  /** The change that registers the server. Throws, before anything is written, on a file Attache must not change. */
  planInstall(a: AgentIntegration): McpPlan {
    const path = this.path(a);
    const before = this.read(path);
    if (this.status(a).current) return { path, before, after: before };
    return { path, before, after: this.format(a).withServer(before, path, this.name(), this.entry(), this.isOurs) };
  }

  /** The change that takes this install's server out. */
  planUninstall(a: AgentIntegration): McpPlan {
    const path = this.path(a);
    const before = this.read(path);
    return { path, before, after: existsSync(path) ? this.format(a).withoutServers(before, path, this.isOurs) : before };
  }

  /** Write a planned change, backing the file up first. Nothing is written when nothing changes. */
  apply(plan: McpPlan): { path: string; backup: string | null; changed: boolean } {
    if (plan.after === plan.before) return { path: plan.path, backup: null, changed: false };
    return { path: plan.path, backup: writeConfigText(plan.path, plan.after, this.backupDir).backup, changed: true };
  }
}
