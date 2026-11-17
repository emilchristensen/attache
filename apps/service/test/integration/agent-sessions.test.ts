import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { antigravityTranscript, claudeTranscript, codexRollout } from "../fixtures/agents/transcripts.ts";
import { spoolDir } from "../../src/agents/spool.ts";
import { homeEnv, hookShell, runInShell } from "../fixtures/harness-shell.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

const HOME = process.env.ATTACHE_AGENT_HOME!;
const FOREIGN_CLAUDE = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }], SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash snapshot.sh", timeout: 5 }] }] } };

let svc: TestService;
let fx: FixtureServer;
const mcp = mcpClients();
/** The name Attache registers its MCP server under for this install. */
const registeredName = () => svc.app.sessions.hooks.ownerKey();
const work = mkdtempSync(join(tmpdir(), "attache-it-agentwork-"));

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Find the command Attache registered for `event` and run it the way the agent does: through a shell, JSON on stdin. */
function runHook(settingsPath: string, event: string, input: Record<string, unknown>, opts: { named?: boolean; env?: Record<string, string> } = {}): string {
  const s = readJson(settingsPath);
  const command = opts.named
    ? (Object.values(s).flatMap((v: any) => v?.[event] ?? []) as Array<{ command: string }>).find((h) => h.command.includes("attache-agent-hook"))!.command
    : (s.hooks[event] as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks).find((h) => h.command.includes("attache-agent-hook"))!.command;
  const harness = settingsPath.includes(".codex") ? "codex" : settingsPath.includes(".gemini") ? "antigravity" : "claude-code";
  return runInShell(hookShell(harness), command, { input: JSON.stringify(input), env: { ...process.env, ...homeEnv(HOME), ...opts.env } });
}

async function until<T>(fn: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const untilSpoolEmpty = () => until(() => !readdirSync(spoolDir(svc.stateDir)).some((f) => f.endsWith(".json")));
/** Warnings and errors the service logged about one Harness session. */
const warnings = (sessionId: string) =>
  readFileSync(join(svc.stateDir, "logs/service.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { level: string; msg: string; data?: { sessionId?: string } })
    .filter((e) => (e.level === "warn" || e.level === "error") && e.data?.sessionId === sessionId);
const savedSessions = (sessionId: string) => {
  const dir = join(svc.dataDir, "evidence/sessions/transcripts/claude-code");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(sessionId)) : [];
};

const distillJobs = () => svc.app.jobs.list({ kind: "session-distill", limit: 50 });
const jobsFor = (sessionId: string) =>
  (svc.app.db.prepare("select id from jobs where kind = 'session-distill' and json_extract(input, '$.sessionId') = ?").all(sessionId) as Array<{ id: string }>).map((r) => svc.app.jobs.get(r.id)!);

beforeAll(async () => {
  for (const d of [".claude", ".codex", ".gemini/config"]) mkdirSync(join(HOME, d), { recursive: true });
  writeFileSync(join(HOME, ".claude/settings.json"), JSON.stringify(FOREIGN_CLAUDE, null, 2));
  mkdirSync(join(HOME, ".local/bin"), { recursive: true });
  // The Antigravity command-line tool, as this operating system names an executable.
  writeFileSync(join(HOME, ".local/bin", process.platform === "win32" ? "agy.exe" : "agy"), "");
  fx = await startFixtureServer();
  installFixtureModel(fx);
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }, { subject: "Repositories", value: "acme/orion" }] }] });
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
  await fx?.close();
});

describe("Harness sessions", () => {
  it("connecting Claude Code adds only Attache's hooks and keeps everything else", async () => {
    const r = await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(r.test.ok).toBe(true);
    const s = readJson(join(HOME, ".claude/settings.json"));
    expect(s.model).toBe("opus");
    expect(s.hooks.PreToolUse).toEqual(FOREIGN_CLAUDE.hooks.PreToolUse);
    expect(s.hooks.SessionStart[0]).toEqual(FOREIGN_CLAUDE.hooks.SessionStart[0]);
    for (const e of ["SessionStart", "PreCompact", "SessionEnd"]) expect(JSON.stringify(s.hooks[e])).toContain("attache-agent-hook");
    // The previous file was backed up first.
    expect(readdirSync(svc.app.paths.backupsDir).some((f) => f.includes("claude_settings_json"))).toBe(true);
    // Saves go through the MCP server now; no skills are installed.
    expect(readJson(join(HOME, ".claude.json")).mcpServers).toEqual({ [registeredName()]: expect.objectContaining({ args: expect.arrayContaining(["mcp", svc.stateDir]) }) });
    expect(existsSync(join(HOME, ".claude/skills"))).toBe(false);
  });

  it("a new session starts with the user's Attache memory", async () => {
    await until(() => existsSync(join(svc.stateDir, "agents/session-context.md")));
    const out = JSON.parse(runHook(join(HOME, ".claude/settings.json"), "SessionStart", { session_id: "s1", cwd: work, source: "startup" }));
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(ctx).toContain("Name: Alex");
    expect(ctx).toContain("Orion migration");
    expect(ctx).toMatch(/search --state-dir/);
  });

  it("an ended session is archived and summarised into this Machine's session log for the day", async () => {
    await svc.call("PATCH", "/machine", { name: "Work Laptop" });
    const transcript = join(work, "s1.jsonl");
    writeFileSync(transcript, claudeTranscript("s1", join(work, "attache"), [["Should the hook call the API?", "We decided the hook only copies the transcript, because the SessionEnd budget is short."]]));
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s1", transcript_path: transcript, cwd: work, reason: "exit" });
    const job = await until(() => distillJobs().find((j) => j.status === "succeeded"));
    expect(job.result).toMatchObject({ summarised: true, durable: 1 });
    const archive = readdirSync(join(svc.dataDir, "evidence/sessions/transcripts/claude-code"));
    expect(archive).toHaveLength(1);
    const archived = readFileSync(join(svc.dataDir, "evidence/sessions/transcripts/claude-code", archive[0]!), "utf8");
    expect(archived).toContain("### Alex");
    expect(archived).not.toMatch(/system-reminder|tool output|private reasoning/);
    const logs = readdirSync(join(svc.dataDir, "evidence/sessions")).filter((f) => f.endsWith(".md"));
    // Each Machine writes its own session log, named after it.
    expect(logs).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-work-laptop-[0-9a-f]{8}\.md$/)]);
    const log = readFileSync(join(svc.dataDir, "evidence/sessions", logs[0]!), "utf8");
    expect(log).toContain("machine: Work Laptop");
    expect(log).toContain("We decided the hook only copies the transcript");
    expect(log).toContain("](transcripts/claude-code/");
    expect(readdirSync(spoolDir(svc.stateDir)).filter((f) => !f.startsWith("."))).toEqual([]);
  });

  it("the agent's deeper-recall command finds the session log, never the raw transcript", async () => {
    const main = join(import.meta.dirname, "../../src/main.ts");
    const hits = JSON.parse(execFileSync(process.execPath, [main, "search", "hook copies transcript budget", "--state-dir", svc.stateDir, "--json"], { encoding: "utf8" })) as Array<{ file: string; lines: [number, number] }>;
    // The CLI prints this operating system's own absolute paths.
    const files = hits.map((h) => h.file.replace(/\\/g, "/"));
    expect(files.some((f) => /\/evidence\/sessions\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(f))).toBe(true);
    expect(files.some((f) => f.includes("/transcripts/"))).toBe(false);
    expect(hits[0]!.file.startsWith(svc.dataDir)).toBe(true);
  });

  it("a save through the registered MCP server, confirmed in the Harness, writes curated memory that cites the session", async () => {
    const entry = readJson(join(HOME, ".claude.json")).mcpServers[registeredName()];
    const client = await mcp.connectRegistered(entry, { name: "claude-code", cwd: work, env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s1" }, confirm: () => ({ action: "accept", content: {} }) });
    const items = [{ action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: "Cutover moved to November", reason: "vendor delay" }] }];
    const r = await callTool<{ outcome: string }>(client, "save", { items });
    expect(r.data.outcome).toBe("saved");
    const note = readFileSync(join(svc.dataDir, "memory/projects/orion-migration.md"), "utf8");
    // s1 was archived above, so the fact cites its transcript.
    expect(note).toMatch(/Cutover moved to November — source: Claude Code session in attache-it-agentwork-\w+ \(agent-session: evidence\/sessions\/transcripts\/claude-code\/\d{4}-\d{2}-\d{2}-s1\.md/);
  });

  it("a compaction then the end of the same session adds only the new turns", async () => {
    const transcript = join(work, "s2.jsonl");
    const first: Array<[string, string]> = [["Plan the cutover.", "We decided on a weekend cutover."]];
    writeFileSync(transcript, claudeTranscript("s2", work, first));
    runHook(join(HOME, ".claude/settings.json"), "PreCompact", { session_id: "s2", transcript_path: transcript, cwd: work, trigger: "auto" });
    await until(() => distillJobs().filter((j) => j.status === "succeeded").length === 2);
    writeFileSync(transcript, claudeTranscript("s2", work, [...first, ["And the rollback?", "We chose to keep the old ledger read-only for a week."]]));
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s2", transcript_path: transcript, cwd: work, reason: "exit" });
    await until(() => distillJobs().filter((j) => j.status === "succeeded").length === 3);
    const day = readdirSync(join(svc.dataDir, "evidence/sessions")).find((f) => f.endsWith(".md"))!;
    const log = readFileSync(join(svc.dataDir, "evidence/sessions", day), "utf8");
    expect(log.match(/weekend cutover/g)).toHaveLength(1);
    expect(log).toContain("(continued)");
    expect(log).toContain("keep the old ledger read-only");
  });

  it("a Claude Code command that never starts a conversation is skipped quietly", async () => {
    // What Claude Code 2.1 sends after `claude mcp list`: a SessionEnd for a session whose transcript was never written.
    const id = "d3ba5d6a-fb45-4dff-b150-46f65ee641c8";
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: id, transcript_path: join(HOME, ".claude/projects/-work", `${id}.jsonl`), cwd: work, hook_event_name: "SessionEnd", reason: "other" });
    await untilSpoolEmpty();
    expect(warnings(id)).toEqual([]);
    expect(savedSessions(id)).toEqual([]);
  });

  it("a session whose transcript is gone after part of it was saved still warns", async () => {
    const id = "s-vanished";
    const transcript = join(work, `${id}.jsonl`);
    writeFileSync(transcript, claudeTranscript(id, work, [["Keep this?", "We decided to keep it."]]));
    runHook(join(HOME, ".claude/settings.json"), "PreCompact", { session_id: id, transcript_path: transcript, cwd: work, trigger: "auto" });
    await until(() => savedSessions(id).length === 1);
    rmSync(transcript);
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: id, transcript_path: transcript, cwd: work, reason: "exit" });
    await untilSpoolEmpty();
    expect(warnings(id)).toEqual([expect.objectContaining({ msg: "agent session not saved", data: expect.objectContaining({ event: "session-end", reason: expect.stringContaining("Transcript not found") }) })]);
  });

  it("a session summarised in a project's repository starts that project's next sessions", async () => {
    const repo = join(work, "orion-checkout");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/orion.git"], { cwd: repo });
    const transcript = join(work, "s-orion.jsonl");
    writeFileSync(transcript, claudeTranscript("s-orion", repo, [["How do we migrate the ledger?", "We decided to migrate the ledger table by table."]]));
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s-orion", transcript_path: transcript, cwd: repo, reason: "exit" });
    await until(() => jobsFor("s-orion").some((j) => j.status === "succeeded"));

    const start = (cwd: string) => JSON.parse(runHook(join(HOME, ".claude/settings.json"), "SessionStart", { session_id: "s-next", cwd, source: "startup" })).hookSpecificOutput.additionalContext as string;
    const ctx = await until(() => {
      const c = start(repo);
      return c.includes("migrate the ledger table by table") && c;
    });
    expect(ctx).toContain("### This session's project: Orion migration");
    // A session elsewhere does not get it.
    expect(start(work)).not.toContain("migrate the ledger table by table");
  });

  it("sessions are saved even when Attache was not running", async () => {
    const stateDir = svc.stateDir;
    const dataDir = svc.dataDir;
    await svc.stop();
    const transcript = join(work, "s3.jsonl");
    writeFileSync(transcript, claudeTranscript("s3", work, [["Offline question?", "We decided to queue it."]]));
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s3", transcript_path: transcript, cwd: work });
    expect(readdirSync(spoolDir(stateDir)).some((f) => f.endsWith(".json"))).toBe(true);
    svc = await startTestService({ stateDir, dataDir });
    await until(() => readdirSync(join(dataDir, "evidence/sessions/transcripts/claude-code")).some((f) => f.includes("s3")));
  });

  it("Codex: hooks in ~/.codex/hooks.json, transcript found by session id when the hook input has none", async () => {
    await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    const hooks = readJson(join(HOME, ".codex/hooks.json"));
    expect(hooks.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(6000);
    const id = "019a0000-0000-7000-8000-00000000c0de";
    const dir = join(HOME, ".codex/sessions/2026/10/02");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-02T09-00-00-${id}.jsonl`), codexRollout(id, join(work, "api"), [["Fix CI?", "We decided to pin the runner image."]]));
    runHook(join(HOME, ".codex/hooks.json"), "SessionEnd", { session_id: id, transcript_path: null, cwd: work, reason: "other" });
    await until(() => existsSync(join(svc.dataDir, "evidence/sessions/transcripts/codex")) && readdirSync(join(svc.dataDir, "evidence/sessions/transcripts/codex")).length === 1);
    const archived = readFileSync(join(svc.dataDir, "evidence/sessions/transcripts/codex", readdirSync(join(svc.dataDir, "evidence/sessions/transcripts/codex"))[0]!), "utf8");
    expect(archived).toContain("pin the runner image");
    expect(archived).not.toContain("Attache memory");
  });

  it("Antigravity: a named hooks entry, an always-on memory rule, and turn-by-turn capture that waits for a quiet spell", async () => {
    writeFileSync(join(HOME, ".gemini/config/hooks.json"), JSON.stringify({ "claude-mem": { enabled: true, PreInvocation: [{ type: "command", command: "claude-mem inject", timeout: 30 }] } }));
    await svc.post("/connections/antigravity/configure", { method: "hooks", fields: {} });
    const hooks = readJson(join(HOME, ".gemini/config/hooks.json"));
    expect(hooks["claude-mem"].PreInvocation[0].command).toBe("claude-mem inject");
    const rules = readdirSync(join(HOME, ".gemini/config/rules"));
    expect(rules).toHaveLength(1);
    const rule = readFileSync(join(HOME, ".gemini/config/rules", rules[0]!), "utf8");
    expect(rule).toMatch(/^---\ntrigger: always_on\n/);
    expect(rule).toContain("Orion migration");

    const transcript = join(work, "brain/conv-1/.system_generated/logs/transcript.jsonl");
    mkdirSync(join(work, "brain/conv-1/.system_generated/logs"), { recursive: true });
    writeFileSync(transcript, antigravityTranscript([["Draft the release notes.", "We decided to group them by area."]]));
    // Not idle yet: nothing is captured.
    runHook(join(HOME, ".gemini/config/hooks.json"), "Stop", { conversationId: "conv-1", transcriptPath: transcript, workspacePaths: [work], fullyIdle: false }, { named: true });
    runHook(join(HOME, ".gemini/config/hooks.json"), "Stop", { conversationId: "conv-1", transcriptPath: transcript, workspacePaths: [work], fullyIdle: true }, { named: true });
    await until(() => existsSync(join(svc.dataDir, "evidence/sessions/transcripts/antigravity")));
    const pending = await until(() => distillJobs().find((j) => (j as { input?: { agent?: string } }).input?.agent === "antigravity" || j.title.includes("Antigravity")));
    expect(pending.status).toBe("queued");
    const row = svc.app.db.prepare("select run_after from jobs where id = ?").get(pending.id) as { run_after: string };
    expect(Date.parse(row.run_after)).toBeGreaterThan(Date.now() + 10 * 60_000);
  });

  it("Antigravity: every new turn restarts the quiet wait", async () => {
    const transcript = join(work, "brain/conv-1/.system_generated/logs/transcript.jsonl");
    const job = distillJobs().find((j) => j.status === "queued" && j.title.includes("Antigravity"))!;
    const before = (svc.app.db.prepare("select run_after from jobs where id = ?").get(job.id) as { run_after: string }).run_after;
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(transcript, antigravityTranscript([["Draft the release notes.", "We decided to group them by area."], ["And the order?", "Newest first."]]));
    runHook(join(HOME, ".gemini/config/hooks.json"), "Stop", { conversationId: "conv-1", transcriptPath: transcript, workspacePaths: [work], fullyIdle: true }, { named: true });
    await until(() => (svc.app.db.prepare("select run_after from jobs where id = ?").get(job.id) as { run_after: string }).run_after > before);
    expect(distillJobs().filter((j) => j.status === "queued" && j.title.includes("Antigravity"))).toHaveLength(1);
  });

  it("a transcript no parser understands is logged and kept as a sample, not silently dropped", async () => {
    const transcript = join(work, "brain/conv-2/.system_generated/logs/transcript.jsonl");
    mkdirSync(join(work, "brain/conv-2/.system_generated/logs"), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ some: "future format" }) + "\n");
    runHook(join(HOME, ".gemini/config/hooks.json"), "Stop", { conversationId: "conv-2", transcriptPath: transcript, workspacePaths: [work], fullyIdle: true }, { named: true });
    await until(() => existsSync(join(svc.stateDir, "agents/unparsed")) && readdirSync(join(svc.stateDir, "agents/unparsed")).some((f) => f.includes("conv-2")));
  });

  it("Antigravity: a finished turn whose transcript is missing still warns, since a turn means a conversation", async () => {
    const id = "conv-missing";
    runHook(join(HOME, ".gemini/config/hooks.json"), "Stop", { conversationId: id, transcriptPath: join(work, "brain", id, ".system_generated/logs/transcript.jsonl"), workspacePaths: [work], fullyIdle: true }, { named: true });
    await untilSpoolEmpty();
    expect(warnings(id)).toEqual([expect.objectContaining({ msg: "agent session not saved", data: expect.objectContaining({ event: "turn-end" }) })]);
  });

  it("long sessions are summarised in parts, so early decisions are not lost; secrets never reach the summariser", async () => {
    const filler = "Background detail that is not a decision. ".repeat(60);
    const talk: Array<[string, string]> = [["Kick off.", "We decided to start with the ledger import."], ...Array.from({ length: 70 }, (_, i): [string, string] => [`Step ${i}? token ghp_abcdefghijklmnopqrstuvwxyz0123456789`, filler]), ["Wrap up.", "We decided to finish with the invoice export."]];
    const transcript = join(work, "s-long.jsonl");
    writeFileSync(transcript, claudeTranscript("s-long", work, talk));
    writeFileSync(join(HOME, ".claude/settings.json"), JSON.stringify(FOREIGN_CLAUDE));
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s-long", transcript_path: transcript, cwd: work });
    const job = await until(() => jobsFor("s-long").find((j) => j.status === "succeeded"), 20_000);
    expect(job.result).toMatchObject({ durable: 2 });
    const day = readdirSync(join(svc.dataDir, "evidence/sessions")).find((f) => f.endsWith(".md"))!;
    const log = readFileSync(join(svc.dataDir, "evidence/sessions", day), "utf8");
    expect(log).toContain("start with the ledger import");
    expect(log).toContain("finish with the invoice export");
    const cache = readdirSync(join(svc.stateDir, "agents/sessions/claude-code")).find((f) => f.includes("s-long"))!;
    expect(readFileSync(join(svc.stateDir, "agents/sessions/claude-code", cache), "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("two summaries of one session never log the same turns twice", async () => {
    const transcript = join(work, "s-race.jsonl");
    writeFileSync(transcript, claudeTranscript("s-race", work, [["Race?", "We decided the race is handled once."]]));
    // Ingest without the usual queued summary, then start two summaries at the same instant,
    // as when a compaction's summary is still running when the session ends.
    const create = svc.app.jobs.create.bind(svc.app.jobs);
    svc.app.jobs.create = ((input: Parameters<typeof create>[0]) => (input.kind === "session-distill" && input.input.sessionId === "s-race" ? { job: null, existing: true } : create(input))) as typeof create;
    try {
      runHook(join(HOME, ".claude/settings.json"), "SessionEnd", { session_id: "s-race", transcript_path: transcript, cwd: work });
      await until(() => svc.app.db.prepare("select 1 from agent_sessions where session_id = 's-race'").get());
    } finally {
      svc.app.jobs.create = create;
    }
    const ctx = () => ({ input: { agent: "claude-code", sessionId: "s-race" }, progress: () => {}, effect: async (_k: string, fn: () => Promise<unknown>) => fn(), signal: new AbortController().signal }) as never;
    await Promise.all([svc.app.sessions.distill(ctx()), svc.app.sessions.distill(ctx())]);
    const day = readdirSync(join(svc.dataDir, "evidence/sessions")).find((f) => f.endsWith(".md"))!;
    expect(readFileSync(join(svc.dataDir, "evidence/sessions", day), "utf8").match(/race is handled once/g)).toHaveLength(1);
  });

  it("uninstall carries on past an agent file it cannot edit, and says which", async () => {
    const { AgentHooks } = await import("../../src/agents/install.ts");
    const { AGENT_INTEGRATIONS } = await import("../../src/agents/integrations.ts");
    const hooks = new AgentHooks(svc.stateDir, svc.app.paths.backupsDir);
    await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    const claudeFile = join(HOME, ".claude/settings.json");
    const good = readFileSync(claudeFile, "utf8");
    writeFileSync(claudeFile, good + "\n// a comment Attache cannot parse");
    const results = hooks.uninstallAll(AGENT_INTEGRATIONS);
    expect(results.find((r) => r.agent === "claude-code")!.error).toMatch(/not valid JSON/);
    expect(JSON.stringify(readJson(join(HOME, ".codex/hooks.json")))).not.toContain("attache-agent-hook");
    writeFileSync(claudeFile, good);
  });

  it("disconnecting removes only Attache's hooks and memory rule", async () => {
    for (const k of ["claude-code", "codex", "antigravity"]) await svc.post(`/connections/${k}/disconnect`, { deleteData: false });
    expect(readJson(join(HOME, ".claude/settings.json"))).toEqual({ ...FOREIGN_CLAUDE });
    expect(readJson(join(HOME, ".codex/hooks.json"))).toEqual({ hooks: {} });
    expect(Object.keys(readJson(join(HOME, ".gemini/config/hooks.json")))).toEqual(["claude-mem"]);
    expect(readdirSync(join(HOME, ".gemini/config/rules"))).toEqual([]);
    expect(readJson(join(HOME, ".claude.json")).mcpServers).toBeUndefined();
    expect(existsSync(join(HOME, ".codex/config.toml")) ? readFileSync(join(HOME, ".codex/config.toml"), "utf8") : "").not.toContain("--state-dir");
    expect(readJson(join(HOME, ".gemini/config/mcp_config.json")).mcpServers).toBeUndefined();
  });

  it("hooks from another Attache instance are left alone", async () => {
    const other = { hooks: { SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "'node' 'attache-agent-hook.mjs' claude-code session-end --state-dir '/elsewhere/state'", timeout: 5 }] }] } };
    writeFileSync(join(HOME, ".claude/settings.json"), JSON.stringify(other));
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.post("/connections/claude-code/disconnect", { deleteData: false });
    expect(readJson(join(HOME, ".claude/settings.json"))).toEqual(other);
  });

  it("turning the feature off removes the hooks and stops injecting memory", async () => {
    writeFileSync(join(HOME, ".claude/settings.json"), JSON.stringify(FOREIGN_CLAUDE));
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    await svc.put("/features", { changes: { sessions: false }, cascade: true });
    await until(() => !JSON.stringify(readJson(join(HOME, ".claude/settings.json"))).includes("attache-agent-hook"));
    expect(existsSync(join(svc.stateDir, "agents/session-context.md"))).toBe(false);
  });
});
