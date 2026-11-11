import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { homeEnv, hookShell, runInShell } from "../fixtures/harness-shell.ts";

/**
 * What the session context holds (spec seam 2): the session-start hook, run
 * in a folder with a git remote, prints the project's context, at about 8 KB;
 * anywhere else it prints the global index.
 */
const HOME = process.env.JARVIS_AGENT_HOME!;
const BUDGET = 8 * 1024;
const work = mkdtempSync(join(tmpdir(), "jarvis-it-ctxcontent-"));
const running: TestService[] = [];

afterEach(async () => {
  for (const svc of running.splice(0)) await svc.stop();
});

const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

let repos = 0;
/** A local repository whose `origin` is `remote`; nothing is ever fetched. */
function repo(remote: string): string {
  const dir = join(work, `repo-${++repos}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
  return dir;
}

/** Run the SessionStart command Jarvis registered, from `cwd`, the way Claude Code does. */
function sessionStart(cwd: string): string {
  const s = JSON.parse(readFileSync(join(HOME, ".claude/settings.json"), "utf8"));
  const command = (s.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks).find((h) => h.command.includes("jarvis-agent-hook"))!.command;
  const out = runInShell(hookShell("claude-code"), command, { cwd, input: JSON.stringify({ session_id: "s1", cwd, source: "startup" }), env: { ...process.env, ...homeEnv(HOME) } });
  return out.trim() ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "";
}

async function until<T>(fn: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- a Brain written by hand, the way the owner or another Machine leaves it --------------------

const FOLDER: Record<string, string> = { project: "projects", person: "people", decision: "decisions", note: "notes" };

interface NoteSpec {
  type: "project" | "person" | "decision" | "note";
  title: string;
  /** Current State lines without the leading `- `. */
  facts?: string[];
  notes?: string;
  /** Days since the note was last changed; orders "most recently updated first". */
  age?: number;
}

const fact = (subject: string, value: string, opts: { date?: string; review?: string } = {}) => `**${subject}** (${opts.date ?? day(3)}${opts.review ? `, review ${opts.review}` : ""}): ${value}`;

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function writeNote(dataDir: string, n: NoteSpec): string {
  const rel = `memory/${FOLDER[n.type]}/${slug(n.title)}.md`;
  const file = join(dataDir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  const body = [
    "---",
    `type: ${n.type}`,
    `title: ${n.title}`,
    "provenance: user-stated",
    "---",
    `# ${n.title}`,
    "",
    "## Current State",
    ...(n.facts ?? []).map((f) => `- ${f}`),
    ...(n.notes ? ["", "## Notes", n.notes] : []),
    "",
    "## History",
    `- ${day(30)} — created by user`,
    "",
  ].join("\n");
  writeFileSync(file, body);
  const at = new Date(Date.now() - (n.age ?? 1) * 86_400_000);
  utimesSync(file, at, at);
  return rel;
}

interface LogEntry {
  time: string;
  title: string;
  repository?: string;
  bullets: string[];
}

/** One Machine's session log for `date`, in the format every Machine writes. */
function writeSessionLog(dataDir: string, date: string, machine: string, entries: LogEntry[]) {
  mkdirSync(join(dataDir, "evidence/sessions"), { recursive: true });
  const sections = entries.map((e, i) =>
    [
      `## ${e.time} · Claude Code · orion`,
      "",
      `**${e.title}**`,
      "",
      ...(e.repository ? [`Repository: ${e.repository}`, ""] : []),
      ...e.bullets.map((b) => `- ${b}`),
      "",
      `Transcript: [${e.title}](transcripts/claude-code/${date}-${machine}-${i}.md)`,
    ].join("\n"),
  );
  writeFileSync(
    join(dataDir, "evidence/sessions", `${date}-${machine}.md`),
    `---\ntype: session-log\ntitle: Agent sessions on ${date}\ndate: ${date}\nmachine: ${machine}\nprovenance: agent-session-summary\n---\n# Agent sessions on ${date}\n\n${sections.join("\n\n")}\n`,
  );
}

function newBrain(): string {
  const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-it-ctxbrain-")), "data");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/** A service on `dataDir` with Claude Code connected through its hooks. */
async function serve(dataDir: string): Promise<TestService> {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  // Each test's service is a fresh install: the previous one's hooks name its own state folder.
  rmSync(join(HOME, ".claude/settings.json"), { force: true });
  const svc = await startTestService({ dataDir });
  running.push(svc);
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  return svc;
}

const PROJECT_HEADING = "### This session's project: Orion migration";
const ORION_REPO = "git@github.com:acme/orion.git";
const ORION_KEY = "github.com/acme/orion";
/** A fact or log bullet of about 300 bytes. */
const long = (what: string) => `${what}. ${"It was weighed against the alternatives at length, with the trade-offs written down. ".repeat(3)}`;

/** The context a session in Orion's repository starts with, once the service has written it. */
const orionContext = (dir: string) =>
  until(() => {
    const c = sessionStart(dir);
    return c.includes(PROJECT_HEADING) && c;
  });

/** The text of the `### <heading>` section, up to the next heading of that level or higher. */
function section(ctx: string, heading: string): string {
  const start = ctx.indexOf(heading);
  if (start < 0) return "";
  const rest = ctx.slice(start + heading.length);
  const level = /^#+/.exec(heading)![0].length;
  const next = new RegExp(`^#{1,${level}} `, "m").exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

describe("session context content", { timeout: 30_000 }, () => {
  it("in a known project: the project's full current state, its decisions, its people and its recent sessions", async () => {
    const dataDir = newBrain();
    const orion = writeNote(dataDir, {
      type: "project",
      title: "Orion migration",
      facts: [fact("Status", "Cutover planned for November"), fact("Owner", "Ada Lovelace"), fact("Repositories", "acme/orion"), fact("Budget", "40k EUR")],
      notes: "The vendor contract renews in January.",
    });
    writeNote(dataDir, { type: "project", title: "Atlas", facts: [fact("Status", "Discovery"), fact("Repositories", "acme/atlas")] });
    // Linked because the project names her, or because she names the project.
    writeNote(dataDir, { type: "person", title: "Ada Lovelace", facts: [fact("Role", "Engineering lead")] });
    writeNote(dataDir, { type: "person", title: "Grace Hopper", facts: [fact("Role", "CTO")], notes: "Sponsors the [[Orion migration]]." });
    writeNote(dataDir, { type: "person", title: "Linus", facts: [fact("Role", "Kernel maintainer")] });
    writeNote(dataDir, { type: "decision", title: "Use Postgres", facts: [fact("Decision", "The Orion migration moves every service to Postgres 17")] });
    writeNote(dataDir, { type: "decision", title: "Adopt Rust", facts: [fact("Decision", "New services are written in Rust")] });
    writeNote(dataDir, { type: "note", title: "Coffee preferences", facts: [fact("Order", "Flat white")] });
    writeSessionLog(dataDir, day(1), "laptop-1a2b3c4d", [
      { time: "09:10", title: "Fix cutover script", repository: "github.com/acme/orion", bullets: ["The cutover script now retries failed batches."] },
      { time: "11:00", title: "Atlas spike", repository: "github.com/acme/atlas", bullets: ["The Atlas spike is done."] },
    ]);
    writeSessionLog(dataDir, day(0), "desktop-9f8e7d6c", [{ time: "08:30", title: "Plan rollback", repository: "github.com/acme/orion", bullets: ["A rollback plan was agreed."] }]);

    const svc = await serve(dataDir);
    const ctx = await orionContext(repo(ORION_REPO));

    const project = section(ctx, PROJECT_HEADING);
    expect(project).toContain(join(svc.dataDir, orion));
    for (const value of ["Cutover planned for November", "Ada Lovelace", "acme/orion", "40k EUR"]) expect(project).toContain(value);

    const decisions = section(ctx, "#### Decisions");
    expect(decisions).toContain("Use Postgres");
    expect(decisions).toContain("moves every service to Postgres 17");
    expect(decisions).toContain("— memory/decisions/use-postgres.md");
    expect(decisions).not.toContain("Rust");

    const people = section(ctx, "#### People");
    expect(people).toContain("Engineering lead");
    expect(people).toContain("CTO");
    expect(people).not.toContain("Kernel maintainer");

    const sessions = section(ctx, "#### Recent sessions in this project");
    expect(sessions).toContain("A rollback plan was agreed.");
    expect(sessions).toContain("The cutover script now retries failed batches.");
    expect(sessions.indexOf("rollback plan")).toBeLessThan(sessions.indexOf("cutover script"));
    expect(sessions).not.toContain("Atlas spike");
    expect(sessions).toContain(`](${join(svc.dataDir, "evidence/sessions/transcripts/claude-code/")}`);
    // Nothing from other projects' facts or other notes' facts.
    expect(ctx).not.toContain("Flat white");
    expect(ctx).not.toContain("Discovery");
  });

  it("in a known project it also holds a short global index of note titles and how to search", async () => {
    const dataDir = newBrain();
    writeNote(dataDir, { type: "project", title: "Orion migration", facts: [fact("Repositories", "acme/orion")] });
    writeNote(dataDir, { type: "project", title: "Atlas", facts: [fact("Status", "Discovery")] });
    writeNote(dataDir, { type: "person", title: "Linus", facts: [fact("Role", "Kernel maintainer")] });
    writeNote(dataDir, { type: "decision", title: "Adopt Rust", facts: [fact("Decision", "New services are written in Rust")] });
    writeNote(dataDir, { type: "note", title: "Coffee preferences", facts: [fact("Order", "Flat white")] });
    await serve(dataDir);
    const ctx = await orionContext(repo(ORION_REPO));

    const index = section(ctx, "### What Jarvis remembers");
    for (const title of ["Atlas", "Linus", "Adopt Rust", "Coffee preferences"]) expect(index).toContain(title);
    // Titles only: the facts are one search away.
    for (const value of ["Discovery", "Kernel maintainer", "Flat white"]) expect(index).not.toContain(value);
    expect(section(ctx, "### Deeper recall")).toMatch(/search --state-dir .* "your query"/);
  });

  it("outside a known project the context is the global index only", async () => {
    const dataDir = newBrain();
    writeNote(dataDir, { type: "project", title: "Orion migration", facts: [fact("Status", "Cutover planned for November"), fact("Repositories", "acme/orion")] });
    writeNote(dataDir, { type: "person", title: "Ada Lovelace", facts: [fact("Role", "Engineering lead")], notes: "Leads the Orion migration." });
    writeNote(dataDir, { type: "decision", title: "Use Postgres", facts: [fact("Decision", "The Orion migration moves to Postgres 17")] });
    writeSessionLog(dataDir, day(0), "laptop-1a2b3c4d", [{ time: "08:30", title: "Plan rollback", repository: "github.com/acme/orion", bullets: ["A rollback plan was agreed."] }]);
    await serve(dataDir);
    await orionContext(repo(ORION_REPO));

    for (const dir of [repo("git@github.com:acme/elsewhere.git"), mkdtempSync(join(tmpdir(), "jarvis-it-plain-"))]) {
      const ctx = sessionStart(dir);
      expect(ctx).toContain("Name: Alex");
      for (const title of ["Orion migration", "Ada Lovelace", "Use Postgres"]) expect(section(ctx, "### What Jarvis remembers")).toContain(title);
      expect(ctx).toMatch(/search --state-dir .* "your query"/);
      expect(ctx).not.toContain("This session's project");
      for (const detail of ["Cutover planned for November", "Engineering lead", "Postgres 17", "A rollback plan was agreed.", "#### Decisions", "#### People", "Recent sessions"]) expect(ctx).not.toContain(detail);
    }
  });

  it("stays within about 8 KB, cutting the index first, then the oldest sessions, then the least recently updated linked notes", async () => {
    const dataDir = newBrain();
    const projectFacts = [fact("Status", "Cutover planned for November"), fact("Owner", "Ada Lovelace"), fact("Repositories", "acme/orion"), fact("Budget", "40k EUR")];
    writeNote(dataDir, { type: "project", title: "Orion migration", facts: projectFacts, age: 0 });
    for (let i = 0; i < 200; i++) writeNote(dataDir, { type: "note", title: `Reference note number ${i} on a long topic`, age: 2 + i / 100 });
    for (let i = 0; i < 10; i++) writeNote(dataDir, { type: "decision", title: `Orion decision ${i}`, facts: [fact("Decision", long(`Orion migration choice ${i}`))], age: 1 + i / 100 });
    for (let d = 0; d < 10; d++)
      writeSessionLog(
        dataDir,
        day(d),
        "laptop-1a2b3c4d",
        [9, 12, 15].map((h) => ({ time: `${String(h).padStart(2, "0")}:00`, title: `Session ${d}-${h}`, repository: ORION_KEY, bullets: [long(`Outcome of day ${d} at ${h}`)] })),
      );

    await serve(dataDir);
    const ctx = await orionContext(repo(ORION_REPO));
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(BUDGET);
    // The project's full current state is never cut.
    for (const line of projectFacts) expect(ctx).toContain(`- ${line}`);
    // The index went first: counts stay, titles go.
    const index = section(ctx, "### What Jarvis remembers");
    expect(index).toContain("- Notes (200)");
    expect(index).not.toContain("Reference note number");
    // Then the oldest sessions; every linked decision keeps its facts.
    expect(ctx).toContain("Outcome of day 0 at 15");
    expect(ctx).not.toContain("Outcome of day 9 at 9");
    for (let i = 0; i < 10; i++) expect(ctx).toContain(`Orion migration choice ${i}.`);
    expect(ctx).toMatch(/Cut to stay within about 8 KB: \d+ older session entries\. Search for them\./);
  });

  it("when the linked notes alone are too many, their least recently updated facts go after every session", async () => {
    const dataDir = newBrain();
    writeNote(dataDir, { type: "project", title: "Orion migration", facts: [fact("Status", "Cutover planned for November"), fact("Repositories", "acme/orion")], age: 0 });
    for (let i = 0; i < 40; i++) writeNote(dataDir, { type: i % 2 ? "person" : "decision", title: `Orion contact ${i}`, facts: [fact("Detail", long(`Orion migration detail ${i}`))], age: 1 + i / 100 });
    writeSessionLog(dataDir, day(0), "laptop-1a2b3c4d", [{ time: "09:00", title: "Plan rollback", repository: ORION_KEY, bullets: ["A rollback plan was agreed."] }]);

    await serve(dataDir);
    const ctx = await orionContext(repo(ORION_REPO));
    expect(Buffer.byteLength(ctx)).toBeLessThanOrEqual(BUDGET);
    expect(ctx).toContain("- **Status**");
    expect(ctx).not.toContain("A rollback plan was agreed.");
    expect(ctx).toContain("Orion migration detail 0.");
    expect(ctx).toContain("Orion migration detail 1.");
    expect(ctx).not.toContain("Orion migration detail 39.");
    expect(ctx).toMatch(/Cut to stay within about 8 KB: 1 older session entry, the facts of \d+ linked notes/);
  });

  it("marks every fact past its Review date as unverified, in the project's facts and in its linked notes", async () => {
    const dataDir = newBrain();
    const later = day(-30);
    writeNote(dataDir, {
      type: "project",
      title: "Orion migration",
      facts: [fact("Status", "Discovery", { review: "2026-01-15" }), fact("Owner", "Ada Lovelace", { review: later }), fact("Repositories", "acme/orion")],
    });
    writeNote(dataDir, { type: "person", title: "Ada Lovelace", facts: [fact("Role", "Engineering lead", { review: "2026-02-01" })] });
    await serve(dataDir);
    const lines = (await orionContext(repo(ORION_REPO))).split("\n");
    expect(lines.find((l) => l.includes("**Status**"))).toMatch(/Discovery \(unverified: Review date 2026-01-15 passed\)$/);
    expect(lines.find((l) => l.includes("**Owner**"))).not.toContain("unverified");
    expect(lines.find((l) => l.includes("**Role**"))).toMatch(/Engineering lead \(unverified: Review date 2026-02-01 passed\)$/);
  });
});
