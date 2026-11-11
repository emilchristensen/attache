import { z } from "zod";

/** Versioned API contract shared by the service, browser client, CLI and any future client. */
export const API_VERSION = "v1";
export const API_PREFIX = `/api/${API_VERSION}`;

// ---------------------------------------------------------------------------
// Features and connections

export const FeatureId = z.enum(["conversation", "recall", "capture", "attention", "drafts", "jobs", "sessions"]);
export type FeatureId = z.infer<typeof FeatureId>;

export const ConnectionKind = z.enum(["vault", "github", "jira", "confluence", "slack", "gmail", "gcal", "model", "claude-code", "codex", "antigravity"]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ReadinessState = z.enum(["ready", "needs_setup", "unavailable", "partial", "disabled"]);
export type ReadinessState = z.infer<typeof ReadinessState>;

export const CoverageState = z.enum(["complete", "partial", "empty", "denied", "unauthorized", "offline", "error", "not_configured", "never_run"]);
export type CoverageState = z.infer<typeof CoverageState>;

export interface Coverage {
  state: CoverageState;
  /** Human-readable scope that was queried, e.g. "review requests for @me". */
  scopes: Array<{ scope: string; state: CoverageState; items: number; pages: number; note?: string }>;
  items: number;
  at: string;
  note?: string;
}

export interface FeatureStatus {
  id: FeatureId;
  label: string;
  description: string;
  core: boolean;
  enabled: boolean;
  readiness: ReadinessState;
  reason: string | null;
  dependsOn: { features: FeatureId[]; connections: Array<{ kinds: ConnectionKind[]; label: string; required: boolean }> };
  schedules: string[];
}

export interface ConnectionStatus {
  id: string;
  kind: ConnectionKind;
  label: string;
  status: "connected" | "needs_auth" | "error" | "disconnected" | "not_configured";
  account: string | null;
  readScopes: string[];
  writeActions: string[];
  availableScopes: Array<{ id: string; label: string; default: boolean }>;
  availableWriteActions: Array<{ id: string; label: string }>;
  settings: Record<string, unknown>;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  coverage: Coverage | null;
  authMethod: string;
  setupHelp: string;
}

export interface ConnectionDefinition {
  kind: ConnectionKind;
  label: string;
  description: string;
  /**
   * browserSignIn: after saving the fields, the user completes sign-in in the browser (OAuth).
   * reconnectHelp: what the user fixes outside Jarvis before reconnecting, for methods without browser sign-in or secrets.
   */
  authMethods: Array<{ id: string; label: string; browserSignIn?: boolean; reconnectHelp?: string; fields: Array<{ id: string; label: string; secret: boolean; placeholder?: string; optional?: boolean; help?: string }> }>;
  scopes: Array<{ id: string; label: string; default: boolean }>;
  writeActions: Array<{ id: string; label: string }>;
  setupHelp: string;
  unavoidableSteps: string[];
}

// ---------------------------------------------------------------------------
// Configuration

export const Schedules = z.object({
  syncEveryMinutes: z.number().int().min(5).max(24 * 60).default(30),
  briefingAt: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  briefingEnabled: z.boolean().default(true),
});

export const Notifications = z.object({
  desktop: z.boolean().default(false),
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable().default(null),
});

export const ModelSettings = z.object({
  provider: z.enum(["none", "claude-cli", "anthropic", "openai-compatible"]).default("none"),
  model: z.string().default(""),
  baseUrl: z.string().default(""),
});

export const Config = z.object({
  schemaVersion: z.literal(1).default(1),
  setupCompleted: z.boolean().default(false),
  setupStep: z.number().int().min(0).default(0),
  dataFolder: z.string().nullable().default(null),
  features: z.partialRecord(FeatureId, z.boolean()).default({}),
  schedules: Schedules.default({ syncEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: true }),
  notifications: Notifications.default({ desktop: false, quietHours: null }),
  identity: z.object({ name: z.string(), email: z.string() }).nullable().default(null),
});
export type Config = z.infer<typeof Config>;

export const ConfigPatch = z.object({
  setupCompleted: z.boolean().optional(),
  setupStep: z.number().int().min(0).optional(),
  features: z.partialRecord(FeatureId, z.boolean()).optional(),
  schedules: Schedules.partial().optional(),
  notifications: Notifications.partial().optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatch>;

/** The computer this service runs on. The id never changes; the owner can rename it. */
export const MACHINE_NAME_MAX = 64;
export const MachineView = z.object({ id: z.string(), name: z.string() });
export type MachineView = z.infer<typeof MachineView>;

export const MachineRename = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the Machine a name")
    .max(MACHINE_NAME_MAX, `Keep the Machine's name to ${MACHINE_NAME_MAX} characters`)
    .refine((n) => !/\p{Cc}/u.test(n), "A Machine's name cannot hold control characters"),
});
export type MachineRename = z.infer<typeof MachineRename>;

// ---------------------------------------------------------------------------
// Memory

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

export const CaptureInput = z.object({
  text: z.string().min(1).max(100_000),
  title: z.string().max(200).optional(),
  source: SourceRefInput,
  decision: z.object({ title: z.string().min(1).max(200), decision: z.string().min(1).max(5000), project: z.string().max(200).optional() }).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const MemoryCreateInput = z.object({
  type: z.enum(["person", "project", "decision", "note"]),
  title: z.string().min(1).max(200),
  /** A migrated entry keeps the date it was true and its own source line; new entries default to today. */
  state: z
    .array(z.object({ subject: z.string().min(1).max(100), value: z.string().min(1).max(5000), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), source: SourceRefInput.optional() }))
    .max(80),
  notes: z.string().max(100_000).optional(),
  sources: z.array(SourceRefInput).max(40).optional(),
  /** History carried over from an earlier system, oldest first; Jarvis appends its own creation entry. */
  history: z.array(z.string().min(1).max(2000)).max(300).optional(),
  /** "migrated": distilled from another notes system and reviewed by the user before writing. */
  provenance: z.enum(["user-stated", "migrated"]).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

/** Copy a Markdown folder verbatim into evidence/archive/<label>/ so it outlives the original. */
export const ArchiveInput = z.object({
  path: z.string().min(1),
  label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /** Path prefixes relative to the folder, e.g. "graphify-out/" or "brain/HOT.md". */
  exclude: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Where the files really come from when archiving a frozen copy, e.g. "~/OldNotes at commit 0c6becc". */
  origin: z.string().min(1).max(500).optional(),
});

export const CorrectionInput = z.object({
  relPath: z.string().min(1),
  subject: z.string().min(1).max(100),
  value: z.string().min(1).max(5000),
  reason: z.string().min(1).max(1000),
});

const SaveFact = z.object({ subject: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(5000) });
const SaveEvent = z.string().trim().min(1).max(2000);

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
    notes: z.string().max(20_000).optional(),
    events: z.array(SaveEvent).max(20).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  }),
  z.object({
    action: z.literal("update"),
    path: z.string().trim().min(1).max(500),
    facts: z.array(SaveFact.extend({ reason: z.string().trim().min(1).max(1000) })).max(50).optional(),
    events: z.array(SaveEvent).max(20).optional(),
  }),
]);
export type MemorySaveItem = z.infer<typeof MemorySaveItem>;

/**
 * What the user asked a coding agent to save (`jarvis save`). State goes into
 * `facts` (one current value per subject, replacing the old one), events into
 * `events` (appended to History). Validated as a whole before anything is written.
 */
export const MemorySaveInput = z.object({
  /** The coding-agent session the items were distilled from. */
  origin: z
    .object({
      agent: z.string().trim().min(1).max(40),
      sessionId: z.string().trim().max(200).optional(),
      cwd: z.string().max(2000).optional(),
    })
    .optional(),
  items: z.array(MemorySaveItem).min(1).max(20),
});
export type MemorySaveInput = z.infer<typeof MemorySaveInput>;

export interface MemorySaveResult {
  saved: Array<{ action: "created" | "updated"; relPath: string; absPath: string; title: string; facts: number; events: number }>;
}

/** Suggest one save item for the owner to apply or reject in the Dashboard. */
export const ProposalInput = z.object({
  item: MemorySaveItem,
  /** Why the change is suggested, shown beside it in the review list. */
  reason: z.string().trim().min(1).max(1000),
  /** The evidence the suggestion came from. */
  source: SourceRefInput.optional(),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

export interface ProposalView {
  id: string;
  status: "proposed" | "applied" | "rejected";
  /** The whole change; null when a stored Proposal can no longer be read, so it can only be rejected. */
  item: MemorySaveItem | null;
  /** The note it changes, the note it created once applied, or "(new <type>: <title>)" before that. */
  target: string;
  reason: string | null;
  /** The cited evidence, formatted as in the note. */
  source: string | null;
  proposedBy: string;
  createdAt: string;
  decidedAt: string | null;
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
  source: {
    /** Harness integration kind, e.g. `claude-code`. */
    harness: string | null;
    harnessLabel: string | null;
    sessionId: string | null;
    /** What to show: the Harness and session, or who else made the change. */
    label: string;
  };
  at: string;
  /** The change this one reverted, and the change that reverted this one. */
  revertOf: string | null;
  revertedBy: string | null;
  revert: { allowed: true; reason: null } | { allowed: false; reason: string };
}

export interface RecentChangesResult {
  changes: RecentChangeView[];
}

export interface MemoryAuditEntry {
  subject: string;
  value: string;
  date: string;
  ageDays: number;
  source: string | null;
  line: number;
  /** Deterministic problems with this entry: `stale`, `unsourced`, `missing-source`, `duplicate-subject`. */
  flags: string[];
  /** Documents that mention the note and changed after this entry was dated: where a contradiction would show up. */
  newerEvidence: Array<{ root: string; relPath: string; title: string; startLine: number; endLine: number; snippet: string; modified: string }>;
}

export interface MemoryAuditReport {
  generatedAt: string;
  dataFolder: string;
  staleDays: number;
  notes: number;
  entries: number;
  /** Counts per flag, so two runs can be compared. */
  counts: Record<string, number>;
  findings: Array<{ relPath: string; absPath: string; title: string; type: string; inSessionIndex: boolean; flags: string[]; entries: MemoryAuditEntry[] }>;
  /** Pairs of notes whose titles reduce to the same name. */
  possibleDuplicates: Array<{ title: string; relPaths: string[] }>;
}

// ---------------------------------------------------------------------------
// Recall evaluation

/** One question and the fact expected to answer it: a note in the Brain and the subject of one of its current facts. */
export const RecallQuestion = z.object({
  question: z.string().trim().min(1).max(500),
  /** The note's path inside the Brain, e.g. `memory/projects/orion-migration.md`. */
  note: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .transform((p) => p.replace(/^(\.\/)+/, ""))
    .refine((p) => p.endsWith(".md") && !p.startsWith("/") && !p.split("/").includes(".."), "must be a Markdown file's path inside the Brain"),
  /** The subject of the current fact, as written between `**` in the note. */
  fact: z.string().trim().min(1).max(100),
});
export type RecallQuestion = z.infer<typeof RecallQuestion>;

export const RecallQuestionSet = z.object({ questions: z.array(RecallQuestion).min(1).max(1000) });
export type RecallQuestionSet = z.infer<typeof RecallQuestionSet>;

/** Score a supplied question set, or, without one, the set kept in the Brain. */
export const RecallEvaluationInput = z.object({ set: RecallQuestionSet.optional() });
export type RecallEvaluationInput = z.infer<typeof RecallEvaluationInput>;

export interface RecallEvaluationHit {
  root: string;
  relPath: string;
  title: string;
  /** The fact this hit is, when it is one. */
  fact: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface RecallEvaluationReport {
  generatedAt: string;
  /** Where the questions came from: the Brain's own set (its path inside the Brain) or the caller. */
  set: { source: "brain"; path: string } | { source: "supplied" };
  /** Questions scored. Questions whose expected fact is not in the Brain are listed under `invalid` instead. */
  questions: number;
  /** How many questions have the expected fact as the first result. */
  top1: number;
  /** How many questions have the expected fact in the first three results. */
  top3: number;
  top1Rate: number;
  top3Rate: number;
  /** Every scored question whose expected fact is not the first result, with the first three results. */
  misses: Array<RecallQuestion & { rank: number | null; returned: RecallEvaluationHit[] }>;
  /** Questions that cannot be scored, because their note or fact is not in the Brain. */
  invalid: Array<RecallQuestion & { problem: string }>;
}

// ---------------------------------------------------------------------------
// Meaning-based search

/**
 * Where this Machine's meaning-based search stands. Search answers on keywords
 * in every state; vectors are only complete in `ready`.
 * - `missing`: the model is not downloaded.
 * - `downloading`: the owner started the download and it is running.
 * - `failed`: the download, or loading the downloaded model, failed; `error` says why.
 * - `building`: the model is here and vectors are being built for chunks that lack one.
 * - `ready`: every chunk in this Machine's index has a vector.
 */
export const MeaningState = z.enum(["missing", "downloading", "failed", "building", "ready"]);
export type MeaningState = z.infer<typeof MeaningState>;

export interface MeaningStatus {
  state: MeaningState;
  model: { name: string; bytes: number };
  /** Bytes received so far, while downloading. */
  download: { received: number; total: number } | null;
  /** Chunks in this Machine's index, and how many of them have a vector. */
  vectors: { chunks: number; embedded: number };
  error: string | null;
}

// ---------------------------------------------------------------------------
// Conversation

export const ChatInput = z.object({
  conversationId: z.string().nullable().optional(),
  text: z.string().min(1).max(20_000),
  context: z.object({ relPath: z.string().optional(), root: z.string().optional(), absPath: z.string().max(4096).optional(), title: z.string().max(300).optional(), selection: z.string().max(20_000).optional() }).optional(),
});

export interface MessageView {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error" | "cancelled";
  citations: Citation[];
  retrieval: { query: string; hits: number; supported: boolean; mode: "model" | "retrieval-only" } | null;
  error: string | null;
  model: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Attention

export interface AttentionItemView {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  why: string | null;
  sourceKind: string;
  connectionId: string | null;
  url: string | null;
  dueAt: string | null;
  priority: number;
  state: "open" | "dismissed" | "snoozed" | "resolved";
  snoozeUntil: string | null;
  evidence: Array<{ label: string; url?: string; relPath?: string; lines?: [number, number]; observedAt: string }>;
  firstSeenAt: string;
  updatedAt: string;
  actionId: string | null;
  changedSinceDecision: boolean;
  draftable: { actionKind: string; target: Record<string, unknown>; context: Record<string, unknown> } | null;
}

export const AttentionDecision = z.object({
  decision: z.enum(["dismiss", "snooze", "reopen", "done"]),
  until: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Jobs

export const JobKind = z.enum(["research", "briefing", "draft", "sync", "import", "reindex", "action", "demo-long", "session-distill"]);
export type JobKind = z.infer<typeof JobKind>;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";

export interface JobView {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number;
  progressNote: string | null;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  cancelOutcome: "stopped" | "too_late" | "not_started" | null;
  capability: string | null;
  connectionId: string | null;
}

export interface JobEvent {
  seq: number;
  jobId: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export const JobCreateInput = z.object({
  kind: z.enum(["research", "briefing", "draft", "sync", "import", "reindex", "demo-long"]),
  title: z.string().max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Actions (drafts and approvals)

export type ActionStatus = "draft" | "approved" | "rejected" | "expired" | "revoked" | "executing" | "succeeded" | "failed" | "unknown";

export interface ActionView {
  id: string;
  kind: string;
  connectionId: string | null;
  title: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash: string;
  version: number;
  context: Record<string, unknown>;
  status: ActionStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  approval: { version: number; payloadHash: string; nonce: string; expiresAt: string; approvedAt: string } | null;
  receipt: Record<string, unknown> | null;
  events: Array<{ event: string; data: unknown; at: string; actor: string }>;
  executable: { ok: boolean; reason: string | null };
}

export const ActionEditInput = z.object({ payload: z.record(z.string(), z.unknown()), expectedVersion: z.number().int() });
export const ActionApproveInput = z.object({ version: z.number().int(), payloadHash: z.string().length(64) });
export const ActionExecuteInput = z.object({ nonce: z.string().min(16), version: z.number().int(), payloadHash: z.string().length(64) });

// ---------------------------------------------------------------------------
// Errors

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
