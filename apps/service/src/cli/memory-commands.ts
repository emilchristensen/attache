import type { MemoryAuditReport } from "@attache/contracts";
import type { ServicePaths } from "../core/paths.ts";
import { ServiceClient } from "./client.ts";
import { auditView, renderAudit } from "../memory/audit-view.ts";
import { join } from "node:path";

/**
 * What the read-only memory commands need from the terminal. There is no save
 * command: a save is confirmed by the owner in a Harness, through MCP, which a
 * shell cannot do.
 */
export interface CliIo {
  out(s: string): void;
  cwd: string;
}

export const AUDIT_USAGE = `Usage: attache audit [--json]

Lists every current fact in the Brain with its date, Review date, source and flags.
A fact is flagged stale only when it is past its Review date.`;

/** `attache audit`: the deterministic memory audit, printed for a person or an agent to judge. */
export async function auditCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  if (argv.includes("--help")) return io.out(AUDIT_USAGE);
  const unknown = unknownAuditOption(argv.slice(1));
  if (unknown) throw new Error(`Unknown option ${unknown}.\n\n${AUDIT_USAGE}`);
  const client = new ServiceClient(paths);
  const report = await client.get<MemoryAuditReport>("/memory/audit");
  if (argv.includes("--json")) return io.out(JSON.stringify(report));
  const roots = new Map((await client.get<Array<{ root: string; path: string }>>("/memory/roots")).map((r) => [r.root, r.path]));
  io.out(renderAudit(auditView(report, (root, rel) => join(roots.get(root) ?? root, ...rel.split("/"))), { dataFolder: report.dataFolder }));
}

/** The first argument `attache audit` does not take, if any; `--state-dir <folder>` is the global option every command takes. */
function unknownAuditOption(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--state-dir") i++;
    else if (a !== "--json") return a;
  }
  return null;
}
