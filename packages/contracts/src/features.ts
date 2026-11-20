import { z } from "zod";
import type { HarnessCapabilities, HarnessFileChange, HarnessStatusReport } from "./harness.ts";

/** API contract: Features and connections. */

export const FeatureId = z.enum(["recall", "capture", "attention", "drafts", "jobs", "sessions"]);
export type FeatureId = z.infer<typeof FeatureId>;

export const ConnectionKind = z.enum(["vault", "github", "jira", "confluence", "slack", "gmail", "gcal", "model", "claude-code", "codex", "antigravity", "claude-desktop"]);
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
  /** When the connection last answered: a passed sign-in test or a Source refresh that read something. */
  lastSuccessAt: string | null;
  /** When a Source refresh of this connection last finished with something read (complete, empty or partial); null when none has. */
  lastReadAt: string | null;
  lastError: string | null;
  coverage: Coverage | null;
  authMethod: string;
  setupHelp: string;
  /** Harness Connections that are set up: the state of Attache's entries in the Harness, judged from its files (ADR 0006). */
  harness?: HarnessStatusReport;
}

/** What disconnecting a connection would do, shown before the owner confirms (`GET /connections/:id/disconnect-preview`). */
export interface DisconnectEffects {
  observations: number;
  attentionItems: number;
  drafts: number;
  queuedJobs: number;
  indexedDocuments: number;
  credentials: number;
}

export interface ConnectionDefinition {
  kind: ConnectionKind;
  label: string;
  description: string;
  /**
   * browserSignIn: after saving the fields, the user completes sign-in in the browser (OAuth).
   * reconnectHelp: what the user fixes outside Attache before reconnecting, for methods without browser sign-in or secrets.
   * reconnectHelp and a field's help are one line of Markdown each: a command goes in a code span, and a URL becomes a link.
   */
  authMethods: Array<{ id: string; label: string; browserSignIn?: boolean; reconnectHelp?: string; fields: Array<{ id: string; label: string; secret: boolean; placeholder?: string; optional?: boolean; help?: string }> }>;
  scopes: Array<{ id: string; label: string; default: boolean }>;
  writeActions: Array<{ id: string; label: string }>;
  setupHelp: string;
  unavoidableSteps: string[];
  /** Harness Connections: what connecting gives the Harness, each capability on its own, and whether it must be restarted. */
  harness?: { capabilities: HarnessCapabilities; restartRequired: boolean };
}

/** What connecting a Harness would change (`GET /connections/:kind/harness-preview`), worked out without writing anything. */
export interface HarnessConnectionPreview {
  changes: HarnessFileChange[];
  restartRequired: boolean;
  capabilities: HarnessCapabilities;
}
