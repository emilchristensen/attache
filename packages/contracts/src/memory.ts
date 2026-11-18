import { z } from "zod";

/** API contract: Memory. */

export interface Citation {
  marker: string;
  docId: string;
  root: string;
  relPath: string;
  title: string;
  heading: string | null;
  section: "state" | "history" | "body";
  startLine: number;
  endLine: number;
  snippet: string;
  area: string;
  observedAt: string | null;
}

export const SourceRefInput = z.object({
  kind: z.enum(["capture", "note", "import", "connector", "conversation", "user", "agent-session"]),
  ref: z.string().min(1).max(2000),
  root: z.string().optional(),
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  url: z.string().url().optional(),
  observedAt: z.string().default(() => new Date().toISOString()),
  label: z.string().max(200).optional(),
});

/** Copy a Markdown folder verbatim into evidence/archive/<label>/ so it outlives the original. */
export const ArchiveInput = z.object({
  path: z.string().min(1),
  label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /** Path prefixes relative to the folder, e.g. ".obsidian/" or "templates/". */
  exclude: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Where the files really come from when archiving a frozen copy, e.g. "~/Notes at commit 0c6becc". */
  origin: z.string().min(1).max(500).optional(),
});

/** A calendar day written YYYY-MM-DD, as the Brain dates facts. */
export const CalendarDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a day written YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "must be a real calendar day");

const SaveFact = z.object({
  subject: z.string().trim().min(1).max(100).describe("What the fact is about, e.g. Status or Role. One current value per subject."),
  value: z.string().trim().min(1).max(5000).describe("The current value."),
  review: CalendarDay.optional().describe(
    "Optional Review date, YYYY-MM-DD and after today: the day after which this fact should be checked again. Set it for a fact you expect to change, such as a status, a plan or a deadline. Past it the fact stays in the Brain, shown as unverified. Without one, a correction clears the old Review date.",
  ),
});
const SaveEvent = z.string().trim().min(1).max(2000).describe("Something that happened, appended to the note's History.");

/**
 * One change to one note: a new note with its facts, or an update to an existing
 * note. A save carries several; a Proposal carries exactly one.
 */
export const MemorySaveItem = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    type: z.enum(["person", "project", "decision", "note"]),
    title: z.string().trim().min(1).max(200),
    facts: z.array(SaveFact).min(1).max(50),
    notes: z.string().max(20_000).optional().describe("Free prose for the note's body."),
    events: z.array(SaveEvent).max(20).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  }),
  z.object({
    action: z.literal("update"),
    path: z.string().trim().min(1).max(500).describe("The note's path in the Brain, e.g. memory/projects/orion.md."),
    facts: z
      .array(SaveFact.extend({ reason: z.string().trim().min(1).max(1000).describe("Why the value changed, kept in History beside the old value.") }))
      .max(50)
      .optional(),
    events: z.array(SaveEvent).max(20).optional(),
  }),
]);
export type MemorySaveItem = z.infer<typeof MemorySaveItem>;

/**
 * What the owner asked a Harness to save (the MCP `save` tool). State goes into
 * `facts` (one current value per subject, replacing the old one), events into
 * `events` (appended to History). Validated as a whole before anything is written.
 */
export const MemorySaveInput = z.object({
  /** The Harness session the items were distilled from. */
  origin: z
    .object({
      agent: z.string().trim().min(1).max(40),
      sessionId: z.string().trim().max(200).optional(),
      cwd: z.string().max(2000).optional(),
    })
    .optional(),
  items: z.array(MemorySaveItem).min(1).max(20),
  /**
   * Write without asking the owner, because auto-accept is on for the
   * origin's Harness on this Machine. Refused when it is off.
   */
  autoAccept: z.boolean().optional(),
  /**
   * The owner accepted this save when Attache's MCP server asked them in the
   * Harness. A save that is neither confirmed nor auto-accepted is stored as
   * Proposals instead of being written.
   */
  confirmed: z.literal(true).optional(),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInput>;

/** What a save did: written as the owner (`saved`), or stored for review because nobody confirmed it (`proposals`). */
export interface MemorySaveResult {
  saved: Array<{ action: "created" | "updated"; relPath: string; absPath: string; title: string; facts: number; events: number }>;
  proposals: ProposalView[];
}

/** What a save would change, checked against the Brain without writing: one entry per item, in order. */
export interface MemorySaveCheckResult {
  items: Array<{ action: "create"; title: string; relPath: null } | { action: "update"; title: string; /** The note the update changes. */ relPath: string }>;
  /** Whether the save may be written without asking: auto-accept is on for the origin's Harness on this Machine. */
  autoAccept: boolean;
}

/** A connected Harness and whether its saves skip the confirmation request on this Machine. */
export interface HarnessSettingView {
  /** Harness integration kind, e.g. `claude-code`. */
  id: string;
  label: string;
  /** On unless the owner switched it off (ADR 0004); kept in this Machine's local state, never in the Brain. */
  autoAccept: boolean;
}

/** The Consolidation switch on this Machine: on, what Consolidation finds is written without review; off, it becomes Proposals. */
export interface ConsolidationSettingView {
  /** On by default; kept in this Machine's configuration, never in the Brain. */
  autoAccept: boolean;
}

export const HarnessAutoAcceptInput = z.object({ autoAccept: z.boolean() });
export type HarnessAutoAcceptInput = z.infer<typeof HarnessAutoAcceptInput>;

/** A save the owner could not confirm, stored as one Proposal per item for review in the Dashboard. */
export const MemorySaveProposalInput = MemorySaveInput.omit({ autoAccept: true, confirmed: true }).extend({
  /** Why the save waits for review, shown beside each Proposal. */
  reason: z.string().trim().min(1).max(1000),
});
export type MemorySaveProposalInput = z.infer<typeof MemorySaveProposalInput>;

export interface MemorySaveProposalResult {
  proposals: ProposalView[];
}

export const WRAP_UP_POINTS_MAX = 30;

/**
 * The durable points of one Harness conversation, distilled by its agent with
 * the wrap-up prompt. Stored as evidence, never as curated memory. No points
 * means the conversation held nothing durable, and nothing is stored.
 */
export const WrapUpInput = z.object({
  /** The Harness the conversation happened in. */
  harness: z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(80) }),
  /** A short name for the conversation. */
  title: z.string().trim().min(1).max(200).optional(),
  /** One self-contained sentence each. */
  points: z.array(z.string().trim().min(1).max(2000)).max(WRAP_UP_POINTS_MAX),
});
export type WrapUpInput = z.infer<typeof WrapUpInput>;

export type WrapUpResult = { stored: true; relPath: string; title: string; date: string; points: number } | { stored: false; reason: string };

/** Suggest one save item for the owner to apply or reject in the Dashboard. */
export const ProposalInput = z.object({
  item: MemorySaveItem,
  /** Why the change is suggested, shown beside it in the review list. */
  reason: z.string().trim().min(1).max(1000),
  /** The evidence the suggestion came from. */
  source: SourceRefInput.optional(),
  /** The words in that evidence the suggestion rests on, quoted from it. */
  evidence: z.string().trim().min(1).max(1000).optional(),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

/**
 * A current fact a Proposal gives a different value: the value it replaces, as
 * the note held it when the Proposal was made, and the value it sets.
 * Applying it moves the old value to the note's History with the reason.
 */
export interface ProposalCorrection {
  subject: string;
  was: { value: string; date: string; review: string | null };
  value: string;
}

export interface ProposalView {
  id: string;
  status: "proposed" | "applied" | "rejected";
  /** The whole change; null when a stored Proposal can no longer be read, so it can only be rejected. */
  item: MemorySaveItem | null;
  /** The note it changes, the note it created once applied, or "(new <type>: <title>)" before that. */
  target: string;
  /**
   * That note's title: as the note says now for an update or an applied new note, the title it would get for a
   * waiting one; null when the note cannot be read (deleted, or outside the Brain).
   */
  noteTitle: string | null;
  reason: string | null;
  /** The cited evidence, formatted as in the note. */
  source: string | null;
  /** The words in the evidence the Proposal rests on, quoted from it; null when none were quoted. */
  evidence: string | null;
  /** The current facts it gives a different value; empty when it corrects none. */
  corrections: ProposalCorrection[];
  proposedBy: string;
  createdAt: string;
  decidedAt: string | null;
  /** The Machine it was made on. */
  proposedOn: string;
  /** The Machine whose decision stands; null while it waits. */
  decidedOn: string | null;
}

/**
 * One change to the Brain in the recent-saves list. `create` and `delete` are
 * whole notes, `correct` is one fact (a `null` value means the subject had or
 * has no value), `append` is an event or a prose edit.
 */
export interface RecentChangeView {
  id: string;
  relPath: string;
  /** The note's title, also for a note that no longer exists. */
  title: string;
  kind: "create" | "correct" | "append" | "delete";
  subject: string | null;
  oldValue: string | null;
  newValue: string | null;
  /** For a fact: its Review date before and after the change, null when it had none. */
  oldReview: string | null;
  newReview: string | null;
  /** Why a fact was corrected, as the change gave it; null when it gave none. */
  reason: string | null;
  source: {
    /** Harness integration kind, e.g. `claude-code`. */
    harness: string | null;
    harnessLabel: string | null;
    sessionId: string | null;
    /** What to show: the Harness and session, or who else made the change. */
    label: string;
    /** Written without review: an auto-accepted save or a Consolidation write. */
    autoAccepted: boolean;
    /** Set when Consolidation wrote the change: what it read, a finished session or a meeting capture. */
    consolidation: { from: "session" | "meeting"; capture: { relPath: string; title: string } | null } | null;
  };
  at: string;
  /** The change this one reverted, and the change that reverted this one. */
  revertOf: string | null;
  revertedBy: string | null;
  revert: { allowed: true; reason: null } | { allowed: false; reason: string };
}

/** How long a change written without review stays on Home's Recently added (ADR 0004). */
export const UNREVIEWED_DAYS = 7;

export interface RecentChangesResult {
  changes: RecentChangeView[];
}

export interface MemoryAuditEntry {
  subject: string;
  value: string;
  date: string;
  /** The day after which the fact should be checked again; null when none is set. */
  review: string | null;
  ageDays: number;
  source: string | null;
  line: number;
  /** Deterministic problems with this entry: `stale` (past its Review date), `unsourced`, `missing-source`, `duplicate-subject`. */
  flags: string[];
  /** Documents that mention the note and changed after this entry was dated: where a contradiction would show up. */
  newerEvidence: Array<{ root: string; relPath: string; title: string; startLine: number; endLine: number; snippet: string; modified: string }>;
}

export interface MemoryAuditReport {
  generatedAt: string;
  dataFolder: string;
  notes: number;
  entries: number;
  /** Counts per flag, so two runs can be compared. */
  counts: Record<string, number>;
  /** `inSessionIndex`: a project's session context carries the note's facts (a project that lists repositories, or a decision or person linked to one). */
  findings: Array<{ relPath: string; absPath: string; title: string; type: string; inSessionIndex: boolean; flags: string[]; entries: MemoryAuditEntry[] }>;
  /** Pairs of notes whose titles reduce to the same name. */
  possibleDuplicates: Array<{ title: string; relPaths: string[] }>;
}
