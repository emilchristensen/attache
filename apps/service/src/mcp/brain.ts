import type { Config, MeaningState, MeaningStatus, MemoryAuditReport, MemorySaveCheckResult, MemorySaveInput, MemorySaveProposalInput, MemorySaveProposalResult, MemorySaveResult, WrapUpInput, WrapUpResult } from "@jarvis/contracts";
import { meaningNote } from "../meaning/note.ts";
import type { ServicePaths } from "../core/paths.ts";
import { ServiceClient } from "../cli/client.ts";
import { auditView, type AuditView, type PathOf } from "../memory/audit-view.ts";
import type { StateEntry } from "../memory/markdown.ts";

/** One search result as a Harness sees it: where it is, what kind of section, and the passage itself. */
export interface Passage {
  /** Relative to the Brain, or absolute for a note in another folder Jarvis indexes. `read` takes it as is. */
  path: string;
  startLine: number;
  endLine: number;
  /**
   * What kind of document holds it: `memory` (curated notes), `evidence`
   * (captures, session logs, wrap-ups, snapshots), `deliverables` or `import`.
   * Only `memory` passages state current facts.
   */
  area: string;
  section: "state" | "history" | "body";
  heading: string | null;
  title: string;
  text: string;
  /** A current fact's Review date, when the passage is a fact that has one. */
  review: string | null;
  /** A current fact past its Review date: still in the Brain, but to be checked before relying on it. */
  unverified: boolean;
}

/** A current fact past its Review date, at its line in the note. */
export interface UnverifiedFact {
  subject: string;
  review: string;
  line: number;
}

/** Passages found, and whether they match by keywords only because meaning-based search is not ready on this Machine. */
export interface SearchAnswer {
  passages: Passage[];
  meaning: { state: MeaningState; note: string | null };
}

export interface NoteText {
  path: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  /** The current facts within the lines returned that are past their Review date. */
  unverified: UnverifiedFact[];
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
  search(query: string, limit: number): Promise<SearchAnswer>;
  read(path: string, range: LineRange): Promise<NoteText>;
  overview(): Promise<BrainOverview>;
  /** Every current fact with its date, source, flags and newer evidence. Read-only. */
  audit(): Promise<AuditView>;
  /** Check a save against the Brain without writing, and whether its Harness may skip asking; throws the reason an item is refused. */
  checkSave(input: Pick<MemorySaveInput, "items" | "origin">): Promise<MemorySaveCheckResult>;
  /** Write a save as the owner: one they confirmed, or one auto-accept lets through (`autoAccept`). */
  save(input: MemorySaveInput): Promise<MemorySaveResult>;
  /** Store a save the owner could not confirm as Proposals. */
  propose(input: MemorySaveProposalInput): Promise<MemorySaveProposalResult>;
  /** Store a conversation's durable points as evidence; no points stores nothing. */
  wrapUp(input: WrapUpInput): Promise<WrapUpResult>;
}

interface RawHit {
  root: string;
  relPath: string;
  startLine: number;
  endLine: number;
  area: string;
  section: Passage["section"];
  heading: string | null;
  title: string;
  text: string;
  review: string | null;
  unverified: boolean;
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
      const { hits, meaning } = await c.get<{ hits: RawHit[]; meaning: MeaningStatus }>(`/memory/search?recall=1&limit=${limit}&q=${encodeURIComponent(query)}`);
      const pathOf = await brainPaths(c, hits.map((h) => h.root));
      const passages = hits.map((h) => ({
        path: pathOf(h.root, h.relPath),
        startLine: h.startLine,
        endLine: h.endLine,
        area: h.area,
        section: h.section,
        heading: h.heading,
        title: h.title,
        text: h.text,
        review: h.review,
        unverified: h.unverified,
      }));
      return { passages, meaning: { state: meaning.state, note: meaningNote(meaning) } };
    },
    async read(path, range) {
      const doc = await client().get<{ raw: string; title: string; state: Array<StateEntry & { unverified: boolean }> }>(`/memory/document?path=${encodeURIComponent(path)}`);
      const note = sliceLines(path, doc.title, doc.raw, range);
      const unverified = doc.state.filter((e) => e.unverified && e.review && e.line >= note.startLine && e.line <= note.endLine).map((e) => ({ subject: e.subject, review: e.review!, line: e.line }));
      return { ...note, unverified };
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
    checkSave: async (input) => client().post<MemorySaveCheckResult>("/memory/save/check", input),
    save: async (input) => client().post<MemorySaveResult>("/memory/save", input),
    propose: async (input) => client().post<MemorySaveProposalResult>("/memory/save/proposals", input),
    async wrapUp(input) {
      return client().post<WrapUpResult>("/memory/wrap-up", input);
    },
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
export function sliceLines(path: string, title: string, raw: string, range: LineRange): Omit<NoteText, "unverified"> {
  const lines = raw.replace(/\r?\n$/, "").split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = range.startLine ?? 1;
  const endLine = Math.min(range.endLine ?? totalLines, totalLines);
  if (startLine > totalLines) throw new LineRangeError(`${path} has ${totalLines} lines, so line ${startLine} does not exist.`);
  if (endLine < startLine) throw new LineRangeError(`endLine ${endLine} comes before startLine ${startLine}.`);
  return { path, title, startLine, endLine, totalLines, text: lines.slice(startLine - 1, endLine).join("\n") };
}
