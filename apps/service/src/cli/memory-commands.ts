import type { MemoryAuditReport } from "@jarvis/contracts";
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

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const AUDIT_USAGE = "Usage: jarvis audit [--stale-days 60] [--json]";

/** `jarvis audit`: the deterministic memory audit, printed for a person or an agent to judge. */
export async function auditCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  if (argv.includes("--help")) return io.out(AUDIT_USAGE);
  const days = flag(argv, "stale-days");
  const client = new ServiceClient(paths);
  const report = await client.get<MemoryAuditReport>(`/memory/audit${days ? `?staleDays=${encodeURIComponent(days)}` : ""}`);
  if (argv.includes("--json")) return io.out(JSON.stringify(report));
  const roots = new Map((await client.get<Array<{ root: string; path: string }>>("/memory/roots")).map((r) => [r.root, r.path]));
  io.out(renderAudit(auditView(report, (root, rel) => join(roots.get(root) ?? root, ...rel.split("/"))), { dataFolder: report.dataFolder }));
}
