import type { Config, MemoryAuditReport, MemorySaveCheckResult, MemorySaveInput, MemorySaveProposalInput, MemorySaveProposalResult, MemorySaveResult } from "@jarvis/contracts";
import type { ServicePaths } from "../core/paths.ts";
import { ServiceClient } from "../cli/client.ts";
import { auditView, type AuditView, type PathOf } from "../memory/audit-view.ts";

/** One search result as a Harness sees it: where it is, what kind of section, and the passage itself. */
export interface Passage {
  /** Relative to the Brain, or absolute for a note in another folder Jarvis indexes. `read` takes it as is. */
  path: string;
  startLine: number;
  endLine: number;
  section: "state" | "history" | "body";
  heading: string | null;
  title: string;
  text: string;
}

export interface NoteText {
  path: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

export interface LineRange {
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export interface BrainOverview {
  owner: { name: string; email?: string } | null;
  /** Curated notes, most recently updated first. */
  notes: Array<{ type: string; title: string }>;
}

/** The Brain as the MCP server reaches it: through the running service, paired the same way as the CLI. */
export interface BrainAccess {
  search(query: string, limit: number): Promise<Passage[]>;
  read(path: string, range: LineRange): Promise<NoteText>;
  overview(): Promise<BrainOverview>;
  /** Every current fact with its date, source, flags and newer evidence. Read-only. */
  audit(): Promise<AuditView>;
  /** Check a save against the Brain without writing; throws the reason an item is refused. */
  checkSave(items: MemorySaveInput["items"]): Promise<MemorySaveCheckResult>;
  /** Write a save the owner confirmed, as the owner. */
  save(input: MemorySaveInput): Promise<MemorySaveResult>;
  /** Store a save the owner could not confirm as Proposals. */
  propose(input: MemorySaveProposalInput): Promise<MemorySaveProposalResult>;
}

interface RawHit {
  root: string;
  relPath: string;
  startLine: number;
  endLine: number;
  section: Passage["section"];
  heading: string | null;
  title: string;
  text: string;
}

/** A read that asks for lines the note does not have. */
export class LineRangeError extends Error {}

/**
 * Builds a fresh client per call, so a server started before the service
 * works as soon as the service runs, and a stopped service is reported on
 * the call that meets it.
 */
export function serviceBrain(paths: ServicePaths): BrainAccess {
  const client = () => new ServiceClient(paths);
  return {
    async search(query, limit) {
      const c = client();
      const { hits } = await c.get<{ hits: RawHit[] }>(`/memory/search?recall=1&limit=${limit}&q=${encodeURIComponent(query)}`);
      const pathOf = await brainPaths(c, hits.map((h) => h.root));
      return hits.map((h) => ({
        path: pathOf(h.root, h.relPath),
        startLine: h.startLine,
        endLine: h.endLine,
        section: h.section,
        heading: h.heading,
        title: h.title,
        text: h.text,
      }));
    },
    async read(path, range) {
      const doc = await client().get<{ raw: string; title: string }>(`/memory/document?path=${encodeURIComponent(path)}`);
      return sliceLines(path, doc.title, doc.raw, range);
    },
    async overview() {
      const c = client();
      const { config } = await c.get<{ config: Config }>("/config");
      const docs = await c.get<Array<{ relPath: string; docType: string | null; title: string }>>("/memory/documents?area=memory&root=data&limit=400");
      return {
        owner: config.identity ? { name: config.identity.name, ...(config.identity.email ? { email: config.identity.email } : {}) } : null,
        notes: docs.filter((d) => d.relPath !== "memory/self.md" && d.title).map((d) => ({ type: d.docType ?? "note", title: d.title })),
      };
    },
    async audit() {
      const c = client();
      const report = await c.get<MemoryAuditReport>("/memory/audit");
      return auditView(report, await brainPaths(c, report.findings.flatMap((f) => f.entries.flatMap((e) => e.newerEvidence.map((n) => n.root)))));
    },
    checkSave: async (items) => client().post<MemorySaveCheckResult>("/memory/save/check", { items }),
    save: async (input) => client().post<MemorySaveResult>("/memory/save", input),
    propose: async (input) => client().post<MemorySaveProposalResult>("/memory/save/proposals", input),
  };
}

/**
 * The path a Harness sees for an indexed file: relative for the Brain,
 * absolute for another folder Jarvis indexes. `read` takes either. The roots
 * are fetched only when a file outside the Brain is among `used`.
 */
async function brainPaths(c: ServiceClient, used: string[]): Promise<PathOf> {
  const roots = used.some((r) => r !== "data") ? new Map((await c.get<Array<{ root: string; path: string }>>("/memory/roots")).map((r) => [r.root, r.path])) : new Map<string, string>();
  return (root, relPath) => (root === "data" ? relPath : `${(roots.get(root) ?? root).replace(/\/+$/, "")}/${relPath}`);
}

/** The whole note, or the inclusive 1-based line range asked for, clamped to the note's end. */
export function sliceLines(path: string, title: string, raw: string, range: LineRange): NoteText {
  const lines = raw.replace(/\r?\n$/, "").split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = range.startLine ?? 1;
  const endLine = Math.min(range.endLine ?? totalLines, totalLines);
  if (startLine > totalLines) throw new LineRangeError(`${path} has ${totalLines} lines, so line ${startLine} does not exist.`);
  if (endLine < startLine) throw new LineRangeError(`endLine ${endLine} comes before startLine ${startLine}.`);
  return { path, title, startLine, endLine, totalLines, text: lines.slice(startLine - 1, endLine).join("\n") };
}
