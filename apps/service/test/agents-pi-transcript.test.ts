import { describe, expect, it } from "vitest";
import { parsePi } from "../src/agents/pi-transcript.ts";
import { HEADER, MEMORY, SECRET, SIDE, TOOL_OUTPUT, assistant, compaction, entry, modelChange, normal, snapshot, system, text, thinking, user } from "./fixtures/agents/pi.ts";

/**
 * Pi session snapshots, as Attache's Pi extension spools them, normalised to
 * the conversation: the owner's and the assistant's text only.
 */

const said = (raw: string) => parsePi(raw).turns.map((t) => [t.role, t.text]);

describe("Pi sessions", () => {
  it("keeps the owner's and the assistant's text, in order, and drops the system prompt, tool calls, tool output and thinking", () => {
    const p = parsePi(snapshot(normal()));
    expect(p.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Should the cutover wait for the audit?"],
      ["assistant", "Yes: we decided to wait, because the audit closes Friday."],
      ["user", "Check the env file"],
      ["assistant", "The file sets an API key; I left it alone."],
    ]);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(JSON.stringify(p)).not.toContain(TOOL_OUTPUT);
    expect(p.cwd).toBe("/work/orion");
    expect(p.startedAt).toBe(p.turns[0]!.at);
    expect(p.title).toBeNull();
    expect(p.problem).toBeUndefined();
  });

  it("gives every turn the id of the Pi entry it came from", () => {
    const entries = normal();
    expect(parsePi(snapshot(entries)).turns.map((t) => t.id)).toEqual([entries[3]!.id, entries[4]!.id, entries[5]!.id, entries[8]!.id]);
  });

  it("reads an owner's message Pi kept as plain text", () => {
    const u = user("x", 1);
    (u.message as { content: unknown }).content = "Plain prompt";
    expect(said(snapshot([u, assistant([text("Ok")], 2)]))).toEqual([
      ["user", "Plain prompt"],
      ["assistant", "Ok"],
    ]);
  });
});

describe("Pi compaction", () => {
  it("keeps the turns before and after a compaction and drops its summary, which Pi writes and the owner never said", () => {
    const before = normal();
    const entries = [...before, compaction(7, before[8]!.id), user("Thanks, ship it", 8), assistant([text("Shipped.")], 9)];
    const p = parsePi(snapshot(entries));
    expect(p.turns.map((t) => t.text)).toEqual(["Should the cutover wait for the audit?", "Yes: we decided to wait, because the audit closes Friday.", "Check the env file", "The file sets an API key; I left it alone.", "Thanks, ship it", "Shipped."]);
    expect(JSON.stringify(p)).not.toContain("read-files");
  });

  it("drops the compaction and branch summary messages Pi may put on the branch", () => {
    const summary = entry("message", 3, { message: { role: "compactionSummary", summary: `Summary with ${SECRET}`, tokensBefore: 1, timestamp: 1 } });
    const branch = entry("message", 4, { message: { role: "branchSummary", summary: "Branch summary", fromId: null, timestamp: 1 } });
    const branchEntry = entry("branch_summary", 4, { fromId: "x", summary: "Branch explored approach A" });
    expect(said(snapshot([user("Go", 1), summary, branch, branchEntry, assistant([text("Done")], 5)]))).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });
});

describe("resumed Pi sessions", () => {
  it("a resumed session's snapshot holds its earlier turns with the same ids, then the new ones", () => {
    const first = normal();
    const resumed = [...first, modelChange(20), user("Back again", 21), assistant([text("Welcome back")], 22)];
    const a = parsePi(snapshot(first)).turns;
    const b = parsePi(snapshot(resumed)).turns;
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b.slice(a.length).map((t) => t.text)).toEqual(["Back again", "Welcome back"]);
  });

  it("names the session after the name the owner gave it", () => {
    const entries = [...normal(), entry("session_info", 9, { name: "Orion cutover" })];
    expect(parsePi(snapshot(entries)).title).toBe("Orion cutover");
  });
});

describe("injected context in Pi sessions", () => {
  it("drops Attache's memory and every other extension's custom messages, whether entries or messages", () => {
    const entries = [
      entry("custom_message", 0, { customType: "attache-memory", content: `<attache-memory>\n${MEMORY}\n</attache-memory>`, display: false }),
      entry("custom_message", 0, { customType: "other-extension", content: `Context: ${SIDE}`, display: true }),
      entry("custom", 0, { customType: "attache-cursor", data: { note: SIDE } }),
      entry("message", 0, { message: { role: "custom", customType: "attache-memory", content: MEMORY, display: false, timestamp: 0 } }),
      ...normal(),
    ];
    const p = parsePi(snapshot(entries));
    expect(p.turns).toHaveLength(4);
    expect(JSON.stringify(p)).not.toContain(MEMORY);
    expect(JSON.stringify(p)).not.toContain(SIDE);
  });

  it("strips Attache's memory tag and injected reminders from text, and drops the owner's ! commands and their output", () => {
    const bash = entry("message", 2, { message: { role: "bashExecution", command: "cat .env", output: `${TOOL_OUTPUT} ${SECRET}`, exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } });
    const entries = [user(`<attache-memory>\n${MEMORY}\n</attache-memory>\nWhat did we decide?`, 1), bash, assistant([text(`<system-reminder>${SIDE}</system-reminder>We decided to wait.`)], 3)];
    const p = parsePi(snapshot(entries));
    expect(p.turns.map((t) => t.text)).toEqual(["What did we decide?", "We decided to wait."]);
    expect(JSON.stringify(p)).not.toMatch(new RegExp(`${MEMORY}|${SIDE}|${TOOL_OUTPUT}|${SECRET.slice(3)}`));
  });

  it("strips a skill's instructions that /skill:name puts ahead of the owner's words, and drops a message that is only a skill", () => {
    const skill = (args: string) => `<skill name="pdf-tools" location="/home/ada/.pi/agent/skills/pdf-tools/SKILL.md">\nReferences are relative to /home/ada.\n\n${SIDE} instructions\n</skill>${args}`;
    expect(said(snapshot([user(skill("\n\nextract report.pdf"), 1), assistant([text("Extracted.")], 2), user(skill(""), 3)]))).toEqual([
      ["user", "extract report.pdf"],
      ["assistant", "Extracted."],
    ]);
  });

  it("never lets a plain marker in tool output, injected memory or a subagent's output reach the turns", () => {
    const subagentResult = entry("message", 6, { message: { role: "toolResult", toolCallId: "call_2", toolName: "subagent", content: [{ type: "text", text: `Subagent says ${SIDE}` }], isError: false, timestamp: 1 } });
    const entries = [
      entry("custom_message", 0, { customType: "attache-memory", content: MEMORY, display: false }),
      ...normal(),
      assistant([{ type: "toolCall", id: "call_2", name: "subagent", arguments: { task: SIDE } }], 5, { stopReason: "toolUse" }),
      subagentResult,
      assistant([text("All done.")], 7),
    ];
    const p = parsePi(snapshot(entries));
    expect(p.turns.at(-1)!.text).toBe("All done.");
    for (const marker of [TOOL_OUTPUT, MEMORY, SIDE]) expect(JSON.stringify(p.turns)).not.toContain(marker);
  });
});

describe("Pi side-chains", () => {
  it("a cloned or forked session keeps only the turns after its fork point, which the parent session already saved", () => {
    const parent = normal();
    const child = [...parent, user("In the clone", 10), assistant([text("Cloned answer")], 11)];
    expect(said(snapshot(child, { header: { ...HEADER, id: "child", parentSession: "/p.jsonl" }, forkedAt: parent[8]!.id }))).toEqual([
      ["user", "In the clone"],
      ["assistant", "Cloned answer"],
    ]);
  });
});

describe("Pi formats Attache cannot read", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["not JSON", "{oops", /not JSON/],
    ["another envelope", JSON.stringify({ attache: "opencode-session", v: 1 }), /unknown envelope/],
    ["a newer envelope", snapshot(normal(), { v: 2 }), /unknown envelope/],
    ["no session header", snapshot(normal(), { header: null }), /without a session header/],
    ["a newer session version", snapshot(normal(), { header: { ...HEADER, version: 4 } }), /Pi session format version 4/],
    ["no entry list", snapshot({ entries: [] }), /without an entry list/],
    ["an unknown entry type", snapshot([...normal(), entry("bookmark", 9, {})]), /entry of type "bookmark"/],
    ["an unknown message role", snapshot([...normal(), entry("message", 9, { message: { role: "developer", content: SECRET } })]), /role "developer"/],
    ["a message without content Attache can read", snapshot([entry("message", 9, { message: { role: "user", content: { text: "?" } } })]), /neither text nor a list/],
    ["a fork point not on the branch", snapshot(normal(), { forkedAt: "nowhere" }), /fork point/],
  ];
  for (const [name, raw, problem] of cases) {
    it(`${name} yields no turns and names the Pi format that failed`, () => {
      const p = parsePi(raw);
      expect(p.turns).toEqual([]);
      expect(p.problem).toMatch(problem);
      expect(p.problem).toMatch(/Pi/);
    });
  }

  it("a snapshot with nothing said yet yields no turns and no problem", () => {
    expect(parsePi(snapshot([modelChange(0), thinking(0), system(0)]))).toEqual({ turns: [], title: null, cwd: "/work/orion", startedAt: null });
  });
});
