import { randomUUID } from "node:crypto";
import type { MemorySaveInput, MemorySaveItem, ProposalInput, ProposalView } from "@jarvis/contracts";
import { tx, type Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import type { MachineIdentity } from "../core/machine.ts";
import { HttpError } from "../http/router.ts";
import type { Clock } from "../replication/clock.ts";
import { latestDecision, type ReviewMachine } from "../review-state/decisions.ts";
import { isReviewPath, listReviewFiles, readReviewFile, removeReviewFile, writeReviewFile } from "../review-state/files.ts";
import { normalizeRel } from "./policy.ts";
import { ProposalIndex } from "./proposal-index.ts";
import { legacyProposalRecord } from "./proposal-legacy.ts";
import { parseProposalRecord, proposalItem, proposalPath, PROPOSALS_KIND, proposalSource, proposalStatus, toProposalView, type ProposalDecision, type ProposalRecord } from "./proposal-record.ts";
import { undoApproval } from "./proposal-undo.ts";
import { checkItems, writeItem } from "./save-items.ts";
import { formatSource, type MemoryStore, type SourceRef } from "./store.ts";

/** The Harness session a Proposal came from, when a Harness made it. */
export type ProposalOrigin = NonNullable<MemorySaveInput["origin"]>;

/** Who suggests a set of items, why, and from which evidence. */
export interface ProposalMeta {
  reason: string;
  source: SourceRef | null;
  origin?: ProposalOrigin | null;
  /** The words in the evidence the change rests on, quoted from it. */
  evidence?: string | null;
  proposedBy: string;
}

export interface ProposalsDeps {
  db: Db;
  memory: MemoryStore;
  log: Logger;
  clock: Clock;
  machine: () => MachineIdentity;
  /** Told after every Proposal file written, so Replication commits it. */
  onWrite: (relPath: string) => void;
}

/**
 * Proposals live in the Brain, one file each under `review/proposals/`, so a
 * Proposal made on one Machine can be decided on any other. A decision is
 * added to the file, never replaces one; the latest decision stands on every
 * Machine. Applying writes the change on the Machine where the owner clicked,
 * and the result reaches the others as an ordinary change to the note.
 */
export class Proposals {
  private readonly index: ProposalIndex;
  private readonly deps: ProposalsDeps;

  constructor(deps: ProposalsDeps) {
    this.deps = deps;
    this.index = new ProposalIndex(deps.db);
  }

  /** Record one suggested change for the owner to decide in the Dashboard, checked like a save first. */
  propose(input: ProposalInput, proposedBy: string): ProposalView {
    return this.proposeItems([input.item], { reason: input.reason, source: (input.source as SourceRef | undefined) ?? null, evidence: input.evidence ?? null, proposedBy })[0]!;
  }

  /** One Proposal per item. The items are checked together, like one save: one invalid item refuses them all. */
  proposeItems(items: readonly MemorySaveItem[], meta: ProposalMeta): ProposalView[] {
    const root = this.requireBrain();
    checkItems(this.deps.memory, items);
    const createdAt = this.deps.clock.now().toISOString();
    const records = items.map((item): ProposalRecord => ({
      version: 1,
      id: randomUUID(),
      createdAt,
      machine: this.machineRef(),
      proposedBy: meta.proposedBy,
      target: targetOf(item),
      subject: summarize(item),
      reason: meta.reason,
      source: meta.source,
      sourceText: meta.source ? formatSource(meta.source) : null,
      origin: meta.origin ?? null,
      evidence: meta.evidence ?? null,
      item,
      decisions: [],
    }));
    const written: string[] = [];
    try {
      for (const r of records) {
        writeReviewFile(root, proposalPath(r.id), r);
        written.push(proposalPath(r.id));
      }
    } catch (e) {
      for (const rel of written) removeReviewFile(root, rel);
      throw e;
    }
    tx(this.deps.db, () => records.forEach((r) => this.index.put(proposalPath(r.id), r)));
    written.forEach((rel) => this.deps.onWrite(rel));
    return records.map(toProposalView);
  }

  list(opts: { status?: ProposalView["status"]; limit?: number } = {}): ProposalView[] {
    return this.index.list(opts).map(toProposalView);
  }

  /** The Proposals, whatever their status, that `proposedBy` made from one Harness session, newest first. */
  from(proposedBy: string, origin: Pick<ProposalOrigin, "agent" | "sessionId">): ProposalView[] {
    return this.index
      .list({ limit: 500 })
      .filter((r) => r.proposedBy === proposedBy && r.origin?.agent === origin.agent && (r.origin.sessionId ?? "") === (origin.sessionId ?? ""))
      .map(toProposalView);
  }

  /**
   * Apply or reject a pending Proposal. Applying checks the item again, because
   * the Brain may have changed since it was proposed, then writes it as one
   * file write; a refusal leaves the Proposal pending and the Brain untouched.
   */
  decide(id: string, decision: "apply" | "reject"): ProposalView {
    const root = this.requireBrain();
    const found = this.current(id);
    if (!found) throw new HttpError(404, "not_found", "That Proposal does not exist.");
    const { relPath, record } = found;
    const status = proposalStatus(record);
    if (status !== "proposed") throw new HttpError(409, "already_decided", `That Proposal was already ${status}.`);
    const base = { id: randomUUID(), at: this.deps.clock.now().toISOString(), machine: this.machineRef() };
    let made: ProposalDecision;
    if (decision === "reject") {
      made = { ...base, decision: "rejected", path: null, batch: null };
    } else {
      const item = proposalItem(record);
      if (!item) throw new HttpError(409, "unreadable_proposal", "This Proposal can no longer be read, so it cannot be applied. Reject it instead.");
      const [step] = checkItems(this.deps.memory, [item]);
      // Its own batch id, as a save has, so the changes it makes show and revert as one, citing the Harness session it came from.
      const batch = randomUUID();
      const meta = { harness: record.origin?.agent ?? null, sessionId: record.origin?.sessionId || null, batchId: batch };
      const written = writeItem(this.deps.memory, step!, proposalSource(record), { actor: "service", provenance: "user-approved" }, meta);
      made = { ...base, decision: "applied", path: written.relPath, batch };
    }
    const next: ProposalRecord = { ...record, decisions: [...record.decisions, made] };
    this.store(root, relPath, next);
    return toProposalView(next);
  }

  /**
   * Take in Proposal files another Machine changed. A rejection that came
   * later than this Machine's approval wins, so the approval is undone here,
   * where its changes were written. True when anything changed.
   */
  reload(paths: readonly string[]): boolean {
    const root = this.deps.memory.dataRoot;
    if (!root) return false;
    let changed = false;
    for (const rel of paths.filter((p) => isReviewPath(p, PROPOSALS_KIND))) {
      const record = parseProposalRecord(readReviewFile(root, rel));
      if (!record) {
        if (this.index.removePath(rel)) changed = true;
        if (readReviewFile(root, rel) !== null) this.deps.log.warn("ignored a Proposal file that does not read as one", { path: rel });
        continue;
      }
      if (this.index.holds(rel, record)) continue;
      this.index.put(rel, record);
      changed = true;
      try {
        this.settle(record);
      } catch (e) {
        this.deps.log.error("could not undo an approval that a later rejection overruled", { proposal: record.id, error: (e as Error).message });
      }
    }
    return changed;
  }

  /**
   * Bring the index in line with the Brain when a data folder is opened:
   * Proposals this Machine kept in its change log become files first, then
   * every Proposal file is read.
   */
  open(): void {
    const root = this.deps.memory.dataRoot;
    if (!root) return;
    this.carryOver(root);
    const files = listReviewFiles(root, PROPOSALS_KIND);
    const present = new Set(files);
    tx(this.deps.db, () => {
      for (const rel of this.index.paths().keys()) if (!present.has(rel)) this.index.removePath(rel);
    });
    this.reload(files);
  }

  /** Proposals pending (or decided) before they moved into the Brain are written as files, once. */
  private carryOver(root: string): void {
    const rows = this.deps.memory.legacyProposals();
    if (!rows.length) return;
    const machine = this.machineRef();
    for (const row of rows) {
      const rel = proposalPath(row.id);
      if (readReviewFile(root, rel) === null) writeReviewFile(root, rel, legacyProposalRecord(row, machine));
      this.deps.onWrite(rel);
    }
    this.deps.memory.forgetLegacyProposals(rows.map((r) => r.id));
    this.deps.log.info("moved Proposals into the Brain", { count: rows.length });
  }

  /** If a rejection made later on another Machine beat an approval made here, undo what the approval wrote. */
  private settle(record: ProposalRecord): void {
    if (proposalStatus(record) !== "rejected") return;
    const me = this.deps.machine().id;
    const mine = record.decisions.filter((d) => d.decision === "applied" && d.machine.id === me && d.batch);
    const rejection = latestDecision(record.decisions);
    for (const approval of mine) {
      const outcome = undoApproval(this.deps.memory, approval.batch!, `the Proposal was rejected${rejection ? ` on ${rejection.machine.name}` : ""} after it was approved on ${approval.machine.name}`);
      if (outcome.kept.length) this.deps.log.warn("could not undo all of an approved Proposal that was rejected later on another Machine", { proposal: record.id, kept: outcome.kept });
    }
  }

  /** The Proposal as its file says now, which may be newer than the index. */
  private current(id: string): { relPath: string; record: ProposalRecord } | null {
    const root = this.deps.memory.dataRoot;
    const indexed = this.index.get(id);
    const relPath = indexed?.relPath ?? proposalPath(id);
    const onDisk = root ? parseProposalRecord(readReviewFile(root, relPath)) : null;
    if (onDisk && onDisk.id === id) return { relPath, record: onDisk };
    return indexed;
  }

  private store(root: string, relPath: string, record: ProposalRecord): void {
    writeReviewFile(root, relPath, record);
    this.index.put(relPath, record);
    this.deps.onWrite(relPath);
  }

  private requireBrain(): string {
    const root = this.deps.memory.dataRoot;
    if (!root) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
    return root;
  }

  private machineRef(): ReviewMachine {
    const m = this.deps.machine();
    return { id: m.id, name: m.name };
  }
}

/** Where a Proposal lands: the note it changes, or a placeholder naming the note it would create. */
function targetOf(item: MemorySaveItem): string {
  return item.action === "create" ? `(new ${item.type}: ${item.title})` : normalizeRel(item.path.replace(/^\.\//, ""));
}

/** A short line naming what the item changes, for lists that show one line per Proposal. */
function summarize(item: MemorySaveItem): string {
  const subjects = (item.facts ?? []).map((f) => f.subject);
  const events = item.events?.length ?? 0;
  const parts = [...(subjects.length ? [subjects.join(", ")] : []), ...(events ? [`${events} event${events === 1 ? "" : "s"}`] : [])];
  return parts.join("; ").slice(0, 200);
}
