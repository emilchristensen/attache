import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { replaceWith } from "../platform/replace-file.ts";
import type { MachineRecord } from "./machine-records.ts";
import type { MergeInput, MergeOutcome, MergeRule } from "./seams.ts";

/**
 * The Brain format: the version of how replicated files (notes, evidence, Inbox
 * items, Machine records, Preferences) are laid out (ADR 0008).
 *
 * `machines/brain-format.json` says which format the Brain is in. It is written
 * when Replication is set up (and by the first check of a Brain set up before
 * it existed); a Brain without it is in format 1. A change to the format ships
 * in two releases: one learns to read it (`reads`), a later one writes it
 * (`writes`). A Machine raises the record to its `writes` only when every Machine
 * heard from in the last 30 days records that it reads it; a Machine that finds
 * a format above its `reads` pauses Replication without writing.
 *
 * Cross-version contract: never rename the file or its `format` field.
 */
export const BRAIN_FORMAT_FILE = "machines/brain-format.json";

/** The Brain formats a release reads (the newest one) and writes once every active Machine can read it. */
export interface BrainFormatSupport {
  reads: number;
  writes: number;
}

/** This release: it reads and writes format 1. No release changes the format yet. */
export const RELEASE_BRAIN_FORMAT: BrainFormatSupport = Object.freeze({ reads: 1, writes: 1 });
/** The newest Brain format this release can read, as its Machine record says. */
export const READABLE_BRAIN_FORMAT = RELEASE_BRAIN_FORMAT.reads;
/** A Machine whose record is older than this is not heard from: it no longer holds the format back. */
export const ACTIVE_WITHIN_MS = 30 * 24 * 60 * 60_000;

/** Fields a newer release adds survive this one rewriting the record (`loose`). */
export const BrainFormatRecord = z
  .object({
    format: z.int().min(1),
    updatedAt: z.iso.datetime(),
    /** The Machine that wrote this format. */
    by: z.uuid(),
  })
  .loose();
export type BrainFormatRecord = z.infer<typeof BrainFormatRecord>;

/** What one copy of the Brain says about its format. */
export type BrainFormatReading = { kind: "missing" } | { kind: "format"; record: BrainFormatRecord } | { kind: "unreadable" };

export function readBrainFormat(text: string | null): BrainFormatReading {
  if (text === null) return { kind: "missing" };
  try {
    const parsed = BrainFormatRecord.safeParse(JSON.parse(text));
    return parsed.success ? { kind: "format", record: parsed.data } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** The format a reading says the Brain is in: 1 without a record, null when the record cannot be read. */
export function formatOf(reading: BrainFormatReading): number | null {
  if (reading.kind === "missing") return 1;
  return reading.kind === "format" ? reading.record.format : null;
}

/** What holds Replication back: a format this Machine cannot read pauses it, a record nobody can read blocks it. */
export type BrainFormatHold = { status: "paused"; cause: string; pausedFormat: number } | { status: "blocked"; cause: string };

/**
 * Whether the Brain, as the given copies say (the data folder, what was
 * fetched), is in a format this Machine reads; null when it is.
 */
export function brainFormatHold(copies: ReadonlyArray<{ reading: BrainFormatReading; where: string }>, reads: number): BrainFormatHold | null {
  const unreadable = copies.find((c) => c.reading.kind === "unreadable");
  if (unreadable) {
    return { status: "blocked", cause: `The Brain format record (${BRAIN_FORMAT_FILE}) ${unreadable.where} cannot be read, so Attache cannot tell which Brain format the Brain is in. Put it back as it was in the repository's history, then select Check now.` };
  }
  const format = Math.max(...copies.map((c) => formatOf(c.reading) ?? 1));
  if (format <= reads) return null;
  return {
    status: "paused",
    cause: `The Brain is in Brain format ${format}, and this Machine's Attache reads Brain format ${reads} at most. Update this Machine to keep replicating; saves carry on here and are sent once it is updated.`,
    pausedFormat: format,
  };
}

export function readBrainFormatFile(root: string): BrainFormatReading {
  const abs = join(root, BRAIN_FORMAT_FILE);
  return readBrainFormat(existsSync(abs) ? readFileSync(abs, "utf8") : null);
}

export function renderBrainFormat(record: BrainFormatRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Written beside the target and renamed over it, so git never sees half a record. */
export function writeBrainFormatFile(root: string, record: BrainFormatRecord): void {
  const abs = join(root, BRAIN_FORMAT_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, renderBrainFormat(BrainFormatRecord.parse(record)));
  replaceWith(tmp, abs);
}

/** A record from a release before Machine records carried `readsBrainFormat` reads format 1, the only one there was. */
export function readsOf(record: Pick<MachineRecord, "readsBrainFormat">): number {
  return record.readsBrainFormat ?? 1;
}

/** Whether every Machine heard from within `ACTIVE_WITHIN_MS` of `now` records that it reads `format`. */
export function everyActiveMachineReads(records: readonly MachineRecord[], format: number, now: Date): boolean {
  return records.every((r) => now.getTime() - Date.parse(r.updatedAt) > ACTIVE_WITHIN_MS || readsOf(r) >= format);
}

/**
 * The record this Machine should write to the Brain, or null when it stays as
 * it is: written when missing, raised to `support.writes` once every active
 * Machine reads that. Never lowered. Unknown fields of the record are kept.
 */
export function nextBrainFormat(input: { reading: BrainFormatReading; support: BrainFormatSupport; records: readonly MachineRecord[]; machine: string; now: Date }): BrainFormatRecord | null {
  const { reading, support, records, machine, now } = input;
  if (reading.kind === "unreadable") return null;
  const current = reading.kind === "format" ? reading.record : null;
  const at = now.toISOString();
  const raised = support.writes > (current?.format ?? 1) && everyActiveMachineReads(records, support.writes, now);
  if (raised) return { ...current, format: support.writes, updatedAt: at, by: machine };
  return current ? null : { format: 1, updatedAt: at, by: machine };
}

function parsed(content: string | null): { content: string; record: BrainFormatRecord } | null {
  const reading = readBrainFormat(content);
  return reading.kind === "format" ? { content: content!, record: reading.record } : null;
}

/**
 * Settles the Brain format record that two Machines wrote: the higher format
 * wins, since the format only rises; at the same format the later write wins.
 * Every Machine picks the same side. Listed before the Machine record rule,
 * whose path pattern it shares.
 */
export const brainFormatRule: MergeRule = {
  name: "Brain format: the higher format wins",
  appliesTo: (path) => path === BRAIN_FORMAT_FILE,
  merge({ ours, theirs }: MergeInput): MergeOutcome | null {
    const a = parsed(ours);
    const b = parsed(theirs);
    if (!a || !b) {
      const kept = a ?? b;
      return kept ? { content: kept.content } : null;
    }
    const byFormat = a.record.format - b.record.format;
    if (byFormat !== 0) return { content: byFormat > 0 ? a.content : b.content };
    const byTime = Date.parse(a.record.updatedAt) - Date.parse(b.record.updatedAt);
    if (byTime !== 0) return { content: byTime > 0 ? a.content : b.content };
    return { content: a.content > b.content ? a.content : b.content };
  },
};
