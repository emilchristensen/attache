import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { nowIso } from "../core/db.ts";
import { complete } from "../models/providers.ts";
import { parseStateEntries, splitFrontmatter } from "../memory/markdown.ts";
import { sessionLogDate } from "../memory/evidence-paths.ts";
import { AgentHooks, stablePath } from "./install.ts";
import { AGENT_INTEGRATIONS, integrationFor } from "./integrations.ts";
import { agentsDir, contextFile, listSpool, removeSpool, spoolCopyPath, spoolDir, type SpoolRecord } from "./spool.ts";
import { chunkTurns, renderTurns, type ParsedSession, type Turn } from "./transcripts.ts";
import { redact } from "../core/log.ts";
import { buildSessionContext, type ContextInput } from "./context.ts";
import { projectSlug, removeContextFiles, writeContextFiles, type ProjectContext } from "./context-files.ts";
import { listedRepositories } from "../memory/repositories.ts";
import { localDate, parseSummary, sessionLogSection, summaryPrompt, summarySystemPrompt } from "./summary.ts";
import { shellPath } from "../platform/shell-command.ts";
import { replaceWith } from "../platform/replace-file.ts";

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
const MAX_UNPARSED_SAMPLES = 5;
const MAX_LOGGED_BULLETS = 12;

/**
 * Coding-agent sessions: hooks spool transcripts, this ingests them into the
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
    const integration = integrationFor(r.agent);
    const copy = spoolCopyPath(this.stateDir, r);
    if (!integration || !copy || !existsSync(copy)) {
      this.app.log.warn("agent session not saved", { agent: r.agent, sessionId: r.sessionId, event: r.event, reason: r.error ?? (integration ? "the transcript copy is missing" : "unknown agent") });
      return false;
    }
    const raw = readFileSync(copy, "utf8");
    const parsed = integration.parseTranscript(raw);
    if (!parsed.turns.length) {
      if (raw.trim()) this.keepUnparsed(r, copy);
      return false;
    }
    const existing = this.row(r.agent, r.sessionId);
    // A later copy of the same session is a superset; never replace it with an older, shorter one.
    if (existing && parsed.turns.length < existing.turns) return false;
    const cwd = parsed.cwd ?? r.cwd;
    const startedAt = parsed.startedAt ?? r.at;
    const title = parsed.title ?? firstLine(parsed.turns.find((t) => t.role === "user")?.text) ?? `${integration.label} session`;
    const relPath = existing?.rel_path ?? `evidence/sessions/transcripts/${r.agent}/${localDate(startedAt)}-${r.sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64)}.md`;
    // The cache feeds the summariser, which may be a remote model: it never holds unredacted secrets.
    this.writeCache({ ...parsed, turns: parsed.turns.map((t) => ({ ...t, text: redact(t.text) })), agent: r.agent, sessionId: r.sessionId, cwd, title, startedAt });
    this.app.memory.archiveAgentSession(relPath, { agent: r.agent, agentLabel: integration.label, sessionId: r.sessionId, title, cwd, startedAt }, parsed.turns, this.userName());
    this.app.db
      .prepare(
        `insert into agent_sessions (agent, session_id, rel_path, title, cwd, started_at, updated_at, turns) values (?,?,?,?,?,?,?,?)
         on conflict (agent, session_id) do update set title = excluded.title, cwd = excluded.cwd, updated_at = excluded.updated_at, turns = excluded.turns`,
      )
      .run(r.agent, r.sessionId, relPath, title, cwd, startedAt, nowIso(), parsed.turns.length);
    const row = this.row(r.agent, r.sessionId)!;
    if (row.turns > row.distilled_turns) this.scheduleSummary(r, integration.label, title, row.turns);
    return true;
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
  private keepUnparsed(r: SpoolRecord, copy: string) {
    const dir = join(agentsDir(this.stateDir), "unparsed");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(copy, join(dir, `${r.id}.transcript`));
    for (const old of readdirSync(dir).sort().reverse().slice(MAX_UNPARSED_SAMPLES)) rmSync(join(dir, old), { force: true });
    this.app.log.warn("agent transcript not understood; nothing was saved", { agent: r.agent, sessionId: r.sessionId, sample: join(dir, `${r.id}.transcript`) });
  }

  /** Drop summariser caches for sessions that are fully summarised and quiet for a week. */
  private pruneCaches() {
    const cutoff = new Date(Date.now() - CACHE_RETENTION_MS).toISOString();
    const done = this.app.db.prepare("select agent, session_id from agent_sessions where distilled_turns >= turns and updated_at < ?").all(cutoff) as Array<{ agent: string; session_id: string }>;
    for (const d of done) rmSync(this.cachePath(d.agent, d.session_id), { force: true });
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
    const integration = integrationFor(agent);
    const row = this.row(agent, sessionId);
    const cacheFile = this.cachePath(agent, sessionId);
    if (!integration || !row || !existsSync(cacheFile)) return { skipped: "session not found" };
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as CachedSession;
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
        const reply = await complete(model, {
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
    const section = sessionLogSection({ agentLabel: integration.label, title: row.title ?? "Session", cwd: row.cwd, at, continued: from > 0, bullets, transcriptLink: `transcripts/${row.rel_path.split("/transcripts/")[1]}` });
    const saved = await ctx.effect(`session-log:${agent}:${sessionId}:${to}`, async () => this.app.memory.appendSessionLog(date, section));
    this.app.db.prepare("update agent_sessions set distilled_turns = max(distilled_turns, ?) where agent = ? and session_id = ?").run(to, agent, sessionId);
    this.app.bus.emit("event", { type: "memory.changed", relPath: saved.relPath });
    return { relPath: saved.relPath, turns: to - from, summarised: bullets !== null, durable: bullets?.length ?? 0 };
  }

  // ---- session-start context ---------------------------------------------------

  /** Keep the context files the session-start hook prints in step with the Brain; remove them while the feature is off. */
  refreshContext() {
    if (!this.enabled()) {
      removeContextFiles(this.stateDir);
      return;
    }
    const cfg = this.app.config.get();
    const notes = this.app.memory.listDocuments({ area: "memory", root: "data", limit: 400 }).filter((d) => d.relPath !== "memory/self.md" && d.title);
    const base: ContextInput = {
      now: new Date(),
      dataFolder: cfg.dataFolder!,
      identity: cfg.identity ? { name: cfg.identity.name, ...(cfg.identity.email ? { email: cfg.identity.email } : {}) } : null,
      memory: notes.map((d) => ({ type: d.docType ?? "note", title: d.title, ...this.gist(d.relPath) })),
      recentLogs: this.recentLogs(2),
      searchCommand: this.searchCommand(),
    };
    const text = buildSessionContext(base);
    const projects = notes.filter((d) => d.docType === "project").flatMap((d) => this.projectContext(base, d));
    writeContextFiles(this.stateDir, text, projects);
    for (const a of AGENT_INTEGRATIONS) {
      if (this.app.connections.record(a.kind)?.status !== "connected") continue;
      try {
        // Agents without a session-start hook read the same context from a rule file.
        this.hooks.writeRules(a, text);
        // Keep the save and audit skills in step with this version.
        this.hooks.skills.install(a);
      } catch (e) {
        this.app.log.warn("could not update agent memory rule or skills", { agent: a.kind, error: (e as Error).message });
      }
    }
  }

  /** The current context text, for installing an agent before the first refresh. */
  contextText(): string {
    const file = contextFile(this.stateDir);
    return existsSync(file) ? readFileSync(file, "utf8") : "## Jarvis memory\n\nNothing is remembered yet.\n";
  }

  /** The context for sessions in a project's repositories; none when the project lists no repository. */
  private projectContext(base: ContextInput, { relPath, title }: { relPath: string; title: string }): ProjectContext[] {
    try {
      const state = parseStateEntries(this.app.memory.read(relPath));
      const repositories = listedRepositories(state);
      if (!repositories.length) return [];
      const project = { title, path: join(this.app.memory.dataRoot!, relPath), state: state.map(({ subject, date, value }) => ({ subject, date, value })) };
      return [{ slug: projectSlug(relPath), repositories, text: buildSessionContext({ ...base, project }) }];
    } catch (e) {
      this.app.log.warn("could not build a project's session context", { relPath, error: (e as Error).message });
      return [];
    }
  }

  /** A note's first current fact, so the index says what each note is about. */
  private gist(relPath: string): { gist?: string } {
    try {
      const first = parseStateEntries(this.app.memory.read(relPath))[0];
      return first ? { gist: first.value.replace(/\s+/g, " ").trim() } : {};
    } catch {
      return {};
    }
  }

  /** The session logs of the latest `days` days, every Machine's file for a day read as one. */
  private recentLogs(days: number): Array<{ date: string; body: string }> {
    const root = this.app.memory.dataRoot;
    const dir = root ? join(root, "evidence", "sessions") : null;
    if (!dir || !existsSync(dir)) return [];
    const byDate = new Map<string, string[]>();
    for (const f of readdirSync(dir).sort()) {
      const date = sessionLogDate(f);
      if (date) byDate.set(date, [...(byDate.get(date) ?? []), f]);
    }
    const body = (f: string) => splitFrontmatter(readFileSync(join(dir, f), "utf8")).body.replace(/^# .*\n/, "").trim();
    return [...byDate.keys()]
      .sort()
      .reverse()
      .slice(0, days)
      .map((date) => ({ date, body: byDate.get(date)!.map(body).join("\n\n") }));
  }

  /** How an agent reaches deeper recall from its shell: this service's own CLI, pinned to this state folder. */
  private searchCommand(): string {
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    const q = (s: string) => shellPath(s);
    if (!/jarvis-service\.mjs$/.test(entry)) return `jarvis search --state-dir ${q(this.stateDir)}`;
    return `${q(stablePath(process.execPath))} ${q(stablePath(entry))} search --state-dir ${q(this.stateDir)}`;
  }

}

function firstLine(text: string | undefined): string | null {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  return line ? (line.length > 80 ? `${line.slice(0, 77)}…` : line) : null;
}
