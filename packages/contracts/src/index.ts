import { z } from "zod";

/** Versioned API contract shared by the service, browser client, Obsidian plugin and any future client. */
export const API_VERSION = "v1";
export const API_PREFIX = `/api/${API_VERSION}`;

// ---------------------------------------------------------------------------
// Features and connections

export const FeatureId = z.enum(["conversation", "recall", "capture", "attention", "drafts", "jobs", "voice", "sessions"]);
export type FeatureId = z.infer<typeof FeatureId>;

export const ConnectionKind = z.enum(["vault", "github", "jira", "confluence", "slack", "gmail", "gcal", "model", "speech", "claude-code", "codex", "antigravity"]);
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
  authMethods: Array<{ id: string; label: string; fields: Array<{ id: string; label: string; secret: boolean; placeholder?: string; optional?: boolean; help?: string }> }>;
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

export const SpeechSettings = z.object({
  stt: z.enum(["none", "whisper-local", "openai-compatible", "browser"]).default("none"),
  tts: z.enum(["none", "macos-say", "openai-compatible", "browser"]).default("none"),
  voice: z.string().default(""),
  baseUrl: z.string().default(""),
  sttModel: z.string().default(""),
  ttsModel: z.string().default(""),
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
  kind: z.enum(["capture", "note", "import", "connector", "conversation", "user"]),
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
  state: z.array(z.object({ subject: z.string().min(1).max(100), value: z.string().min(1).max(5000) })).max(50),
  notes: z.string().max(100_000).optional(),
  sources: z.array(SourceRefInput).max(20).optional(),
});

export const CorrectionInput = z.object({
  relPath: z.string().min(1),
  subject: z.string().min(1).max(100),
  value: z.string().min(1).max(5000),
  reason: z.string().min(1).max(1000),
});

// ---------------------------------------------------------------------------
// Conversation

export const ChatInput = z.object({
  conversationId: z.string().nullable().optional(),
  text: z.string().min(1).max(20_000),
  context: z.object({ relPath: z.string().optional(), root: z.string().optional(), absPath: z.string().max(4096).optional(), title: z.string().max(300).optional(), selection: z.string().max(20_000).optional() }).optional(),
  voice: z.boolean().optional(),
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
