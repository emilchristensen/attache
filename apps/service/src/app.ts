import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ConnectionKind, FeatureId, HarnessUninstallResult, JobView } from "@attache/contracts";
import { openDb, type Db, nowIso } from "./core/db.ts";
import { createLogger, type Logger } from "./core/log.ts";
import { defaultLocksDir, resolvePaths, type ServicePaths } from "./core/paths.ts";
import { MachineStore } from "./core/machine.ts";
import { AutoAcceptStore } from "./agents/auto-accept.ts";
import { createSecretStore, type SecretStore } from "./platform/secret-store/index.ts";
import { currentOs } from "./platform/os.ts";
import { DesktopNotifications, notifierFor } from "./platform/notifier/index.ts";
import { ConfigStore } from "./core/config.ts";
import { retireVoice } from "./core/retire-voice.ts";
import { MemoryStore } from "./memory/store.ts";
import { FolderWatcher } from "./memory/watcher.ts";
import { MeaningSearch, type MeaningOptions } from "./meaning/service.ts";
import { configuredMeaningModel } from "./meaning/model.ts";
import { loadOnnxEmbedder } from "./meaning/onnx-embedder.ts";
import { ConnectionManager } from "./connectors/manager.ts";
import { createClaudeConnectorRunner } from "./connectors/claude/runner.ts";
import { ADAPTERS } from "./connectors/index.ts";
import { JobQueue } from "./jobs/queue.ts";
import { LATER, Scheduler } from "./jobs/scheduler.ts";
import { ActionService } from "./actions/service.ts";
import { FEATURES, SOURCE_KINDS, computeStatus, effectiveFeatures, featureDef, isEnabled } from "./capabilities/registry.ts";
import { providerFor } from "./connectors/model.ts";
import type { ModelProvider } from "./models/providers.ts";
import { registerRunners } from "./jobs/runners.ts";
import { Inbox } from "./attention/inbox.ts";
import { AgentSessions } from "./agents/sessions.ts";
import { agentAdapter } from "./connectors/agent.ts";
import { harnessAdapters, type HarnessAdapter } from "./agents/harness-adapters.ts";
import { systemClock, type Clock, type TimerHandle } from "./replication/clock.ts";
import { Replication } from "./replication/replication.ts";
import { Proposals } from "./memory/proposals.ts";
import { defaultSeams } from "./replication/seams.ts";
import type { GitHubAccess } from "./replication/github.ts";
import { connectionSecretKey } from "./connectors/manager.ts";
import { resolveEndpoint } from "./connectors/test-endpoints.ts";
import { REPLICATION_SOURCE, syncReplicationItems } from "./replication/blocked-inbox.ts";
import { brainFileReader, raiseMergeNotices, SETTLED_BY_EDIT, settledMergeNotices } from "./replication/merge-notice-inbox.ts";
import { CaptureArrivals } from "./consolidation/arrivals.ts";
import { queueCaptureConsolidation } from "./consolidation/capture.ts";
import { Reader } from "./reader/reader.ts";
import { isFullRefresh, lastSourceRefresh } from "./reader/last-refresh.ts";

export interface AppOptions {
  stateDir?: string;
  instance?: string;
  quiet?: boolean;
  schedulerTickMs?: number;
  jobConcurrency?: number;
  /** Drives Replication's timers; tests pass a clock they move by hand. */
  clock?: Clock;
  /** The meaning model and how to load it; by default the configured model on ONNX Runtime. */
  meaning?: Partial<MeaningOptions>;
  /** Lease commits per generation of the Reader lease; tests make it small to see the history stay bounded. */
  leaseGenerationCommits?: number;
}

export const VERSION = process.env.ATTACHE_VERSION ?? "0.6.0";
/** How often housekeeping runs at the latest: stale drafts expire and snoozes end within this long of their time. Approvals end on time, see `untilNextHousekeeping`. */
const HOUSEKEEPING_EVERY_MS = 30_000;

/** Everything the service owns, wired together. Clients only reach it through the HTTP API. */
export class App {
  readonly paths: ServicePaths;
  readonly instance: string;
  readonly db: Db;
  readonly log: Logger;
  readonly secrets: SecretStore;
  readonly notifications: DesktopNotifications;
  readonly config: ConfigStore;
  readonly machine: MachineStore;
  /** Which Harnesses save without asking, on this Machine. */
  readonly autoAccept: AutoAcceptStore;
  readonly memory: MemoryStore;
  readonly meaning: MeaningSearch;
  readonly connections: ConnectionManager;
  readonly jobs: JobQueue;
  readonly scheduler: Scheduler;
  readonly actions: ActionService;
  readonly sessions: AgentSessions;
  readonly clock: Clock;
  readonly replication: Replication;
  /** Which Machine runs scheduled Source refresh, briefings and Review-date inbox items. */
  readonly reader: Reader;
  /** The owner's inbox, kept in the Brain so it replicates. */
  readonly inbox: Inbox;
  /** Proposals, kept in the Brain so they replicate. */
  readonly proposals: Proposals;
  /** Meeting captures that arrive in the Brain on this Machine, each consolidated once. */
  readonly captures: CaptureArrivals;
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
  /** Re-indexes edits made to the data folder outside the service. */
  private dataWatcher: FolderWatcher | null = null;
  /** Expires stale drafts and wakes snoozed items; stopped with the app, so it never touches a closed database. */
  private housekeeping: TimerHandle | null = null;
  /** When the armed housekeeping runs (ms since the epoch). */
  private housekeepingAt = 0;

  constructor(opts: AppOptions = {}) {
    this.paths = resolvePaths(opts.stateDir);
    this.instance = opts.instance ?? process.env.ATTACHE_INSTANCE ?? "default";
    this.log = createLogger(this.paths.logDir, { quiet: opts.quiet ?? false });
    this.db = openDb(this.paths.dbFile);
    this.secrets = createSecretStore({ os: currentOs(), stateDir: this.paths.stateDir, secretsFile: this.paths.secretsFile, instance: this.instance });
    this.notifications = new DesktopNotifications({ notifier: notifierFor(currentOs(), this.instance), log: this.log });
    void retireVoice({ paths: this.paths, db: this.db, secrets: this.secrets, log: this.log }).catch((e) => this.log.error("could not remove voice leftovers", { error: (e as Error).message }));
    this.config = new ConfigStore(this.db);
    this.machine = new MachineStore(this.db);
    this.machine.get();
    this.autoAccept = new AutoAcceptStore(
      this.db,
      (kind) => this.connections.record(kind)?.status === "connected",
      () => this.harnesses(),
    );
    this.clock = opts.clock ?? systemClock;
    this.memory = new MemoryStore(this.db, null, { instance: this.instance, locksDir: defaultLocksDir(), machine: () => this.machine.get(), onWrite: (rel) => this.wrote(rel), now: () => this.clock.now() });
    this.replication = new Replication({
      db: this.db,
      log: this.log,
      clock: this.clock,
      seams: defaultSeams({ github: this.githubAccess(), clock: this.clock, install: { stateDir: this.paths.stateDir, instance: this.instance } }),
      machine: () => this.machine.get(),
      dataRoot: () => this.memory.dataRoot,
      changesAfter: (seq) => this.memory.listChanges({ after: seq, limit: 500 }),
      latestSeq: () => this.memory.listChanges({ limit: 1 })[0]?.seq ?? 0,
      onChange: () => this.replicationChanged(),
      // Loaded when needed: the backup module imports this one.
      backUpFolder: async (folder) => (await (await import("./backup.ts")).createBackup(this, { dataFolder: folder, label: "before-join" })).path,
      lastSourceRefresh: () => lastSourceRefresh(this.db),
      sourcesConnected: () => this.connections.records().some((r) => SOURCE_KINDS.includes(r.kind) && !r.settings.builtin && r.status === "connected"),
      onLeaseChange: () => this.bus.emit("event", { type: "reader.changed" }),
      ...(opts.leaseGenerationCommits ? { leaseGenerationCommits: opts.leaseGenerationCommits } : {}),
    });
    this.reader = new Reader({
      clock: this.clock,
      machine: () => this.machine.get(),
      replicated: () => this.replication.view().status !== "off",
      lease: () => this.replication.readerLease(),
      machineName: (id) => this.replication.recordedName(id),
      lastRefreshAt: () => lastSourceRefresh(this.db),
    });
    this.inbox = new Inbox({
      db: this.db,
      log: this.log,
      ctx: { now: () => this.clock.now().toISOString(), machine: () => this.machine.get() },
      dataRoot: () => this.memory.dataRoot,
      onWrite: () => this.replication.noteWrite(),
      onChange: () => this.bus.emit("event", { type: "attention.changed" }),
      // This Machine's own Replication status stays here; the notices of merges replicate like any item.
      localSources: [REPLICATION_SOURCE],
    });
    this.proposals = new Proposals({ db: this.db, memory: this.memory, log: this.log, clock: this.clock, machine: () => this.machine.get(), onWrite: () => this.replication.noteWrite() });
    this.captures = new CaptureArrivals({ db: this.db, log: this.log, clock: this.clock, dataRoot: () => this.memory.dataRoot, arrived: (rel) => queueCaptureConsolidation(this, rel) });
    // First, so a capture another Machine sent is recorded as theirs before anything looks for new captures.
    this.replication.onPulled((paths) => this.captures.pulled(paths));
    this.replication.onPulled((paths) => this.reindexPulled(paths));
    this.replication.onPulled((paths) => this.inbox.pulled(paths));
    // The Reader's briefing arrives as a deliverable; Dashboards show the newest one (`latestBriefing`).
    this.replication.onPulled((paths) => {
      if (paths.some((p) => p.startsWith("deliverables/briefings/"))) this.bus.emit("event", { type: "briefing.created" });
    });
    this.replication.onMergeNotice((notices) => {
      if (raiseMergeNotices(this.inbox, notices, this.clock.now()).length) this.bus.emit("event", { type: "attention.changed" });
    });
    this.bus.setMaxListeners(500);
    this.meaning = new MeaningSearch(
      { db: this.db, modelsDir: this.paths.modelsDir, log: this.log, emit: () => this.bus.emit("event", { type: "meaning.changed" }) },
      { model: opts.meaning?.model ?? configuredMeaningModel(), loadEmbedder: opts.meaning?.loadEmbedder ?? loadOnnxEmbedder },
    );
    this.memory.indexer.onChange(() => this.meaning.indexChanged());
    // Whatever changed a note (a save, an editor, another Machine), a merge item it settled resolves.
    this.memory.indexer.onChange(() => this.settleMergeNotices());
    this.sessions = new AgentSessions(this);
    // Agent connections install hooks for this instance's state folder, so they are built per App.
    this.adapters = new Map([...ADAPTERS, ...harnessAdapters(this.sessions.hooks, () => this.sessions.contextText()).map((h) => [h.kind as ConnectionKind, agentAdapter(h)] as const)]);
    this.connections = new ConnectionManager({
      db: this.db,
      secrets: this.secrets,
      log: this.log,
      memory: this.memory,
      inbox: this.inbox,
      adapters: this.adapters,
      claude: createClaudeConnectorRunner(this.log),
      selfEmail: () => this.config.get().identity?.email ?? null,
      isReader: () => this.reader.isReader(),
      now: () => this.clock.now(),
    });
    this.jobs = new JobQueue(this.db, this.log, { concurrency: opts.jobConcurrency ?? 2 });
    this.scheduler = new Scheduler(this.db, this.log, { tickMs: opts.schedulerTickMs ?? 15_000 });
    this.actions = new ActionService(this.db, () => this.clock.now());
    this.wire();
    registerRunners(this);
  }

  private wire() {
    this.jobs.events.on("event", (ev) => {
      this.bus.emit("event", { type: "job.event", event: ev });
      if (ev.type === "succeeded") this.jobSucceeded(ev.jobId);
    });
    this.connections.onChange = (id) => {
      this.cachedModel = null;
      this.bus.emit("event", { type: "connections.changed", id });
    };
    this.connections.onDisconnect = (id, kind) => {
      const harness = this.adapters.get(kind)?.harness;
      let removed: HarnessUninstallResult | undefined;
      if (harness) {
        // Connecting the Harness again starts with auto-accept on, as a new Harness does (ADR 0004).
        this.autoAccept.forget(kind);
        removed = harness.uninstall();
        if (removed.failures.length) this.log.error("could not remove every Attache entry from a Harness", { agent: kind, failures: removed.failures });
      }
      const cancelledJobs = this.jobs.cancelWhere((j) => j.connectionId === id || (kind === "model" && (j.kind === "research" || j.kind === "draft")), `Connection ${id} was disconnected`);
      const revokedActions = this.actions.revokeWhere((a) => a.connectionId === id, "connection disconnected");
      return { cancelledJobs, revokedActions, ...(removed ? { harness: removed } : {}) };
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
      if (row.jobKind === "source-refresh" || row.jobKind === "briefing") {
        // Only the Reader reads on a schedule. A Reader whose lease lapsed while asleep or offline waits for its renewal, then catches up.
        const role = this.reader.role();
        if (role === "lapsed") return LATER;
        if (role === "other") return null;
      }
      if (row.jobKind === "source-refresh") return this.jobs.create({ kind: "source-refresh", title: `Refresh sources (${reason === "catch_up" ? "catch-up" : "scheduled"})`, input: { all: true, reason }, capability: "attention", idempotencyKey: `sched:${row.id}:${Math.floor(Date.now() / 60_000)}` }).job.id;
      if (row.jobKind === "briefing") return this.jobs.create({ kind: "briefing", title: `Daily briefing${reason === "catch_up" ? " (catch-up)" : ""}`, input: { kind: "daily", reason }, capability: "attention", idempotencyKey: `sched:${row.id}:${new Date().toISOString().slice(0, 10)}` }).job.id;
      return null;
    };
    this.scheduler.onResume = (gapMs) => {
      this.replication.wake();
      this.bus.emit("event", { type: "service.resumed", gapMs });
    };
  }

  // ---- model ---------------------------------------------------------------

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
    const conns = this.connections.records();
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
      if (f.id === "sessions") {
        // Every Harness whose memory or session capture needs the feature, whatever it uses (hooks, a plugin or an extension).
        const lifecycle = this.harnesses().filter((h) => h.capabilities.memory !== "none" || h.capabilities.capture !== "none");
        for (const h of lifecycle) {
          const connection = this.connections.record(h.kind);
          if (!connection || connection.status === "disconnected") continue;
          void this.connections.disconnect(h.kind as ConnectionKind, { deleteData: false }).catch((e) => this.log.error("could not disconnect agent", { agent: h.kind, error: (e as Error).message }));
        }
      }
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

  /** Attache wrote a file in the data folder: Replication commits it, and a meeting capture is consolidated. */
  private wrote(rel: string) {
    this.replication.noteWrite();
    this.captures.written(rel);
  }

  /**
   * Open the configured data folder and make sure it is registered as the builtin vault source.
   * `adopt` is for a folder the owner just chose or joined: the meeting captures already in it are not consolidated.
   */
  openDataFolder(path: string, opts: { adopt?: boolean } = {}): { created: string[] } {
    const r = this.memory.open(path);
    const existing = this.connections.record("vault-data");
    const now = nowIso();
    if (!existing) {
      this.db.prepare("insert into connections (id, kind, label, status, settings, read_scopes, write_actions, created_at, updated_at, account) values ('vault-data','vault','Attache data folder','connected',?, '[\"deadlines\"]','[]',?,?,?)").run(JSON.stringify({ builtin: true, path }), now, now, path);
    } else {
      this.db.prepare("update connections set settings = ?, status = 'connected', account = ?, updated_at = ? where id = 'vault-data'").run(JSON.stringify({ builtin: true, path }), path, now);
    }
    const root = this.memory.rootRef!;
    this.memory.indexer.scan(root);
    this.inbox.reconcile();
    this.proposals.open();
    this.captures.opened({ adopt: opts.adopt ?? false });
    this.dataWatcher?.stop();
    this.dataWatcher = new FolderWatcher(this.memory.indexer, root, this.log, {
      onChange: () => {
        this.captures.check();
        this.replication.noteOutsideEdit();
        this.bus.emit("event", { type: "memory.changed" });
      },
    });
    this.dataWatcher.start();
    return r;
  }

  /** Make `path` this Machine's data folder: open it, index it and remember it. */
  useDataFolder(path: string): { created: string[] } {
    const r = this.openDataFolder(path, { adopt: true });
    this.config.patch({ dataFolder: path });
    this.bus.emit("event", { type: "config.changed" });
    return r;
  }

  /** What Replication borrows from the GitHub connection: its API address and, from the secret store, its token. */
  private githubAccess(): GitHubAccess {
    const record = () => this.connections.records().find((r) => r.kind === "github" && r.status !== "disconnected" && r.status !== "not_configured") ?? null;
    return {
      connection: () => {
        const r = record();
        if (!r) return null;
        const configured = typeof r.settings.apiBaseUrl === "string" && r.settings.apiBaseUrl ? r.settings.apiBaseUrl : "https://api.github.com";
        return { id: r.id, apiBase: resolveEndpoint(configured) };
      },
      token: (id) => this.secrets.get(connectionSecretKey(id, "token")),
    };
  }

  /** Replication's status may have changed: tell the Dashboard, and keep its inbox item in step. */
  private replicationChanged() {
    if (syncReplicationItems(this.db, this.replication.view(), this.clock.now().toISOString())) this.bus.emit("event", { type: "attention.changed" });
    this.bus.emit("event", { type: "replication.changed" });
    // Switching Replication on or off changes who the Reader is.
    this.bus.emit("event", { type: "reader.changed" });
  }

  /** A Source refresh of every source finished: Dashboards show when, and the Reader lease carries it to the other Machines. */
  private jobSucceeded(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || !isFullRefresh(job)) return;
    this.replication.noteSourceRefresh();
    this.bus.emit("event", { type: "reader.changed" });
  }

  /** Resolve the merge items whose note the owner has settled. */
  private settleMergeNotices() {
    const root = this.memory.dataRoot;
    if (!root) return;
    try {
      if (this.inbox.resolve(settledMergeNotices(this.db, SETTLED_BY_EDIT, brainFileReader(root))).length) this.bus.emit("event", { type: "attention.changed" });
    } catch (e) {
      this.log.error("could not check the notes merges kept in two versions", { error: (e as Error).message });
    }
  }

  /** Re-index the files another Machine changed, as soon as git wrote them. */
  private reindexPulled(paths: readonly string[]) {
    const root = this.memory.rootRef;
    if (!root) return;
    let changed = false;
    let scan = false;
    for (const rel of paths) {
      try {
        const r = this.memory.indexer.syncPath(root, rel);
        if (r === "rescan") scan = true;
        if (r === "changed") changed = true;
      } catch (e) {
        this.log.warn("could not index a file another Machine changed", { path: rel, error: (e as Error).message });
        scan = true;
      }
    }
    if (scan) {
      const r = this.memory.indexer.scan(root);
      if (r.indexed || r.removed) changed = true;
    }
    if (this.proposals.reload(paths)) changed = true;
    if (changed) this.bus.emit("event", { type: "memory.changed" });
  }

  start() {
    void this.connections.migrateLegacyTransports().catch((e) => this.log.error("connection migration failed", { error: (e as Error).message }));
    this.inbox.load();
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
    this.meaning.start();
    this.scheduler.reconcile(cfg);
    void this.notifications.start();
    this.jobs.start();
    this.scheduler.start();
    this.sessions.start();
    this.replication.start();
    this.scheduleHousekeeping();
    this.bus.on("event", this.onAttentionChanged);
    void this.refreshModel();
  }

  async stop() {
    this.bus.off("event", this.onAttentionChanged);
    if (this.housekeeping) this.clock.clearTimeout(this.housekeeping);
    this.housekeeping = null;
    this.dataWatcher?.stop();
    await this.replication.stop();
    this.sessions.stop();
    this.scheduler.stop();
    await this.jobs.stop();
    await this.meaning.stop();
    this.memory.releaseLock();
    this.db.close();
  }

  /**
   * Settle drafts and approvals whose time has passed, and tell clients which ones changed.
   * Housekeeping runs it, and so does every route that reads or approves drafts, so no answer shows an approval past its end.
   */
  settleActions(): void {
    const { expired, approvalsEnded } = this.actions.expireStale();
    for (const id of [...expired, ...approvalsEnded]) this.bus.emit("event", { type: "actions.changed", id });
    if (expired.length) this.bus.emit("event", { type: "attention.changed" });
  }

  /** Run housekeeping on the service's clock: settle drafts and approvals, wake snoozed items and resolve meeting prep whose meeting ended. */
  private scheduleHousekeeping(): void {
    if (this.housekeeping) this.clock.clearTimeout(this.housekeeping);
    const wait = this.untilNextHousekeeping();
    this.housekeepingAt = this.clock.now().getTime() + wait;
    this.housekeeping = this.clock.setTimeout(() => {
      try {
        this.settleActions();
        this.inbox.wake();
      } finally {
        this.scheduleHousekeeping();
      }
    }, wait);
  }

  /** A refresh or another Machine's record can bring a meeting that ends before the armed run: run housekeeping at that end instead. */
  private readonly onAttentionChanged = (ev: { type: string }) => {
    if (ev.type === "attention.changed" && this.housekeeping && this.clock.now().getTime() + this.untilNextHousekeeping() < this.housekeepingAt) this.scheduleHousekeeping();
  };

  /**
   * Half a minute, or less when an approval or a meeting ends sooner: an approval goes back to needing
   * approval, and a meeting's prep item leaves the Inbox, at the moment it ends.
   */
  private untilNextHousekeeping(): number {
    const now = this.clock.now().getTime();
    const ends = [this.actions.nextApprovalEnd(), this.inbox.nextMeetingEnd()].filter((d): d is Date => d !== null).map((d) => Math.max(0, d.getTime() - now));
    return Math.min(HOUSEKEEPING_EVERY_MS, ...ends);
  }

  connectionKinds(): ConnectionKind[] {
    return [...this.adapters.keys()];
  }

  /** Every Harness Attache can connect, through its adapter (ADR 0006). */
  harnesses(): HarnessAdapter[] {
    return [...this.adapters.values()].flatMap((a) => (a.harness ? [a.harness] : []));
  }
}
