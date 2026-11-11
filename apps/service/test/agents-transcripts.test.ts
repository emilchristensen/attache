import { describe, expect, it } from "vitest";
import { parseAntigravity, parseClaudeCode, parseCodex, renderTurns } from "../src/agents/transcripts.ts";
import { parseSummary, projectLabel, sessionLogSection } from "../src/agents/summary.ts";
import { antigravityTranscript, claudeTranscript, codexRollout } from "./fixtures/agents/transcripts.ts";

const talk: Array<[string, string]> = [
  ["Should the hook wait for the service?", "No: we decided the hook only copies the transcript, because SessionEnd has a 1.5 second budget."],
  ["Ship it.", "Done."],
];

describe("agent transcripts", () => {
  it("Claude Code: keeps the conversation, drops tools, thinking, reminders and subagents", () => {
    const p = parseClaudeCode(claudeTranscript("s1", "/work/jarvis", talk));
    expect(p.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", talk[0]![0]],
      ["assistant", talk[0]![1]],
      ["user", talk[1]![0]],
      ["assistant", talk[1]![1]],
    ]);
    expect(p.title).toBe("Fixture session");
    expect(p.cwd).toBe("/work/jarvis");
    expect(JSON.stringify(p)).not.toMatch(/injected context|secret-looking|private reasoning|subagent chatter/);
  });

  it("Codex: skips developer messages (where Jarvis's own memory lands) and environment context", () => {
    const p = parseCodex(codexRollout("019a", "/work/api", talk));
    expect(p.turns).toHaveLength(4);
    expect(p.turns[0]).toMatchObject({ role: "user", text: talk[0]![0] });
    expect(p.cwd).toBe("/work/api");
    expect(JSON.stringify(p)).not.toMatch(/Jarvis memory|environment_context/);
  });

  it("Antigravity: user and model steps only", () => {
    const p = parseAntigravity(antigravityTranscript(talk));
    expect(p.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(p)).not.toMatch(/system note|private/);
  });

  it("unrecognised or broken lines yield nothing instead of garbage", () => {
    expect(parseClaudeCode("not json\n{}\n").turns).toEqual([]);
    expect(parseCodex('{"type":"event_msg"}').turns).toEqual([]);
    expect(parseAntigravity('{"step":1,"text":"unknown shape"}').turns).toEqual([]);
  });

  it("renders the most recent turns that fit", () => {
    const turns = parseClaudeCode(claudeTranscript("s1", "/w", talk)).turns;
    const text = renderTurns(turns, { user: "Alex", assistant: "Claude Code" }, 60);
    expect(text).toBe("Alex: Ship it.\n\nClaude Code: Done.");
  });
});

describe("session log entries", () => {
  it("parses the model's verdict", () => {
    expect(parseSummary("NOTHING_DURABLE")).toEqual([]);
    expect(parseSummary("- First.\n- Second.\nTrailing chatter")).toEqual(["First.", "Second."]);
    expect(parseSummary("One plain sentence.")).toEqual(["One plain sentence."]);
  });

  it("names worktree checkouts after their repository", () => {
    expect(projectLabel("/Users/x/.t3/worktrees/jarvis/t3code-10bf2bc4")).toBe("jarvis");
    expect(projectLabel("/Users/x/Projects/api/")).toBe("api");
    expect(projectLabel(null)).toBeNull();
  });

  it("says plainly when there was no model or nothing durable", () => {
    const base = { agentLabel: "Codex", title: "Fix CI", cwd: "/w/api", repositories: [], at: "2026-10-02T09:00:00Z", continued: false, transcriptLink: "transcripts/codex/x.md" };
    expect(sessionLogSection({ ...base, bullets: null })).toContain("No model is connected");
    expect(sessionLogSection({ ...base, bullets: [] })).toContain("Nothing durable");
    expect(sessionLogSection({ ...base, bullets: ["We decided X."], continued: true })).toMatch(/\*\*Fix CI\*\* \(continued\)[\s\S]*- We decided X\.[\s\S]*\]\(transcripts\/codex\/x\.md\)/);
  });
});

describe("session-start context", () => {
  it("outside a project is a short index: identity, titles per type, and the recall command", async () => {
    const { buildSessionContext } = await import("../src/agents/context.ts");
    const text = buildSessionContext({
      now: new Date("2026-10-02T10:00:00Z"),
      dataFolder: "/data",
      identity: { name: "Alex", email: "e@x.dk" },
      notes: [{ type: "project", title: "Kestrel" }, ...Array.from({ length: 40 }, (_, i) => ({ type: "project", title: `P${i}` }))],
      searchCommand: { line: "jarvis search", powershell: null },
    });
    expect(text).toContain("- Name: Alex");
    expect(text).toContain("- Projects (41): Kestrel; P0; P1;");
    expect(text).toContain("; P28; and 11 more");
    expect(text).toMatch(/ {4}jarvis search "your query"$/m);
    expect(text).not.toContain("PowerShell");
  });

  it("gives the search command in the form each Harness's shell runs", async () => {
    const { searchCommand } = await import("../src/agents/search-command.ts");
    const { buildSessionContext } = await import("../src/agents/context.ts");
    // macOS and Linux: one POSIX command.
    expect(searchCommand({ os: "macos", execPath: "/opt/jarvis/node", entry: "/opt/jarvis/jarvis-service.mjs", stateDir: "/s/it's" })).toEqual({
      line: `'/opt/jarvis/node' '/opt/jarvis/jarvis-service.mjs' search --state-dir '/s/it'\\''s'`,
      powershell: null,
    });
    // Windows: Git Bash (Claude Code) and cmd.exe run the quoted line; PowerShell (Codex) needs the call operator first.
    const windows = searchCommand({ os: "windows", execPath: "C:\\Jarvis\\node.exe", entry: "C:\\Jarvis\\jarvis-service.mjs", stateDir: "C:\\Jarvis\\state" });
    expect(windows).toEqual({
      line: `"C:/Jarvis/node.exe" "C:/Jarvis/jarvis-service.mjs" search --state-dir "C:/Jarvis/state"`,
      powershell: `& "C:/Jarvis/node.exe" "C:/Jarvis/jarvis-service.mjs" search --state-dir "C:/Jarvis/state"`,
    });
    const text = buildSessionContext({ now: new Date("2026-10-02T10:00:00Z"), dataFolder: "C:/data", identity: null, notes: [], searchCommand: windows });
    expect(text).toContain(`    ${windows.line} "your query"`);
    expect(text).toContain(`    ${windows.powershell} "your query"`);
  });

  it("strips a model's whole-bullet bold", () => {
    expect(parseSummary("- **Kestrel ships behind a flag.**")).toEqual(["Kestrel ships behind a flag."]);
    expect(parseSummary("- Use **one** flag.")).toEqual(["Use **one** flag."]);
  });
});

describe("review fixes: transcripts", () => {
  it("Claude Code: compaction summaries, task notifications and interruptions are not the user's words", () => {
    const rows = [
      { type: "user", isCompactSummary: true, timestamp: "t", message: { role: "user", content: "This session is being continued from a previous conversation..." } },
      { type: "user", origin: { kind: "task-notification" }, timestamp: "t", message: { role: "user", content: "<task-notification>done /tmp/out</task-notification>" } },
      { type: "user", timestamp: "t", message: { role: "user", content: "[Request interrupted by user for tool use]" } },
      { type: "user", isVisibleInTranscriptOnly: true, timestamp: "t", message: { role: "user", content: "visible only" } },
      { type: "user", timestamp: "t", message: { role: "user", content: "Real question <task-notification>x</task-notification>" } },
    ];
    const p = parseClaudeCode(rows.map((r) => JSON.stringify(r)).join("\n"));
    expect(p.turns.map((t) => t.text)).toEqual(["Real question"]);
  });

  it("splits long sessions into parts that each fit, in order", async () => {
    const { chunkTurns } = await import("../src/agents/transcripts.ts");
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, text: `${i}`.repeat(40), at: null }));
    const parts = chunkTurns(turns, 120);
    expect(parts.flat()).toEqual(turns);
    expect(parts.every((p) => p.length <= 2)).toBe(true);
    expect(chunkTurns([{ role: "user", text: "x".repeat(500), at: null }], 100)).toHaveLength(1);
  });
});
