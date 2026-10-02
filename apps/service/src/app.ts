import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ConnectionKind, FeatureId, JobView } from "@jarvis/contracts";
import { openDb, type Db, nowIso } from "./core/db.ts";
import { createLogger, type Logger } from "./core/log.ts";
import { resolvePaths, type ServicePaths } from "./core/paths.ts";
import { createCredentialStore, type CredentialStore } from "./core/secrets.ts";
import { ConfigStore } from "./core/config.ts";
import { MemoryStore } from "./memory/store.ts";
import { ConnectionManager } from "./connectors/manager.ts";
import { ADAPTERS } from "./connectors/index.ts";
import { JobQueue } from "./jobs/queue.ts";
import { Scheduler } from "./jobs/scheduler.ts";
import { ActionService } from "./actions/service.ts";
import { ConversationService } from "./conversation/service.ts";
import { FEATURES, computeStatus, effectiveFeatures, featureDef, isEnabled } from "./capabilities/registry.ts";
import { providerFor } from "./connectors/model.ts";
import type { ModelProvider } from "./models/providers.ts";
import { registerRunners } from "./jobs/runners.ts";
import { wakeSnoozed } from "./attention/engine.ts";
import { SpeechService } from "./speech/service.ts";
import { AgentSessions } from "./agents/sessions.ts";
import { AGENT_INTEGRATIONS, integrationFor } from "./agents/integrations.ts";
import { agentAdapter } from "./connectors/agent.ts";

export interface AppOptions {
  stateDir?: string;
  instance?: string;
  quiet?: boolean;
  schedulerTickMs?: number;
  jobConcurrency?: number;
}

export const VERSION = process.env.JARVIS_VERSION ?? "0.1.0";

/** Everything the service owns, wired together. Clients only reach it through the HTTP API. */
export class App {
  readonly paths: ServicePaths;
  readonly instance: string;
  readonly db: Db;
  readonly log: Logger;
  readonly secrets: CredentialStore;
  readonly config: ConfigStore;
  readonly memory: MemoryStore;
  readonly connections: ConnectionManager;
  readonly jobs: JobQueue;
  readonly scheduler: Scheduler;
  readonly actions: ActionService;
  readonly conversations: ConversationService;
  readonly speech: SpeechService;
  readonly sessions: AgentSessions;
  private readonly adapters: typeof ADAPTERS;
  /** Service-wide event bus for the client SSE stream. */
  readonly bus = new EventEmitter();
  /** Open event streams per client, closed when the client is revoked or logs out. */
  readonly streams = new Map<string, Set<() => void>>();

  closeStreams(clientId: string) {
    for (const close of this.streams.get(clientId) ?? []) close();
    this.streams.delete(clientId);
  }
  readonly startedAt = nowIso();
  private cachedModel: { key: string; provider: ModelProvider | null } | null = null;

  constructor(opts: AppOptions = {}) {
    this.paths = resolvePaths(opts.stateDir);
    this.instance = opts.instance ?? process.env.JARVIS_INSTANCE ?? "default";
    this.log = createLogger(this.paths.logDir, { quiet: opts.quiet ?? false });
    this.db = openDb(this.paths.dbFile);
    this.secrets = createCredentialStore({ stateDir: this.paths.stateDir, secretsFile: this.paths.secretsFile, instance: this.instance });
    this.config = new ConfigStore(this.db);
    this.memory = new MemoryStore(this.db, null, this.instance);
    this.bus.setMaxListeners(500);
    this.sessions = new AgentSessions(this);
    // Agent connections install hooks for this instance's state folder, so they are built per App.
    this.adapters = new Map([...ADAPTERS, ...AGENT_INTEGRATIONS.map((a) => [a.kind, agentAdapter(a, this.sessions.hooks, () => this.sessions.contextText())] as const)]);
    this.connections = new ConnectionManager({
      db: this.db,
      secrets: this.secrets,
      log: this.log,
      memory: this.memory,
      adapters: this.adapters,
      selfEmail: () => this.config.get().identity?.email ?? null,
    });
    this.jobs = new JobQueue(this.db, this.log, { concurrency: opts.jobConcurrency ?? 2 });
    this.scheduler = new Scheduler(this.db, this.log, { tickMs: opts.schedulerTickMs ?? 15_000 });
    this.actions = new ActionService(this.db);
    this.conversations = new ConversationService(this.db, this.memory, this.log);
    this.speech = new SpeechService(this);
    this.wire();
    registerRunners(this);
  }

  private wire() {
    this.conversations.getModel = () => this.modelSync();
    this.conversations.getIdentity = () => this.config.get().identity;
    this.conversations.events.on("event", (ev) => this.bus.emit("event", ev));
    this.jobs.events.on("event", (ev) => this.bus.emit("event", { type: "job.event", event: ev }));
    this.connections.onChange = (id) => {
      this.cachedModel = null;
      this.bus.emit("event", { type: "connections.changed", id });
    };
    this.connections.onDisconnect = (id, kind) => {
      const agent = integrationFor(kind);
      if (agent) {
        try {
          this.sessions.hooks.uninstall(agent);
        } catch (e) {
          this.log.error("could not remove agent hooks", { agent: kind, error: (e as Error).message });
        }
      }
      const cancelledJobs = this.jobs.cancelWhere((j) => j.connectionId === id || (kind === "model" && (j.kind === "research" || j.kind === "draft")), `Connection ${id} was disconnected`);
      const revokedActions = this.actions.revokeWhere((a) => a.connectionId === id, "connection disconnected");
      return { cancelledJobs, revokedActions };
    };
    this.jobs.gate = (job) => this.jobGate(job);
    this.jobs.onUnsuccessful = (job) => {
      if (job.kind !== "action") return;
      const row = this.db.prepare("select input from jobs where id = ?").get(job.id) as { input: string } | undefined;
      const actionId = row ? String((JSON.parse(row.input) as { actionId?: string }).actionId ?? "") : "";
      const a = actionId ? this.actions.get(actionId) : null;
      if (!a || a.status !== "executing") return;
      const effect = this.db.prepare("select status from side_effects where effect_key = ?").get(`action:${a.id}:v${a.version}`) as { status: string } | undefined;
      // Never leave an action "executing": record what is known about whether it was sent.
      this.actions.finishExecution(a.id, effect?.status === "pending" ? { status: "unknown", receipt: { error: job.error ?? job.status, note: "Stopped while sending; check the target before sending again." } } : { status: "failed", receipt: { error: job.error ?? `Execution ${job.status}`, attempted: false } });
      this.bus.emit("event", { type: "actions.changed", id: a.id });
    };
    this.actions.authority = (a) => this.actionAuthority(a.kind, a.connectionId);
    this.scheduler.enqueue = (row, reason) => {
      if (row.jobKind === "sync") return this.jobs.create({ kind: "sync", title: `Refresh sources (${reason === "catch_up" ? "catch-up" : "scheduled"})`, input: { all: true, reason }, capability: "attention", idempotencyKey: `sched:${row.id}:${Math.floor(Date.now() / 60_000)}` }).job.id;
      if (row.jobKind === "briefing") return this.jobs.create({ kind: "briefing", title: `Daily briefing${reason === "catch_up" ? " (catch-up)" : ""}`, input: { kind: "daily", reason }, capability: "attention", idempotencyKey: `sched:${row.id}:${new Date().toISOString().slice(0, 10)}` }).job.id;
      return null;
    };
    this.scheduler.onResume = (gapMs) => this.bus.emit("event", { type: "service.resumed", gapMs });
  }

  // ---- model ---------------------------------------------------------------

  private modelSync(): ModelProvider | null {
    return this.cachedModel?.provider ?? null;
  }

  async refreshModel(): Promise<ModelProvider | null> {
    const rec = this.connections.connected("model")[0];
    if (!rec) {
      this.cachedModel = { key: "none", provider: null };
      return null;
    }
    const provider = await providerFor(this.connections.context(rec));
    this.cachedModel = { key: rec.id, provider };
    return provider;
  }

  async model(): Promise<ModelProvider | null> {
    if (!this.cachedModel) await this.refreshModel();
    return this.cachedModel?.provider ?? null;
  }

  // ---- capability checks ----------------------------------------------------------

  featureEnabled(id: FeatureId): boolean {
    return isEnabled(this.config.get().features, id);
  }

  featureStatuses() {
    const cfg = this.config.get();
    const conns = this.connections.statuses().map((c) => ({ kind: c.kind, status: c.status, detail: c.kind === "speech" ? { stt: !!c.settings.stt && c.settings.stt !== "none", tts: !!c.settings.tts && c.settings.tts !== "none" } : {} }));
    return computeStatus(cfg.features, conns, { dataFolder: cfg.dataFolder });
  }

  jobGate(job: JobView): string | null {
    const owner = FEATURES.find((f) => f.jobKinds.includes(job.kind));
    if (owner && !this.featureEnabled(owner.id)) return `${owner.label} is turned off`;
    if (job.connectionId) {
      const rec = this.connections.record(job.connectionId);
      if (!rec || rec.status === "disconnected") return `Connection ${job.connectionId} is disconnected`;
    }
    return null;
  }

  actionAuthority(kind: string, connectionId: string | null): string | null {
    if (!this.featureEnabled("drafts")) return "Drafts and approvals is turned off";
    if (!connectionId) return "Action has no connection";
    const rec = this.connections.record(connectionId);
    if (!rec || rec.status !== "connected") return `${connectionId} is not connected`;
    if (!rec.writeActions.includes(kind)) return `Writing (${kind}) is not authorised for ${rec.label}. Authorise it in Connections.`;
    return null;
  }

  /** Apply the consequences of a feature change: triggers, subscriptions, queued work. */
  applyFeatureChange(before: Record<FeatureId, boolean>, after: Record<FeatureId, boolean>) {
    const disabled = FEATURES.filter((f) => before[f.id] && !after[f.id]);
    const cancelled: string[] = [];
    for (const f of disabled) {
      cancelled.push(...this.jobs.cancelWhere((j) => f.jobKinds.includes(j.kind), `${f.label} was turned off`));
      if (f.id === "drafts") this.actions.revokeWhere(() => true, "Drafts and approvals was turned off");
      // No hooks may keep spooling or injecting memory for a feature that is off.
      if (f.id === "sessions") for (const a of AGENT_INTEGRATIONS) if (this.connections.record(a.kind)?.status === "connected") void this.connections.disconnect(a.kind, { deleteData: false }).catch((e) => this.log.error("could not disconnect agent", { agent: a.kind, error: (e as Error).message }));
    }
    this.sessions.refreshContext();
    this.scheduler.reconcile(this.config.get());
    this.bus.emit("event", { type: "config.changed" });
    return { cancelledJobs: cancelled, disabled: disabled.map((f) => f.id), enabled: FEATURES.filter((f) => !before[f.id] && after[f.id]).map((f) => f.id) };
  }

  effectiveFeatures() {
    return effectiveFeatures(this.config.get().features);
  }

  featureLabel(id: FeatureId) {
    return featureDef(id).label;
  }

  // ---- lifecycle -----------------------------------------------------------------

  /** Open the configured data folder and make sure it is registered as the builtin vault source. */
  openDataFolder(path: string): { created: string[] } {
    const r = this.memory.open(path);
    const existing = this.connections.record("vault-data");
    const now = nowIso();
    if (!existing) {
      this.db.prepare("insert into connections (id, kind, label, status, settings, read_scopes, write_actions, created_at, updated_at, account) values ('vault-data','vault','Jarvis data folder','connected',?, '[\"deadlines\"]','[]',?,?,?)").run(JSON.stringify({ builtin: true, path }), now, now, path);
    } else {
      this.db.prepare("update connections set settings = ?, status = 'connected', account = ?, updated_at = ? where id = 'vault-data'").run(JSON.stringify({ builtin: true, path }), path, now);
    }
    this.memory.indexer.scan(this.memory.rootRef!);
    return r;
  }

  start() {
    this.conversations.recoverInterrupted();
    const cfg = this.config.get();
    if (cfg.dataFolder && existsSync(cfg.dataFolder)) {
      try {
        this.openDataFolder(cfg.dataFolder);
      } catch (e) {
        this.log.error("could not open data folder", { error: (e as Error).message });
      }
    }
    for (const rec of this.connections.records()) {
      if (rec.kind === "vault" && !rec.settings.builtin && rec.status === "connected") {
        const root = this.connections.vaultRoot(rec);
        if (root && existsSync(root.path)) this.memory.indexer.scan(root);
      }
    }
    this.scheduler.reconcile(cfg);
    this.jobs.start();
    this.scheduler.start();
    this.sessions.start();
    const housekeeping = setInterval(() => {
      const expired = this.actions.expireStale();
      const woke = wakeSnoozed(this.db);
      if (expired.length || woke) this.bus.emit("event", { type: "attention.changed" });
    }, 30_000);
    housekeeping.unref();
    void this.refreshModel();
  }

  async stop() {
    this.sessions.stop();
    this.scheduler.stop();
    await this.jobs.stop();
    this.memory.releaseLock();
    this.db.close();
  }

  connectionKinds(): ConnectionKind[] {
    return [...this.adapters.keys()];
  }
}
