import { readFileSync } from "node:fs";
import { MemorySaveInput, type MemoryAuditReport, type MemorySaveResult } from "@jarvis/contracts";
import type { ServicePaths } from "../core/paths.ts";
import { ServiceClient } from "./client.ts";
import { agentFromEnv } from "./agent-env.ts";
import { auditView, renderAudit } from "../memory/audit-view.ts";

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

export const AUDIT_USAGE = `Usage: jarvis audit [--json]

Lists every current fact in the Brain with its date, Review date, source and flags.
A fact is flagged stale only when it is past its Review date.`;

/** `jarvis audit`: the deterministic memory audit, printed for a person or an agent to judge. */
export async function auditCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  if (argv.includes("--help")) return io.out(AUDIT_USAGE);
  const unknown = unknownAuditOption(argv.slice(1));
  if (unknown) throw new Error(`Unknown option ${unknown}.\n\n${AUDIT_USAGE}`);
  const client = new ServiceClient(paths);
  const report = await client.get<MemoryAuditReport>("/memory/audit");
  if (argv.includes("--json")) return io.out(JSON.stringify(report));
  const roots = new Map((await client.get<Array<{ root: string; path: string }>>("/memory/roots")).map((r) => [r.root, r.path]));
  io.out(renderAudit(auditView(report, (root, rel) => `${(roots.get(root) ?? root).replace(/\/+$/, "")}/${rel}`), { dataFolder: report.dataFolder }));
}

/** The first argument `jarvis audit` does not take, if any; `--state-dir <folder>` is the global option every command takes. */
function unknownAuditOption(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--state-dir") i++;
    else if (a !== "--json") return a;
  }
  return null;
}
