import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConnectorAdapter, Observation } from "./types.ts";
import { RemoteError } from "./http.ts";
import { planScan } from "../memory/indexer.ts";
import { splitFrontmatter } from "../memory/markdown.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import { expandHome } from "../platform/locations.ts";
import { folderSuggestions } from "../platform/folder-suggestions.ts";
import type { ConnectionDefinition } from "@jarvis/contracts";

/**
 * Deadlines from Markdown: open tasks with a due date (Obsidian Tasks `📅
 * 2026-10-01`, `due:2026-10-01`, `(due 2026-10-01)`, `@due(2026-10-01)`) and
 * notes whose frontmatter has `due:`. Completed tasks are ignored, so ticking
 * a task off resolves its attention item on the next fully covered Source refresh.
 */
const DUE_RE = /(?:📅\s*|\bdue[:\s]\s*|@due\()(\d{4}-\d{2}-\d{2})\)?/i;
const TASK_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const HORIZON_DAYS = 14;

export function extractDeadlines(rootId: string, relPath: string, raw: string, now: Date): Observation[] {
  const out: Observation[] = [];
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(raw);
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const title = typeof frontmatter.title === "string" ? frontmatter.title : relPath.replace(/\.md$/, "").split("/").pop()!;
  const push = (text: string, due: string, line: number, done: boolean) => {
    if (done || due > horizon) return;
    const normalized = text.replace(DUE_RE, "").replace(/\s+/g, " ").trim();
    const identity = fingerprint([rootId, relPath, normalized.toLowerCase()]);
    const overdue = due < today;
    const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
    out.push({
      kind: "deadline",
      externalId: `${relPath}:${identity}`,
      title: normalized || title,
      occurredAt: due,
      data: { relPath, root: rootId, line, due, noteTitle: title },
      fingerprintParts: [normalized, due],
      attention: {
        key: `vault:${rootId}:${relPath}:${identity}`,
        kind: "deadline",
        title: `${overdue ? "Overdue" : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`}: ${normalized || title}`,
        summary: `From “${title}” (${relPath}, line ${line}), due ${due}.`,
        why: overdue ? "Past its due date and still open." : "Due within two weeks.",
        dueAt: due,
        priority: overdue ? 80 : days <= 1 ? 70 : 40,
        extraFingerprint: [overdue ? "overdue" : "upcoming"],
      },
    });
  };
  if (typeof frontmatter.due === "string" || frontmatter.due instanceof Date) {
    const due = frontmatter.due instanceof Date ? frontmatter.due.toISOString().slice(0, 10) : String(frontmatter.due).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(due) && frontmatter.status !== "done") push(title, due, 1, false);
  }
  body.split("\n").forEach((line, i) => {
    const t = TASK_RE.exec(line);
    if (!t) return;
    const d = DUE_RE.exec(t[2]!);
    if (d) push(t[2]!, d[1]!, bodyStartLine + i, t[1]!.toLowerCase() === "x");
  });
  return out;
}

export function scanDeadlines(root: { id: string; path: string }, relPaths: string[], now: Date): { observations: Observation[]; errors: string[] } {
  const observations: Observation[] = [];
  const errors: string[] = [];
  for (const rel of relPaths) {
    try {
      observations.push(...extractDeadlines(root.id, rel, readFileSync(join(root.path, rel), "utf8"), now));
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return { observations, errors };
}

/** What the Dashboard shows for an imported folder. */
function vaultDefinition(): ConnectionDefinition {
  return {
    kind: "vault",
    label: "Markdown folder / Obsidian vault",
    description: "A folder of Markdown notes, such as an Obsidian vault. Jarvis reads and indexes it without changing it.",
    authMethods: [{ id: "folder", label: "Local folder", fields: [{ id: "path", label: "Folder path", secret: false, placeholder: folderSuggestions().examples.notes }, { id: "label", label: "Name", secret: false, optional: true }] }],
    scopes: [{ id: "deadlines", label: "Tasks and notes with due dates", default: true }],
    writeActions: [],
    setupHelp: "Read-only: Jarvis never modifies files in an imported folder. Captures and memory are written to your Jarvis data folder.",
    unavoidableSteps: [],
  };
}

export const vaultAdapter: ConnectorAdapter = {
  kind: "vault",
  secretNames: [],
  // A getter: working out the example folder at import would throw on an unsupported
  // operating system before the command line can explain it (see `platform/os.ts`).
  get definition() {
    return vaultDefinition();
  },
  async configure(_ctx, fields) {
    const path = resolve(expandHome(fields.path ?? ""));
    if (!fields.path || !existsSync(path) || !statSync(path).isDirectory()) throw new RemoteError(`Folder not found: ${path}`, "error");
    return { path };
  },
  async test(ctx) {
    const path = String(ctx.connection.settings.path ?? "");
    if (!path || !existsSync(path)) return { ok: false, state: "error", account: null, message: `Folder not found: ${path}` };
    const plan = planScan(path, 100_000);
    return { ok: true, state: plan.read.length ? "complete" : "empty", account: path, message: `${plan.read.length} Markdown files readable${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ""}` };
  },
};
