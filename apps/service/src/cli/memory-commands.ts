import { readFileSync } from "node:fs";
import { MemorySaveInput, type MemoryAuditReport, type MemorySaveResult } from "@jarvis/contracts";
import type { ServicePaths } from "../core/paths.ts";
import { ServiceClient } from "./client.ts";
import { agentFromEnv } from "./agent-env.ts";

const MAX_INPUT_BYTES = 1_000_000;

export interface CliIo {
  out(s: string): void;
  readStdin(): string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const SAVE_USAGE = `Usage: jarvis save [--file items.json] [--agent <agent>] [--session <id>] [--json]

Reads the items to save as JSON from stdin (or --file):
  { "items": [
      { "action": "create", "type": "decision", "title": "…", "facts": [{ "subject": "Decision", "value": "…" }], "notes": "why", "events": ["…"] },
      { "action": "update", "path": "memory/projects/x.md", "facts": [{ "subject": "Status", "value": "…", "reason": "…" }], "events": ["…"] }
  ] }
Facts are current state and replace the subject's old value (kept in History); events are appended to History.
A project's "Repositories" fact lists its git repositories (owner/name, host/owner/name or remote addresses, separated by commas);
sessions started in one of them get that project's context.`;

/** `jarvis save`: send distilled items to the running service, which validates them all and writes them as curated memory. */
export async function saveCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  if (argv.includes("--help")) return io.out(SAVE_USAGE);
  const file = flag(argv, "file");
  const raw = (file && file !== "-" ? readFileSync(file, "utf8") : io.readStdin()).slice(0, MAX_INPUT_BYTES);
  if (!raw.trim()) throw new Error(`Nothing to save: no JSON on stdin.\n\n${SAVE_USAGE}`);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The items are not valid JSON: ${(e as Error).message}`);
  }
  const detected = agentFromEnv(io.env);
  const agent = flag(argv, "agent") ?? detected?.agent;
  const sessionId = flag(argv, "session") ?? detected?.sessionId;
  const withOrigin = { ...(agent ? { origin: { agent, ...(sessionId ? { sessionId } : {}), cwd: io.cwd } } : {}), ...(body as Record<string, unknown>) };
  const parsed = MemorySaveInput.safeParse(withOrigin);
  if (!parsed.success) throw new Error(`The items do not match what Jarvis saves:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}\n\n${SAVE_USAGE}`);
  const result = await new ServiceClient(paths).post<MemorySaveResult>("/memory/save", parsed.data);
  if (argv.includes("--json")) return io.out(JSON.stringify(result));
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  io.out(result.saved.map((s) => `${s.action === "created" ? "Created" : "Updated"} ${s.title} (${count(s.facts, "fact")}, ${count(s.events, "event")})\n    ${s.absPath}`).join("\n"));
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
  io.out(renderAudit(report, roots));
}

export function renderAudit(r: MemoryAuditReport, roots: Map<string, string>): string {
  const counts = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  const lines = [`Jarvis memory audit: ${r.notes} notes, ${r.entries} current facts, stale after ${r.staleDays} days`, `Data folder: ${r.dataFolder}`, `Flags: ${counts || "none"}`];
  if (r.possibleDuplicates.length) {
    lines.push("", "Possible duplicate notes:");
    for (const d of r.possibleDuplicates) lines.push(`- ${d.title}: ${d.relPaths.join(", ")}`);
  }
  for (const f of r.findings) {
    lines.push("", `## ${f.title} [${f.type}${f.inSessionIndex ? ", first fact in every session's index" : ""}]${f.flags.length ? ` {${f.flags.join(", ")}}` : ""}`, `   ${f.absPath}`);
    for (const e of f.entries) {
      lines.push(`- ${e.subject} (${e.date}, ${e.ageDays} days, line ${e.line}): ${e.value}${e.source ? ` — source: ${e.source}` : ""}${e.flags.length ? ` {${e.flags.join(", ")}}` : ""}`);
      for (const n of e.newerEvidence) lines.push(`    newer: ${roots.get(n.root) ?? n.root}/${n.relPath}:${n.startLine}-${n.endLine} (${n.modified.slice(0, 10)}) ${n.snippet}`);
    }
  }
  return lines.join("\n");
}
