import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { plural, uninstallProblem, WAITING_ACTION_STATUSES, type ConnectionKind, type ConnectionStatus, type Coverage, type DisconnectEffects, type HarnessUninstallResult } from "@attache/contracts";
import { type Db, json, nowIso, placeholders, tx } from "../core/db.ts";
import type { SecretStore } from "../platform/secret-store/index.ts";
import type { Logger } from "../core/log.ts";
import { redact } from "../core/log.ts";
import { createHttpClient, RemoteError } from "./http.ts";
import type { AdapterContext, ConnectionRecord, ConnectorAdapter, Observation, RefreshResult, TestResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { resolveEndpoint } from "./test-endpoints.ts";
import type { ClaudeConnectorRunner } from "./claude/runner.ts";
import { countOpenDecisions, recordByKey, toCandidate, type ApplyResult } from "../attention/engine.ts";
import type { Inbox } from "../attention/inbox.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import { scanDeadlines } from "./vault.ts";
import { scanFactReviews } from "../attention/fact-reviews.ts";
import { planScan, type IndexRoot } from "../memory/indexer.ts";
import type { MemoryStore } from "../memory/store.ts";

export const SINGLETON_KINDS: ConnectionKind[] = ["github", "jira", "confluence", "slack", "gmail", "gcal", "model", "claude-code", "codex", "antigravity", "claude-desktop", "pi", "opencode", "copilot-cli"];

/** Where a connection's secret lives in the secret store. Replication's credential helper reads the GitHub token by it. */
export function connectionSecretKey(connectionId: string, name: string): string {
  return `conn:${connectionId}:${name}`;
}

export interface ManagerDeps {
  db: Db;
  secrets: SecretStore;
  log: Logger;
  memory: MemoryStore;
  inbox: Inbox;
  adapters: Map<ConnectionKind, ConnectorAdapter>;
  selfEmail: () => string | null;
  claude: ClaudeConnectorRunner;
  /** Whether this Machine is the Reader, which alone raises inbox items for facts past their Review date. */
  isReader: () => boolean;
  /** The service's clock, so a source reads "now" as the Inbox does; the system clock when left out. */
  now?: () => Date;
}

/** A Connection's sign-in state before a test, a re-saved method or a browser sign-in changes it. */
export interface SignInState {
  status: string;
  /** The sign-in worked at some point before. */
  workedBefore: boolean;
  /** A Source refresh stored a read, which may now be stale. */
  read: boolean;
}

export class ConnectionManager {
  private readonly d: ManagerDeps;
  /** Hooks wired by the app: cancel dependent jobs, revoke approvals, notify clients. */
  onDisconnect: (id: string, kind: ConnectionKind) => { cancelledJobs: string[]; revokedActions: string[]; harness?: HarnessUninstallResult } = () => ({ cancelledJobs: [], revokedActions: [] });
  onChange: (id: string) => void = () => {};
  /** In-flight syncs per connection, aborted when the connection is disconnected. */
  private readonly inflight = new Map<string, Set<AbortController>>();

  constructor(deps: ManagerDeps) {
    this.d = deps;
  }

  adapter(kind: ConnectionKind): ConnectorAdapter {
    const a = this.d.adapters.get(kind);
    if (!a) throw new RemoteError(`No adapter for ${kind}`, "error");
    return a;
  }

  record(id: string): ConnectionRecord | null {
    const r = this.d.db.prepare("select * from connections where id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toRecord(r) : null;
  }

  records(): ConnectionRecord[] {
    return (this.d.db.prepare("select * from connections order by created_at").all() as Array<Record<string, unknown>>).map(toRecord);
  }

  connected(kind?: ConnectionKind): ConnectionRecord[] {
    return this.records().filter((r) => r.status === "connected" && (!kind || r.kind === kind));
  }

  private secretKey(id: string, name: string) {
    return connectionSecretKey(id, name);
  }

  context(rec: ConnectionRecord, signal?: AbortSignal): AdapterContext {
    const ctrl = new AbortController();
    const sig = signal ?? ctrl.signal;
    return {
      connection: rec,
      secret: (n) => this.d.secrets.get(this.secretKey(rec.id, n)),
      setSecret: (n, v) => this.d.secrets.set(this.secretKey(rec.id, n), v),
      http: createHttpClient({ signal: sig }),
      log: this.d.log,
      signal: sig,
      now: this.d.now ?? (() => new Date()),
      endpoint: resolveEndpoint,
      selfEmail: this.d.selfEmail(),
      claude: this.d.claude,
    };
  }

  /** All connections, plus a not-configured placeholder for every kind without one. */
  statuses(): ConnectionStatus[] {
    const recs = this.records();
    const out: ConnectionStatus[] = recs.map((r) => this.status(r));
    for (const [kind, a] of this.d.adapters) {
      if (kind === "vault") continue;
      if (!recs.some((r) => r.kind === kind)) {
        out.push({
          id: kind,
          kind,
          label: a.definition.label,
          status: "not_configured",
          account: null,
          readScopes: [],
          writeActions: [],
          availableScopes: a.definition.scopes,
          availableWriteActions: a.definition.writeActions,
          settings: {},
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastReadAt: null,
          lastError: null,
          coverage: null,
          authMethod: "",
          setupHelp: a.definition.setupHelp,
        });
      }
    }
    return out;
  }

  /** When a Source refresh last finished having read something, from the run history: a sign-in test never counts. */
  private lastReadAt(id: string): string | null {
    const row = this.d.db.prepare("select max(finished_at) at from sync_runs where connection_id = ? and outcome in ('complete', 'empty', 'partial')").get(id) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  status(r: ConnectionRecord): ConnectionStatus {
    const row = this.d.db.prepare("select * from connections where id = ?").get(r.id) as Record<string, unknown>;
    const a = this.d.adapters.get(r.kind);
    const { authMethod, ...visibleSettings } = r.settings as Record<string, unknown> & { authMethod?: string };
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      status: r.status,
      account: r.account,
      readScopes: r.readScopes,
      writeActions: r.writeActions,
      availableScopes: a?.definition.scopes ?? [],
      availableWriteActions: a?.definition.writeActions ?? [],
      settings: visibleSettings,
      lastAttemptAt: (row.last_attempt_at as string) ?? null,
      lastSuccessAt: (row.last_success_at as string) ?? null,
      lastReadAt: this.lastReadAt(r.id),
      lastError: (row.last_error as string) ?? null,
      coverage: json<Coverage | null>(row.coverage, null),
      authMethod: authMethod ?? "",
      setupHelp: a?.definition.setupHelp ?? "",
      // Read from the Harness's own files each time, so an edit made outside Attache shows at once.
      ...(a?.harness && r.status !== "disconnected" && r.status !== "not_configured" ? { harness: a.harness.status() } : {}),
    };
  }

  /** Create or reconfigure a connection from the setup form. Starts in read mode. */
  async configure(kind: ConnectionKind, fields: Record<string, string>, readScopes?: string[]): Promise<{ status: ConnectionStatus; test: TestResult }> {
    const a = this.adapter(kind);
    const now = nowIso();
    let id = SINGLETON_KINDS.includes(kind) ? kind : `vault-${randomUUID().slice(0, 8)}`;
    const existing = this.record(id);
    const scopes = readScopes ?? existing?.readScopes ?? a.definition.scopes.filter((s) => s.default).map((s) => s.id);
    refuseUnknown("scope", scopes, a.definition.scopes);
    if (!existing) {
      this.d.db
        .prepare("insert into connections (id, kind, label, status, settings, read_scopes, write_actions, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(id, kind, fields.label?.trim() || a.definition.label, "needs_auth", "{}", JSON.stringify(scopes), "[]", now, now);
    }
    const rec = this.record(id)!;
    let settings: Record<string, unknown>;
    try {
      settings = await a.configure(this.context({ ...rec, readScopes: scopes }), fields);
    } catch (e) {
      if (!existing) this.d.db.prepare("delete from connections where id = ?").run(id);
      throw e;
    }
    this.d.db.prepare("update connections set settings = ?, read_scopes = ?, status = 'needs_auth', updated_at = ? where id = ?").run(JSON.stringify(settings), JSON.stringify(scopes), nowIso(), id);
    if (a.isAuthorized && !(await a.isAuthorized(this.context(this.record(id)!)))) {
      this.onChange(id);
      return { status: this.status(this.record(id)!), test: { ok: false, state: "not_configured", account: null, message: "Saved. Continue to sign in with the provider." } };
    }
    const test = await this.test(id);
    id = rec.id;
    return { status: this.status(this.record(id)!), test };
  }

  async test(id: string): Promise<TestResult> {
    const rec = this.record(id);
    if (!rec) throw new RemoteError("Connection not found", "not_configured");
    if (rec.status === "disconnected") return { ok: false, state: "not_configured", account: null, message: "This connection is disconnected. Set it up again to reconnect." };
    const a = this.adapter(rec.kind);
    let result: TestResult;
    try {
      result = await a.test(this.context(rec));
    } catch (e) {
      const err = e as RemoteError;
      result = { ok: false, state: err.state ?? "error", account: null, message: err.message };
    }
    if (result.ok && result.settings) this.mergeSettings(id, result.settings);
    const now = nowIso();
    const status = result.ok ? "connected" : result.state === "unauthorized" || result.state === "denied" ? "needs_auth" : "error";
    this.d.db
      .prepare(`update connections set status = ?, account = coalesce(?, account), last_attempt_at = ?, ${result.ok ? "last_success_at = ?, last_error = null" : "last_error = ?, last_error_at = ?"}, updated_at = ? where id = ?`)
      .run(...([status, result.account, now, ...(result.ok ? [now] : [redact(result.message), now]), now, id] as string[]));
    this.onChange(id);
    return result;
  }

  /** Merge non-secret settings an adapter learned (a resolved site id, a registered OAuth client). */
  mergeSettings(id: string, patch: Record<string, unknown>): void {
    const rec = this.requireRecord(id);
    this.d.db.prepare("update connections set settings = ?, updated_at = ? where id = ?").run(JSON.stringify({ ...rec.settings, ...patch }), nowIso(), id);
  }

  setScopes(id: string, readScopes: string[]): ConnectionStatus {
    const rec = this.requireRecord(id);
    refuseUnknown("scope", readScopes, this.adapter(rec.kind).definition.scopes);
    this.d.db.prepare("update connections set read_scopes = ?, updated_at = ? where id = ?").run(JSON.stringify(readScopes), nowIso(), id);
    this.onChange(id);
    return this.status(this.record(id)!);
  }

  /** Write authority is granted separately from read access, per action. */
  setWriteActions(id: string, actions: string[]): { status: ConnectionStatus; revoked: string[] } {
    const rec = this.requireRecord(id);
    refuseUnknown("write action", actions, this.adapter(rec.kind).definition.writeActions);
    this.d.db.prepare("update connections set write_actions = ?, updated_at = ? where id = ?").run(JSON.stringify(actions), nowIso(), id);
    this.d.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), "user", "write_authority_changed", JSON.stringify({ id, actions }));
    this.onChange(id);
    return { status: this.status(this.record(id)!), revoked: [] };
  }

  requireRecord(id: string): ConnectionRecord {
    const r = this.record(id);
    if (!r) throw new RemoteError("Connection not found", "not_configured");
    return r;
  }

  disconnectEffects(id: string): DisconnectEffects {
    const rec = this.requireRecord(id);
    const count = (sql: string, ...args: string[]) => Number((this.d.db.prepare(sql).get(...args) as { n: number }).n);
    return {
      observations: count("select count(*) n from observations where connection_id = ?", id),
      attentionItems: count("select count(*) n from attention_items where connection_id = ? and state != 'resolved'", id),
      drafts: count(`select count(*) n from actions where connection_id = ? and status in (${placeholders(WAITING_ACTION_STATUSES)})`, id, ...WAITING_ACTION_STATUSES),
      queuedJobs: count("select count(*) n from jobs where connection_id = ? and status in ('queued','running','blocked')", id),
      indexedDocuments: rec.kind === "vault" ? count("select count(*) n from documents where root = ?", `import:${id}`) : 0,
      credentials: this.adapter(rec.kind).secretNames.length,
    };
  }

  /**
   * Disconnect: delete credentials, stop new requests, cancel dependent queued
   * work, revoke approvals that target this connection, and keep or delete the
   * retained data according to the user's explicit choice.
   */
  async disconnect(id: string, opts: { deleteData: boolean }): Promise<{ effects: DisconnectEffects; cancelledJobs: string[]; revokedActions: string[]; harness?: HarnessUninstallResult; deleted: boolean }> {
    const rec = this.requireRecord(id);
    if (rec.settings.builtin) throw new RemoteError("The Attache data folder cannot be disconnected; export a backup or uninstall instead.", "error");
    const effects = this.disconnectEffects(id);
    // Stop requests already in flight for this connection.
    for (const c of this.inflight.get(id) ?? []) c.abort(new Error("connection disconnected"));
    for (const n of this.adapter(rec.kind).secretNames) await this.d.secrets.delete(this.secretKey(id, n));
    this.d.db.prepare("update connections set status = 'disconnected', write_actions = '[]', updated_at = ? where id = ?").run(nowIso(), id);
    const hooks = this.onDisconnect(id, rec.kind);
    // What a Harness could not remove stays on the Connection, so the owner can see what remains and recover it.
    const remains = hooks.harness ? uninstallProblem(hooks.harness) : null;
    if (remains) this.d.db.prepare("update connections set last_error = ?, last_error_at = ? where id = ?").run(remains, nowIso(), id);
    if (opts.deleteData) {
      tx(this.d.db, () => {
        this.d.db.prepare("delete from observations where connection_id = ?").run(id);
        this.d.db.prepare("delete from sync_runs where connection_id = ?").run(id);
        this.d.db.prepare("update actions set status = 'rejected', updated_at = ? where connection_id = ? and status in ('draft','revoked')").run(nowIso(), id);
      });
      if (rec.kind === "vault") this.d.memory.indexer.removeRoot(`import:${id}`);
      this.d.db.prepare("delete from connections where id = ?").run(id);
    }
    this.d.inbox.disconnected(id, opts.deleteData);
    this.d.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), "user", "connection_disconnected", JSON.stringify({ id, deleteData: opts.deleteData, effects }));
    this.onChange(id);
    return { effects, ...hooks, deleted: opts.deleteData };
  }

  // ---- migration ---------------------------------------------------------------

  /**
   * Connections made before Jira/Confluence moved to the Atlassian MCP server and Slack/Gmail/Calendar
   * to the claude.ai connectors: their stored credentials no longer apply. Delete them, keep the
   * choices (site, channels, scopes, write authority) and ask the user to set the connection up again.
   * Runs once per connection; reconfiguring replaces the settings.
   */
  async migrateLegacyTransports(): Promise<string[]> {
    const LEGACY_SECRETS = ["token", "apiToken", "clientSecret", "refreshToken", "accessToken", "accessTokenExpiresAt", "refresh_token", "access_token", "access_expiry"];
    const migrated: string[] = [];
    for (const rec of this.records()) {
      if (rec.status === "disconnected" || rec.settings.migratedTransport) continue;
      const claudeKind = rec.kind === "slack" || rec.kind === "gmail" || rec.kind === "gcal";
      const atlassianKind = rec.kind === "jira" || rec.kind === "confluence";
      const legacy = (claudeKind && rec.settings.authMethod !== "claude-ai") || (atlassianKind && rec.settings.transport !== "mcp");
      if (!legacy) continue;
      for (const n of LEGACY_SECRETS) await this.d.secrets.delete(this.secretKey(rec.id, n));
      const how = claudeKind ? "your claude.ai connector through Claude Code" : "the Atlassian Rovo MCP server";
      const message = `Attache now connects to ${rec.label} through ${how}. The old credentials were removed; set this connection up again.`;
      this.d.db
        .prepare("update connections set status = 'needs_auth', settings = ?, last_error = ?, last_error_at = ?, updated_at = ? where id = ?")
        .run(JSON.stringify({ ...rec.settings, migratedTransport: nowIso() }), message, nowIso(), nowIso(), rec.id);
      this.d.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), "system", "connection_transport_migrated", JSON.stringify({ id: rec.id, kind: rec.kind, from: rec.settings.authMethod ?? null }));
      this.onChange(rec.id);
      migrated.push(rec.id);
    }
    return migrated;
  }

  // ---- Source refresh --------------------------------------------------------

  previousCoverage(id: string): Coverage | null {
    const row = this.d.db.prepare("select coverage from sync_runs where connection_id = ? and finished_at is not null order by started_at desc limit 1").get(id) as { coverage: string } | undefined;
    return json<Coverage | null>(row?.coverage, null);
  }

  /** Run one Source refresh of a connection: fetch, archive observations, update attention. */
  /**
   * What a refresh can change of the decision count: the open Inbox items that count (no waiting Draft) and the
   * Connections that need a sign-in. Measured just before and after a refresh's writes, which run in one
   * synchronous stretch, so nothing else (an owner's decision) lands in between.
   */
  private decisionWeight(): number {
    return countOpenDecisions(this.d.db) + this.countSignIns();
  }

  /** How many Connections need a sign-in (`needs_auth`): the Decision count's Connections part. */
  countSignIns(): number {
    return Number((this.d.db.prepare("select count(*) n from connections where status = 'needs_auth'").get() as { n: number }).n);
  }

  /** A Connection's sign-in state, read before a test, a re-saved method or a browser sign-in changes it. */
  signInState(id: string): SignInState | null {
    const row = this.d.db.prepare("select status, last_success_at, coverage from connections where id = ?").get(id) as { status: string; last_success_at: string | null; coverage: string | null } | undefined;
    return row ? { status: row.status, workedBefore: !!row.last_success_at, read: !!row.coverage } : null;
  }

  /** `countDelta`: how much this refresh's own writes changed the decision count (see `decisionWeight`). */
  async refresh(id: string, signal?: AbortSignal): Promise<{ coverage: Coverage; attention: ApplyResult; observations: number; countDelta: number }> {
    const rec = this.requireRecord(id);
    if (rec.status === "disconnected") throw new RemoteError("Connection is disconnected", "not_configured");
    const runId = randomUUID();
    const started = nowIso();
    this.d.db.prepare("insert into sync_runs (id, connection_id, started_at) values (?,?,?)").run(runId, id, started);
    this.d.db.prepare("update connections set last_attempt_at = ? where id = ?").run(started, id);
    const previous = this.previousCoverage(id);
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort);
    const set = this.inflight.get(id) ?? new Set<AbortController>();
    set.add(ctrl);
    this.inflight.set(id, set);
    let result: RefreshResult;
    try {
      result = rec.kind === "vault" ? this.refreshVault(rec) : await this.refreshRemote(rec, ctrl.signal);
    } catch (e) {
      const err = e as RemoteError;
      const cov = new CoverageTracker();
      cov.add("all", err.state ?? "error", 0, 0, err.message);
      result = { coverage: cov.finish(err.message), observations: [] };
    } finally {
      set.delete(ctrl);
      signal?.removeEventListener("abort", onOuterAbort);
    }
    // A disconnect during the refresh wins: store nothing and do not revive the connection.
    const current = this.record(id);
    if (!current || current.status === "disconnected" || ctrl.signal.aborted) {
      this.d.db.prepare("update sync_runs set finished_at = ?, outcome = 'cancelled', error = 'connection disconnected or Source refresh cancelled' where id = ?").run(nowIso(), runId);
      if (signal?.aborted) throw new RemoteError("Source refresh cancelled", "error");
      return { coverage: { state: "not_configured", scopes: [], items: 0, at: nowIso(), note: "Connection was disconnected during the Source refresh" }, attention: { created: [], changed: [], unchanged: [], resolved: [], keptDismissed: [], reopened: [], touched: [] }, observations: 0, countDelta: 0 };
    }
    const weightBefore = this.decisionWeight();
    const attention = this.store(current, result, previous);
    const ok = result.coverage.state === "complete" || result.coverage.state === "empty" || result.coverage.state === "partial";
    const now = nowIso();
    const errText = result.coverage.state === "complete" || result.coverage.state === "empty" ? null : redact(result.coverage.scopes.filter((s) => s.note).map((s) => `${s.scope}: ${s.note}`).join("; ") || result.coverage.state);
    this.d.db.prepare("update sync_runs set finished_at = ?, outcome = ?, coverage = ?, item_count = ?, error = ? where id = ?").run(now, result.coverage.state, JSON.stringify(result.coverage), result.observations.length, errText, runId);
    const newStatus = result.coverage.state === "unauthorized" ? "needs_auth" : current.status === "needs_auth" && ok ? "connected" : current.status;
    this.d.db
      .prepare(`update connections set coverage = ?, status = ?, ${ok ? "last_success_at = ?," : ""} last_error = ?, ${errText ? "last_error_at = ?," : ""} updated_at = ? where id = ? and status != 'disconnected'`)
      .run(...([JSON.stringify(result.coverage), newStatus, ...(ok ? [now] : []), errText, ...(errText ? [now] : []), now, id] as Array<string | null>));
    const countDelta = this.decisionWeight() - weightBefore;
    this.onChange(id);
    return { coverage: result.coverage, attention, observations: result.observations.length, countDelta };
  }

  private async refreshRemote(rec: ConnectionRecord, signal?: AbortSignal): Promise<RefreshResult> {
    const a = this.adapter(rec.kind);
    if (!a.refresh) throw new RemoteError(`${a.definition.label} has nothing to refresh`, "not_configured");
    return a.refresh(this.context(rec, signal));
  }

  vaultRoot(rec: ConnectionRecord): IndexRoot | null {
    if (rec.settings.builtin) return this.d.memory.rootRef;
    const path = String(rec.settings.path ?? "");
    return path ? { id: `import:${rec.id}`, path, label: rec.label } : null;
  }

  private refreshVault(rec: ConnectionRecord): RefreshResult {
    const cov = new CoverageTracker();
    const root = this.vaultRoot(rec);
    if (!root || !existsSync(root.path)) {
      cov.add("folder", "error", 0, 0, root ? `Folder not found: ${root.path}` : "No folder configured");
      return { coverage: cov.finish(), observations: [] };
    }
    const idx = this.d.memory.indexer.scan(root);
    const docs = (this.d.db.prepare("select rel_path from documents where root = ?").all(root.id) as Array<{ rel_path: string }>).map((r) => r.rel_path).filter((p) => !p.startsWith("evidence/conversations/"));
    const now = new Date();
    const deadlines = scanDeadlines(root, docs, now);
    const reviews = rec.settings.builtin ? this.factReviews(root, docs, now) : { observations: [], errors: [] };
    const observations = [...deadlines.observations, ...reviews.observations];
    const errors = [...deadlines.errors, ...reviews.errors];
    cov.add(`${plural(docs.length, "Markdown file")} indexed (${idx.indexed} updated, ${idx.removed} removed)`, idx.errors.length || errors.length ? "partial" : observations.length ? "complete" : "empty", observations.length, 1, [...idx.errors.map((e) => `${e.path}: ${e.error}`), ...errors].slice(0, 5).join("; ") || undefined);
    return { coverage: cov.finish(), observations };
  }

  /**
   * Inbox items for facts past their Review date, read from the Brain as part of the data folder's Source refresh.
   * Only the Reader raises them. Another Machine still observes every such fact, so a refresh it starts by hand
   * leaves the items the Reader raised as they are (an item whose fact is no longer observed is resolved),
   * but it raises none of its own: a fact without an item yet is observed without one.
   */
  private factReviews(root: IndexRoot, docs: readonly string[], now: Date) {
    const found = scanFactReviews(root.path, docs, now);
    if (this.d.isReader()) return found;
    const withoutNewItems = (o: Observation): Observation => {
      if (!o.attention || recordByKey(this.d.db, o.attention.key)) return o;
      const { attention: _raisedOnlyByTheReader, ...observed } = o;
      return observed;
    };
    return { ...found, observations: found.observations.map(withoutNewItems) };
  }

  private store(rec: ConnectionRecord, result: RefreshResult, previous: Coverage | null): ApplyResult {
    const now = nowIso();
    const complete = result.coverage.state === "complete" || result.coverage.state === "empty";
    tx(this.d.db, () => {
      const seen = new Set<string>();
      for (const o of result.observations) {
        const key = `${o.kind}\0${o.externalId}`;
        seen.add(key);
        const fp = fingerprint(o.fingerprintParts);
        this.d.db
          .prepare(
            `insert into observations (id, connection_id, kind, external_id, fingerprint, title, url, author, data, occurred_at, observed_at, first_seen_at)
             values (?,?,?,?,?,?,?,?,?,?,?,?)
             on conflict(connection_id, kind, external_id) do update set fingerprint = excluded.fingerprint, title = excluded.title, url = excluded.url,
               author = excluded.author, data = excluded.data, occurred_at = excluded.occurred_at, observed_at = excluded.observed_at, removed_at = null`,
          )
          .run(randomUUID(), rec.id, o.kind, o.externalId, fp, redact(o.title), o.url ?? null, o.author ?? null, redact(JSON.stringify(o.data)), o.occurredAt ?? null, now, now);
      }
      if (complete) {
        const rows = this.d.db.prepare("select id, kind, external_id from observations where connection_id = ? and removed_at is null").all(rec.id) as Array<{ id: string; kind: string; external_id: string }>;
        for (const r of rows) if (!seen.has(`${r.kind}\0${r.external_id}`)) this.d.db.prepare("update observations set removed_at = ? where id = ?").run(now, r.id);
      }
    });
    this.archive(rec, result.observations);
    const candidates = result.observations
      .filter((o): o is Observation & { attention: NonNullable<Observation["attention"]> } => !!o.attention)
      .map((o) => {
        const c = toCandidate(o.attention, o, rec.kind, rec.id, now);
        if (rec.kind === "vault") {
          const d = o.data as { relPath: string; line: number; root: string };
          c.evidence = [{ label: `${d.relPath} line ${d.line}`, relPath: d.relPath, lines: [d.line, d.line], observedAt: now }];
        }
        return c;
      });
    return this.d.inbox.apply({ sourceKind: rec.kind, connectionId: rec.id, coverage: result.coverage, previousCoverage: previous }, candidates);
  }

  /** Archive remote observations as evidence Markdown so recall can cite them. */
  private archive(rec: ConnectionRecord, observations: Observation[]) {
    if (rec.kind === "vault" || !this.d.memory.dataRoot) return;
    const lines = observations.slice(0, 200).map((o) => `- **${o.kind}** ${o.externalId}: ${o.title.replace(/\n/g, " ")}${o.author ? ` (by ${o.author})` : ""}${o.occurredAt ? `, ${o.occurredAt.slice(0, 10)}` : ""}${o.url ? ` — ${o.url}` : ""}`);
    try {
      this.d.memory.writeConnectorSnapshot(rec.kind, rec.label, lines);
    } catch (e) {
      this.d.log.warn("observation archive failed", { error: (e as Error).message });
    }
  }

  // ---- import folders ------------------------------------------------------------

  previewImport(path: string) {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new RemoteError(`Folder not found: ${abs}`, "error");
    const plan = planScan(abs);
    return { path: abs, filesToRead: plan.read.length, sample: plan.read.slice(0, 20), skipped: plan.skipped.slice(0, 50), skippedCount: plan.skipped.length, totalBytes: plan.totalBytes, filesChanged: 0, note: "Attache reads these files and indexes them. It does not modify, move or delete anything in this folder." };
  }
}

/** Refuses ids the connector does not define, naming each one: "2 unknown scopes: a, b". */
function refuseUnknown(noun: string, ids: string[], defined: Array<{ id: string }>): void {
  const unknown = ids.filter((id) => !defined.some((d) => d.id === id));
  if (unknown.length) throw new RemoteError(`${plural(unknown.length, `unknown ${noun}`)}: ${unknown.join(", ")}`, "error");
}

function toRecord(r: Record<string, unknown>): ConnectionRecord {
  return {
    id: String(r.id),
    kind: r.kind as ConnectionKind,
    label: String(r.label),
    status: r.status as ConnectionRecord["status"],
    settings: json(r.settings, {}),
    readScopes: json(r.read_scopes, []),
    writeActions: json(r.write_actions, []),
    account: (r.account as string) ?? null,
  };
}
