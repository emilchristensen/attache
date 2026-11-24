import type { ConnectionDefinition, ConnectionKind, Coverage, CoverageState, InboxKind, MeetingTimes } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import type { HttpClient } from "./http.ts";
import type { ClaudeConnectorRunner } from "./claude/runner.ts";
import type { HarnessAdapter } from "../agents/harness-adapters.ts";

export interface ConnectionRecord {
  id: string;
  kind: ConnectionKind;
  label: string;
  status: "connected" | "needs_auth" | "error" | "disconnected" | "not_configured";
  settings: Record<string, unknown>;
  readScopes: string[];
  writeActions: string[];
  account: string | null;
}

export interface AdapterContext {
  connection: ConnectionRecord;
  secret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  http: HttpClient;
  log: Logger;
  signal: AbortSignal;
  now: () => Date;
  /** Base URL override for contract tests; only honoured when ATTACHE_TEST_ENDPOINTS=1. */
  endpoint(defaultBase: string): string;
  /** Identity of the user (email) for "sent by me" classification. */
  selfEmail: string | null;
  /** Reaches the user's claude.ai connectors through Claude Code (Slack, Gmail, Google Calendar). */
  claude: ClaudeConnectorRunner;
}

export interface Observation {
  kind: string;
  externalId: string;
  title: string;
  url?: string;
  author?: string;
  occurredAt?: string;
  data: Record<string, unknown>;
  /** Material parts that define "changed"; never include transport-dependent timestamps. */
  fingerprintParts: Array<string | number | boolean | null>;
  attention?: AttentionCandidate;
}

export interface AttentionCandidate {
  key: string;
  /** One of the kinds the Dashboard knows; add a new one to `INBOX_KINDS` first. */
  kind: InboxKind;
  title: string;
  summary: string;
  why: string;
  url?: string;
  dueAt?: string | null;
  priority: number;
  /** Parts added to the observation fingerprint (e.g. the due/overdue category). */
  extraFingerprint?: Array<string | number | boolean | null>;
  draftable?: { actionKind: string; target: Record<string, unknown>; context: Record<string, unknown> };
  /** Meeting prep only: the meeting's times, call and attendees. */
  meeting?: MeetingTimes;
}

export interface RefreshResult {
  coverage: Coverage;
  observations: Observation[];
}

export interface TestResult {
  ok: boolean;
  state: CoverageState;
  account: string | null;
  message: string;
  grantedScopes?: string[];
  /** Non-secret settings learned while testing (e.g. a resolved site id), merged into the connection. */
  settings?: Record<string, unknown>;
}

export interface ExecuteResult {
  /** Only true when the remote confirmed the effect (id returned and, where possible, read back). */
  verified: boolean;
  remoteId?: string;
  url?: string;
  detail: Record<string, unknown>;
}

export interface ConnectorAdapter {
  kind: ConnectionKind;
  definition: ConnectionDefinition;
  /** Store credentials from the setup form; returns the non-secret settings to persist. */
  configure(ctx: AdapterContext, fields: Record<string, string>): Promise<Record<string, unknown>>;
  test(ctx: AdapterContext): Promise<TestResult>;
  refresh?(ctx: AdapterContext): Promise<RefreshResult>;
  execute?(ctx: AdapterContext, action: { kind: string; target: Record<string, unknown>; payload: Record<string, unknown>; effectKey: string }): Promise<ExecuteResult>;
  /**
   * Look for an effect already applied with this key (restart recovery). `since` is when the pending
   * attempt started; matches older than that are someone else's. Throwing means "could not check".
   */
  findEffect?(ctx: AdapterContext, action: { kind: string; target: Record<string, unknown>; payload: Record<string, unknown>; effectKey: string; since?: string }): Promise<ExecuteResult | null>;
  /** OAuth adapters: scopes to request; includeWrite adds what the enabled write actions need. */
  oauthScopes?(includeWrite: boolean): string[];
  /** OAuth adapters: the browser URL that starts authorization (PKCE, S256), plus settings to persist first (e.g. a registered client). */
  authorizeUrl?(ctx: AdapterContext, p: { redirectUri: string; state: string; codeChallenge: string; scopes: string[] }): Promise<{ url: string; settings?: Record<string, unknown> }>;
  /** OAuth adapters: exchange the authorization code, store tokens as secrets, return account and settings to persist. */
  completeAuthorization?(ctx: AdapterContext, p: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ account: string | null; settings: Record<string, unknown> }>;
  /** Whether usable credentials are stored; OAuth adapters report false until browser sign-in completed. */
  isAuthorized?(ctx: AdapterContext): Promise<boolean>;
  /** Extra read-only context for preparing a draft (e.g. PR changed files). */
  prepareContext?(ctx: AdapterContext, target: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Secret names this adapter stores. */
  secretNames: string[];
  /** Harness Connections: the adapter boundary (ADR 0006) that previews, applies, checks and removes this Attache's entries. */
  harness?: HarnessAdapter;
}

export class CoverageTracker {
  private scopes: Coverage["scopes"] = [];
  private readonly started = new Date().toISOString();

  add(scope: string, state: CoverageState, items: number, pages: number, note?: string) {
    this.scopes.push({ scope, state, items, pages, ...(note ? { note } : {}) });
  }

  get items(): number {
    return this.scopes.reduce((n, s) => n + s.items, 0);
  }

  /** Overall state: the worst scope wins; a successful zero is "empty", never "complete with nothing". */
  finish(note?: string): Coverage {
    const order: CoverageState[] = ["unauthorized", "denied", "offline", "error", "partial", "not_configured", "complete", "empty", "never_run"];
    // Opt-in scopes with nothing configured are shown but do not make the whole source partial.
    const configured = this.scopes.filter((s) => s.state !== "not_configured");
    const states = (configured.length ? configured : this.scopes).map((s) => s.state);
    let state: CoverageState = "never_run";
    if (states.length) {
      const worst = order.find((o) => states.includes(o) && o !== "complete" && o !== "empty");
      if (worst) {
        const anyOk = states.some((s) => s === "complete" || s === "empty");
        state = anyOk && worst !== "unauthorized" ? "partial" : worst;
      } else state = this.items === 0 ? "empty" : "complete";
    }
    return { state, scopes: this.scopes, items: this.items, at: this.started, ...(note ? { note } : {}) };
  }
}

export const isFullyCovered = (c: Coverage | null | undefined): boolean => c?.state === "complete" || c?.state === "empty";
