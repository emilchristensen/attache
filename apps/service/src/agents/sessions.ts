import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { nowIso } from "../core/db.ts";
import { complete } from "../models/providers.ts";
import { AgentHooks, agentHome, stablePath } from "./install.ts";
import { AGENT_INTEGRATIONS, type AgentIntegration } from "./integrations.ts";
import { PARTIAL_SOURCE_KINDS, sessionSourceFor } from "./session-sources.ts";
import { removeLegacySkills } from "./legacy-skills.ts";
import { agentsDir, contextFile, listSpool, removeSpool, spoolCopyPath, spoolDir, type SpoolRecord } from "./spool.ts";
import { chunkTurns, renderTurns, type ParsedSession, type Turn } from "./transcripts.ts";
import { redact } from "../core/log.ts";
import { brainContexts, type ContextBase } from "./context-sources.ts";
import { removeContextFiles, writeContextFiles } from "./context-files.ts";
import { repositoryKey } from "../memory/repositories.ts";
import { gitRemoteUrls } from "./git-remotes.ts";
import { localDate, parseSummary, sessionLogSection, summaryPrompt, summarySystemPrompt } from "./summary.ts";
import { currentOs } from "../platform/os.ts";
import { searchCommand, type SearchCommand } from "./search-command.ts";
import { replaceWith } from "../platform/replace-file.ts";
import { queueConsolidation } from "../consolidation/consolidate.ts";

interface SessionRow {
  agent: string;
  session_id: string;
  rel_path: string;
  title: string | null;
  cwd: string | null;
  started_at: string | null;
  turns: number;
  distilled_turns: number;
}

interface CachedSession extends ParsedSession {
  agent: string;
  sessionId: string;
}

const MAX_SUMMARY_INPUT_CHARS = 100_000;
const SCAN_EVERY_MS = 60_000;
/** Agents that only report finished turns are summarised once the conversation has been quiet this long. */
const TURN_END_QUIET_MS = 15 * 60_000;
const CACHE_RETENTION_MS = 7 * 86_400_000;
/** A plugin's session can go on (Pi and OpenCode resume it) and its next snapshot joins the cached turns, so its cache stays longer. */
const PARTIAL_CACHE_RETENTION_MS = 30 * 86_400_000;
const MAX_UNPARSED_SAMPLES = 5;
const MAX_LOGGED_BULLETS = 12;

/**
 * Harness sessions: hooks spool transcripts, this ingests them into the
 * data folder (a redacted transcript plus a dated session-log entry) and keeps
 * the session-start context current.
 */
export class AgentSessions {
  readonly hooks: AgentHooks;
  private readonly app: App;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private onBus: ((ev: { type?: string }) => void) | null = null;
  private stopped = false;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(app: App) {
    this.app = app;
    this.hooks = new AgentHooks(app.paths.stateDir, app.paths.backupsDir);
  }

  private get stateDir() {
    return this.app.paths.stateDir;
  }

  enabled(): boolean {
    return this.app.featureEnabled("sessions") && !!this.app.memory.dataRoot;
  }

  start() {
    mkdirSync(spoolDir(this.stateDir), { recursive: true, mode: 0o700 });
    this.upgradeHarnesses();
    const kick = () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.tick(), 300);
      this.debounce.unref();
    };
    try {
      this.watcher = watch(spoolDir(this.stateDir), kick);
      this.watcher.on("error", (e) => this.app.log.warn("agent spool watcher stopped", { error: e.message }));
    } catch (e) {
      this.app.log.warn("agent spool watcher unavailable; scanning on a timer", { error: (e as Error).message });
    }
    this.timer = setInterval(() => this.tick(), SCAN_EVERY_MS);
    this.timer.unref();
    this.onBus = (ev: { type?: string }) => {
      if (ev.type === "memory.changed" || ev.type === "config.changed") kick();
    };
    this.app.bus.on("event", this.onBus);
    this.tick();
  }

  stop() {
    this.stopped = true;
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.onBus) this.app.bus.off("event", this.onBus);
  }

  tick() {
    if (this.stopped) return;
    try {
      this.ingest();
      this.refreshContext();
      this.pruneCaches();
    } catch (e) {
      this.app.log.error("agent session ingest failed", { error: (e as Error).message });
    }
  }

  // ---- ingest ----------------------------------------------------------------

  /** Archive every spooled transcript and queue its summary. Records stay spooled while the feature is off. */
  ingest(): { ingested: number } {
    if (!this.enabled()) return { ingested: 0 };
    let ingested = 0;
    for (const r of listSpool(this.stateDir)) {
      try {
        if (this.ingestOne(r)) ingested++;
        removeSpool(this.stateDir, r);
      } catch (e) {
        // Keep the record so the next scan retries; the data folder may be briefly unavailable.
        this.app.log.error("could not ingest agent session", { agent: r.agent, sessionId: r.sessionId, error: (e as Error).message });
      }
    }
    if (ingested) this.app.bus.emit("event", { type: "sessions.changed" });
    return { ingested };
  }

  private ingestOne(r: SpoolRecord): boolean {
    const source = sessionSourceFor(r.agent);
    const copy = spoolCopyPath(this.stateDir, r);
    if (!source || !copy || !existsSync(copy)) {
      const detail = { agent: r.agent, sessionId: r.sessionId, event: r.event, reason: r.error ?? (source ? "the transcript copy is missing" : "unknown agent") };
      if (source && this.hadNoConversation(r)) this.app.log.debug("agent session had no conversation; nothing to save", detail);
      else this.app.log.warn("agent session not saved", detail);
      return false;
    }
    const raw = readFileSync(copy, "utf8");
    const parsed = source.parse(raw);
    if (!parsed.turns.length) {
      if (parsed.problem) this.reportUnreadable(r, copy, source.label, parsed.problem);
      // A plugin's snapshot of a session with nothing said yet, or of a subagent's side-chain, is no failure; nor is a strict parser's empty session.
      else if (raw.trim() && !source.partial && !source.strict) this.keepUnparsed(r, copy);
      return false;
    }
    const existing = this.row(r.agent, r.sessionId);
    // A plugin's snapshot may hold only part of the session: it joins the turns saved before, while their copy is kept.
    const saved = source.partial && existing ? this.readCache(r.agent, r.sessionId) : null;
    const joins = source.partial && !(existing && !saved);
    // A later copy of the same session is a superset; never replace it with an older, shorter one.
    if (!joins && existing && parsed.turns.length < existing.turns) return false;
    const turns = joins ? joinTurns(saved?.turns ?? [], parsed.turns) : parsed.turns;
    const cwd = parsed.cwd ?? r.cwd;
    const startedAt = (source.partial ? turns.find((t) => t.at)?.at : parsed.startedAt) ?? parsed.startedAt ?? r.at;
    const title = parsed.title ?? firstLine(turns.find((t) => t.role === "user")?.text) ?? `${source.label} session`;
    const relPath = existing?.rel_path ?? `evidence/sessions/transcripts/${r.agent}/${localDate(startedAt)}-${r.sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}.md`;
    // The cache feeds the summariser, which may be a remote model: it never holds unredacted secrets.
    this.writeCache({ ...parsed, turns: turns.map((t) => ({ ...t, text: redact(t.text) })), agent: r.agent, sessionId: r.sessionId, cwd, title, startedAt });
    this.app.memory.archiveAgentSession(relPath, { agent: r.agent, agentLabel: source.label, sessionId: r.sessionId, title, cwd, startedAt }, turns, this.userName());
    this.app.db
      .prepare(
        `insert into agent_sessions (agent, session_id, rel_path, title, cwd, started_at, updated_at, turns) values (?,?,?,?,?,?,?,?)
         on conflict (agent, session_id) do update set title = excluded.title, cwd = excluded.cwd, updated_at = excluded.updated_at, turns = excluded.turns`,
      )
      .run(r.agent, r.sessionId, relPath, title, cwd, startedAt, nowIso(), turns.length);
    const row = this.row(r.agent, r.sessionId)!;
    if (row.turns > row.distilled_turns) this.scheduleSummary(r, source.label, title, row.turns);
    return true;
  }

  /**
   * The summariser's copy of a session's saved turns; null when there is none.
   * A copy that no longer parses (a disk or crash fault) is removed and logged,
   * once, so the session's next snapshot is saved instead of failing forever.
   */
  private readCache(agent: string, sessionId: string): CachedSession | null {
    const file = this.cachePath(agent, sessionId);
    if (!existsSync(file)) return null;
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as CachedSession;
      if (!Array.isArray(cached?.turns)) throw new Error("it holds no turns");
      return cached;
    } catch (e) {
      rmSync(file, { force: true });
      this.app.log.warn("the summariser's copy of an agent session was unreadable and was removed; the next copy of the session replaces it", { agent, sessionId, error: (e as Error).message });
      return null;
    }
  }

  /**
   * A transcript in a format Attache could not read: nothing of it is saved,
   * a sample is kept for diagnosis, and the Connection names the format, so
   * the owner sees that an upstream change stopped their sessions being saved.
   */
  private reportUnreadable(r: SpoolRecord, copy: string, label: string, problem: string) {
    this.keepUnparsed(r, copy, problem);
    const message = `Attache could not read a ${label} session (${problem}), so it saved nothing of it. Updating Attache may fix this; until then, use the wrap-up prompt to keep what a conversation decided.`;
    this.app.db.prepare("update connections set last_error = ?, last_error_at = ? where kind = ? and status = 'connected'").run(message, nowIso(), r.agent);
  }

  /**
   * Commands that never start a conversation (`claude mcp list`) still end a
   * session, with a transcript that was never written. A finished turn, or a
   * part of the session Attache already saved, shows there was a conversation,
   * so its missing transcript is a failure.
   */
  private hadNoConversation(r: SpoolRecord): boolean {
    return !!r.absent && r.event !== "turn-end" && !this.row(r.agent, r.sessionId);
  }

  /**
   * One queued summary per session: it reads the latest transcript when it
   * runs, so later turns join it. Turn-by-turn agents wait until the
   * conversation has been quiet for a while, restarting the wait on every
   * turn; a session end or compaction runs it straight away. A summary that is
   * already running is followed by a new one (see `distill` for ordering).
   */
  private scheduleSummary(r: SpoolRecord, label: string, title: string, turns: number) {
    const pending = this.app.db
      .prepare("select id from jobs where kind = 'session-distill' and status = 'queued' and json_extract(input, '$.agent') = ? and json_extract(input, '$.sessionId') = ?")
      .get(r.agent, r.sessionId) as { id: string } | undefined;
    const now = r.event !== "turn-end";
    const quietUntil = new Date(Date.now() + TURN_END_QUIET_MS).toISOString();
    if (pending) {
      this.app.jobs.reschedule(pending.id, now ? null : quietUntil);
      return;
    }
    this.app.jobs.create({
      kind: "session-distill",
      title: `Summarise ${label} session: ${title.slice(0, 60)}`,
      input: { agent: r.agent, sessionId: r.sessionId },
      capability: "sessions",
      idempotencyKey: `session-distill:${r.agent}:${r.sessionId}:${turns}`,
      ...(now ? {} : { runAfter: quietUntil }),
    });
  }

  /** Keep a few transcripts no parser understood, so a changed agent format can be diagnosed. */
  private keepUnparsed(r: SpoolRecord, copy: string, problem?: string) {
    const dir = join(agentsDir(this.stateDir), "unparsed");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(copy, join(dir, `${r.id}.transcript`));
    for (const old of readdirSync(dir).sort().reverse().slice(MAX_UNPARSED_SAMPLES)) rmSync(join(dir, old), { force: true });
    this.app.log.warn("agent transcript not understood; nothing was saved", { agent: r.agent, sessionId: r.sessionId, sample: join(dir, `${r.id}.transcript`), ...(problem ? { problem } : {}) });
  }

  /**
   * Drop summariser caches for sessions that are fully summarised and quiet:
   * a week since the last copy, or, for a plugin's sessions, whose later
   * snapshots join the saved turns, a month since the last snapshot. After
   * that a snapshot of such a session is taken whole, like a transcript: it
   * replaces the saved conversation only when it is no shorter.
   */
  private pruneCaches() {
    const cutoff = (ms: number) => new Date(Date.now() - ms).toISOString();
    const done = this.app.db.prepare("select agent, session_id, updated_at from agent_sessions where distilled_turns >= turns and updated_at < ?").all(cutoff(CACHE_RETENTION_MS)) as Array<{ agent: string; session_id: string; updated_at: string }>;
    const partialCutoff = cutoff(PARTIAL_CACHE_RETENTION_MS);
    for (const d of done.filter((x) => !PARTIAL_SOURCE_KINDS.includes(x.agent) || x.updated_at < partialCutoff)) rmSync(this.cachePath(d.agent, d.session_id), { force: true });
  }

  private row(agent: string, sessionId: string): SessionRow | undefined {
    return this.app.db.prepare("select * from agent_sessions where agent = ? and session_id = ?").get(agent, sessionId) as SessionRow | undefined;
  }

  private cachePath(agent: string, sessionId: string) {
    return join(agentsDir(this.stateDir), "sessions", agent, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}.json`);
  }

  private writeCache(s: CachedSession) {
    const file = this.cachePath(s.agent, s.sessionId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    replaceWith(tmp, file);
  }

  private userName(): string {
    return this.app.config.get().identity?.name?.trim() || "User";
  }

  // ---- summary job -----------------------------------------------------------

  /**
   * Summaries of one session run one after another, so two jobs can never
   * read the same watermark and log the same turns twice.
   */
  distill(ctx: JobContext): Promise<unknown> {
    const key = `${String(ctx.input.agent)}:${String(ctx.input.sessionId)}`;
    const run = (this.chains.get(key) ?? Promise.resolve()).then(() => this.distillNow(ctx));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return run;
  }

  /** Summarise the turns not yet in the session log and append them as one entry. */
  private async distillNow(ctx: JobContext) {
    const agent = String(ctx.input.agent ?? "");
    const sessionId = String(ctx.input.sessionId ?? "");
    const integration = sessionSourceFor(agent);
    const row = this.row(agent, sessionId);
    const cached = integration && row ? this.readCache(agent, sessionId) : null;
    if (!integration || !row || !cached) return { skipped: "session not found" };
    const from = row.distilled_turns;
    const to = cached.turns.length;
    if (to <= from) return { skipped: "already summarised" };
    const turns: Turn[] = cached.turns.slice(from, to);
    ctx.progress(0.2, "Summarising");
    let bullets: string[] | null = null;
    const model = await this.app.model();
    if (model) {
      // Long sessions are summarised in parts, so early decisions are never skipped.
      const parts = chunkTurns(turns, MAX_SUMMARY_INPUT_CHARS);
      const found: string[] = [];
      for (const [i, part] of parts.entries()) {
        ctx.progress(0.2 + (0.7 * i) / parts.length, parts.length > 1 ? `Summarising part ${i + 1} of ${parts.length}` : "Summarising");
        const { text: reply } = await complete(model, {
          system: summarySystemPrompt(this.userName()),
          messages: [{ role: "user", content: summaryPrompt(renderTurns(part, { user: this.userName(), assistant: integration.label }, MAX_SUMMARY_INPUT_CHARS)) }],
          maxTokens: 700,
          signal: ctx.signal,
        });
        found.push(...parseSummary(reply));
      }
      bullets = found.slice(0, MAX_LOGGED_BULLETS);
    }
    const at = turns.at(-1)?.at ?? nowIso();
    const date = localDate(at);
    const section = sessionLogSection({ agentLabel: integration.label, title: row.title ?? "Session", cwd: row.cwd, repositories: repositoriesOf(row.cwd), at, continued: from > 0, bullets, transcriptLink: `transcripts/${row.rel_path.split("/transcripts/")[1]}` });
    const saved = await ctx.effect(`session-log:${agent}:${sessionId}:${to}`, async () => this.app.memory.appendSessionLog(date, section));
    this.app.db.prepare("update agent_sessions set distilled_turns = max(distilled_turns, ?) where agent = ? and session_id = ?").run(to, agent, sessionId);
    this.app.bus.emit("event", { type: "memory.changed", relPath: saved.relPath });
    // Consolidation reads what the summary found durable; without a model there is no summary, and the log says so.
    const consolidation = bullets === null ? "no model" : bullets.length ? "queued" : "nothing durable";
    if (consolidation === "queued") queueConsolidation(this.app, { agent, sessionId, from, to, topics: bullets! }, { label: integration.label, title: row.title ?? "Session" });
    return { relPath: saved.relPath, turns: to - from, summarised: bullets !== null, durable: bullets?.length ?? 0, consolidation };
  }

  /** Turns `from` up to `to` of a session as the summariser read them (redacted), for Consolidation; null when the session is gone. */
  sessionPart(agent: string, sessionId: string, from: number, to: number): { turns: Turn[]; title: string; cwd: string | null; agentLabel: string; userName: string } | null {
    const integration = sessionSourceFor(agent);
    const row = this.row(agent, sessionId);
    const cached = integration && row ? this.readCache(agent, sessionId) : null;
    if (!integration || !row || !cached) return null;
    const turns = cached.turns.slice(from, to);
    return turns.length ? { turns, title: row.title ?? "Session", cwd: row.cwd, agentLabel: integration.label, userName: this.userName() } : null;
  }

  // ---- session-start context ---------------------------------------------------

  /** Keep the context files the session-start hook prints in step with the Brain; remove them while the feature is off. */
  refreshContext() {
    if (!this.enabled()) {
      removeContextFiles(this.stateDir);
      return;
    }
    const cfg = this.app.config.get();
    const base: ContextBase = {
      now: new Date(),
      dataFolder: cfg.dataFolder!,
      identity: cfg.identity ? { name: cfg.identity.name, ...(cfg.identity.email ? { email: cfg.identity.email } : {}) } : null,
      searchCommand: this.searchCommand(),
    };
    const { global, projects } = brainContexts(this.app.memory, base, (relPath, error) => this.app.log.warn("could not read a note for the session context", { relPath, error: error.message }));
    writeContextFiles(this.stateDir, global, projects);
    for (const a of this.connectedHarnesses()) {
      try {
        // Harnesses without a session-start hook read the global context from a rule file.
        this.hooks.writeRules(a, global);
      } catch (e) {
        this.app.log.warn("could not update a Harness's memory rule", { agent: a.kind, error: (e as Error).message });
      }
    }
  }

  private connectedHarnesses(): AgentIntegration[] {
    return AGENT_INTEGRATIONS.filter((a) => this.app.connections.record(a.kind)?.status === "connected");
  }

  /**
   * Bring connected Harnesses up to this version once per start: an upgrade
   * may move the install's paths, so the MCP server entry is rewritten when it
   * no longer matches, the files of adapter-driven Harnesses (Pi, OpenCode,
   * Copilot CLI) are refreshed, and the save and audit skills earlier
   * versions installed are removed, since the MCP prompts replace them.
   */
  private upgradeHarnesses() {
    const skills = removeLegacySkills(agentHome(), this.stateDir);
    if (skills.removed.length) this.app.log.info("removed the save and audit skills the MCP prompts replace", { folders: skills.removed });
    for (const e of skills.errors) this.app.log.warn("could not remove an earlier version's skill folder", e);
    for (const a of this.connectedHarnesses()) {
      try {
        const r = this.hooks.refreshMcp(a);
        if (r.changed) this.app.log.info("registered Attache's MCP server", { agent: a.kind, path: r.path });
      } catch (e) {
        this.app.log.warn("could not register Attache's MCP server", { agent: a.kind, error: (e as Error).message });
      }
    }
    // Harnesses whose files carry this install's paths (a plugin, an extension, a hooks file) are refreshed through their adapter.
    const legacy = new Set<string>(AGENT_INTEGRATIONS.map((a) => a.kind));
    for (const h of this.app.harnesses().filter((x) => !legacy.has(x.kind) && this.app.connections.record(x.kind)?.status === "connected")) {
      try {
        const r = h.refresh();
        if (r.changes.length) this.app.log.info("brought Attache's files in a Harness up to date", { agent: h.kind, files: r.changes.map((c) => c.path), backups: r.backups });
      } catch (e) {
        this.app.log.warn("could not bring Attache's files in a Harness up to date", { agent: h.kind, error: (e as Error).message });
      }
    }
  }

  /** The current context text, for installing an agent before the first refresh. */
  contextText(): string {
    const file = contextFile(this.stateDir);
    return existsSync(file) ? readFileSync(file, "utf8") : "## Attache memory\n\nNothing is remembered yet.\n";
  }

  /** How a Harness reaches deeper recall from its shell: this service's own CLI, pinned to this state folder. */
  private searchCommand(): SearchCommand {
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    return searchCommand({ os: currentOs(), execPath: stablePath(process.execPath), entry: entry && stablePath(entry), stateDir: this.stateDir });
  }

}

/**
 * Turns saved before joined with a newer snapshot's, by message id: a turn
 * already saved keeps its place and takes the newer text, a new one follows,
 * so the session stays in order and only grows.
 */
export function joinTurns(saved: Turn[], next: Turn[]): Turn[] {
  const out = [...saved];
  const at = new Map(out.flatMap((t, i) => (t.id ? [[t.id, i] as const] : [])));
  for (const t of next) {
    const i = t.id === undefined ? undefined : at.get(t.id);
    if (i === undefined) {
      if (t.id) at.set(t.id, out.length);
      out.push(t);
    } else out[i] = { ...t, at: t.at ?? out[i]!.at };
  }
  return out;
}

function firstLine(text: string | undefined): string | null {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  return line ? (line.length > 80 ? `${line.slice(0, 77)}…` : line) : null;
}

/** The repository keys of the folder a session ran in, read from its git config; none when it is gone or outside a repository. */
function repositoriesOf(cwd: string | null): string[] {
  const keys = cwd ? gitRemoteUrls(cwd).map(repositoryKey) : [];
  return [...new Set(keys.filter((k): k is string => k !== null))];
}
