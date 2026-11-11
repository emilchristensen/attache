import type { MemoryAuditEntry, MemoryAuditReport } from "@jarvis/contracts";

/** Where an indexed file is, as the reader of the report should see it: absolute for a terminal, Brain-relative for a Harness. */
export type PathOf = (root: string, relPath: string) => string;

export interface AuditEvidenceView {
  path: string;
  title: string;
  startLine: number;
  endLine: number;
  snippet: string;
  modified: string;
}

export type AuditEntryView = Omit<MemoryAuditEntry, "newerEvidence"> & { newerEvidence: AuditEvidenceView[] };

export interface AuditFindingView {
  path: string;
  title: string;
  type: string;
  inSessionIndex: boolean;
  flags: string[];
  entries: AuditEntryView[];
}

/** A memory audit report with every file named by one path, so a reader can open it without knowing Jarvis's roots. */
export interface AuditView {
  generatedAt: string;
  staleDays: number;
  notes: number;
  entries: number;
  counts: Record<string, number>;
  findings: AuditFindingView[];
  possibleDuplicates: Array<{ title: string; paths: string[] }>;
}

export function auditView(r: MemoryAuditReport, pathOf: PathOf): AuditView {
  return {
    generatedAt: r.generatedAt,
    staleDays: r.staleDays,
    notes: r.notes,
    entries: r.entries,
    counts: { ...r.counts },
    findings: r.findings.map((f) => ({
      path: pathOf("data", f.relPath),
      title: f.title,
      type: f.type,
      inSessionIndex: f.inSessionIndex,
      flags: [...f.flags],
      entries: f.entries.map((e) => ({
        ...e,
        flags: [...e.flags],
        newerEvidence: e.newerEvidence.map((n) => ({ path: pathOf(n.root, n.relPath), title: n.title, startLine: n.startLine, endLine: n.endLine, snippet: n.snippet, modified: n.modified })),
      })),
    })),
    possibleDuplicates: r.possibleDuplicates.map((d) => ({ title: d.title, paths: d.relPaths.map((p) => pathOf("data", p)) })),
  };
}

/** The audit as text a person or a model reads; `dataFolder` adds the data folder's location to the header. */
export function renderAudit(v: AuditView, opts: { dataFolder?: string } = {}): string {
  const counts = Object.entries(v.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  const lines = [`Jarvis memory audit: ${v.notes} notes, ${v.entries} current facts, stale after ${v.staleDays} days`, ...(opts.dataFolder ? [`Data folder: ${opts.dataFolder}`] : []), `Flags: ${counts || "none"}`];
  if (v.possibleDuplicates.length) {
    lines.push("", "Possible duplicate notes:");
    for (const d of v.possibleDuplicates) lines.push(`- ${d.title}: ${d.paths.join(", ")}`);
  }
  for (const f of v.findings) {
    lines.push("", `## ${f.title} [${f.type}${f.inSessionIndex ? ", in a project's session context" : ""}]${f.flags.length ? ` {${f.flags.join(", ")}}` : ""}`, `   ${f.path}`);
    for (const e of f.entries) {
      lines.push(`- ${e.subject} (${e.date}${e.review ? `, review ${e.review}` : ""}, ${e.ageDays} days, line ${e.line}): ${e.value}${e.source ? ` — source: ${e.source}` : ""}${e.flags.length ? ` {${e.flags.join(", ")}}` : ""}`);
      for (const n of e.newerEvidence) lines.push(`    newer: ${n.path}:${n.startLine}-${n.endLine} (${n.modified.slice(0, 10)}) ${n.snippet}`);
    }
  }
  return lines.join("\n");
}
