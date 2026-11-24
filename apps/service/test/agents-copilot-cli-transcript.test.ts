import { describe, expect, it } from "vitest";
import { parseCopilotCli } from "../src/agents/copilot-cli-transcript.ts";
import { MEMORY, SECRET, SIDE, SUBAGENT, TOOL_OUTPUT, assistant, compaction, event, events, hook, iso, memoryHook, normal, readTool, resume, shutdown, start, subagent, system, turn, turnEnd, user } from "./fixtures/agents/copilot-cli.ts";

/**
 * Copilot CLI's events.jsonl, as Attache's hooks copy it, normalised to the
 * conversation: the owner's and the assistant's text only.
 */

const said = (raw: string) => parseCopilotCli(raw).turns.map((t) => [t.role, t.text]);
const NORMAL_TURNS = [
  ["user", "Should the cutover wait for the audit?"],
  ["assistant", "Yes: we decided to wait, because the audit closes Friday."],
  ["user", "Check the env file"],
  ["assistant", "The file sets an API key; I left it alone."],
];

describe("Copilot CLI sessions", () => {
  it("keeps the owner's and the assistant's text, in order, and drops the system prompt, instructions, hooks, tool calls, tool output and reasoning", () => {
    const p = parseCopilotCli(events(normal()));
    expect(p.turns.map((t) => [t.role, t.text])).toEqual(NORMAL_TURNS);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(JSON.stringify(p)).not.toContain(TOOL_OUTPUT);
    expect(JSON.stringify(p)).not.toContain(SIDE);
    expect(p.cwd).toBe("/work/orion");
    expect(p.startedAt).toBe(p.turns[0]!.at);
    expect(p.title).toBeNull();
    expect(p.problem).toBeUndefined();
  });

  it("gives every turn the id of the Copilot CLI event it came from", () => {
    const list = normal();
    const ids = list.filter((e) => (e.type === "user.message" || e.type === "assistant.message") && e.data.content).map((e) => e.id);
    expect(parseCopilotCli(events(list)).turns.map((t) => t.id)).toEqual(ids);
  });

  it("uses what the owner typed, not the text Copilot CLI wrapped for the model", () => {
    const p = parseCopilotCli(events([start(), user("Plain prompt", 1), assistant("Ok", 2)]));
    expect(p.turns[0]!.text).toBe("Plain prompt");
    expect(JSON.stringify(p.turns)).not.toContain("current_datetime");
  });

  it("keeps a message the owner sent while the assistant was still working", () => {
    expect(said(events([start(), user("Go", 1), user("Also check the docs", 2, { delivery: "steering" }), assistant("Done", 3)]))).toEqual([
      ["user", "Go"],
      ["user", "Also check the docs"],
      ["assistant", "Done"],
    ]);
  });

  it("uses the matching root turn's start and never borrows it for another interaction", () => {
    const sideTurn = event("assistant.turn_start", 3, { turnId: "side", interactionId: "child", parentToolCallId: "call_1" });
    const p = parseCopilotCli(events([
      start(), user("Go", 1), ...turn(2), sideTurn,
      assistant("Other interaction", 4, { interactionId: "child" }),
      assistant("Root response", 5), turnEnd(6),
    ]));
    expect(p.turns.slice(1)).toMatchObject([
      { text: "Other interaction", at: null, completedAt: iso(4) },
      { text: "Root response", at: iso(2), completedAt: iso(5) },
    ]);
  });

  it("a file Copilot CLI has only started, or one with nothing said yet, yields no turns and no problem", () => {
    expect(parseCopilotCli(events([start(), ...hook("sessionStart", 0)]))).toEqual({ turns: [], title: null, cwd: "/work/orion", startedAt: null });
    expect(parseCopilotCli("")).toEqual({ turns: [], title: null, cwd: null, startedAt: null });
  });

  it("ignores a last line Copilot CLI has not finished writing", () => {
    const raw = events([start(), user("Go", 1), assistant("Done", 2)]) + '{"id":"x","type":"assis';
    expect(said(raw)).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });
});

describe("Copilot CLI compaction", () => {
  it("keeps the turns before and after a compaction, which Copilot CLI keeps in the file, and drops its summary", () => {
    const list = [...normal(), ...compaction(6), user("Thanks, ship it", 7), system(7), ...turn(8), assistant("Shipped.", 8), turnEnd(8)];
    const p = parseCopilotCli(events(list));
    expect(p.turns.map((t) => t.text)).toEqual([...NORMAL_TURNS.map((t) => t[1]), "Thanks, ship it", "Shipped."]);
    expect(JSON.stringify(p)).not.toContain("overview");
  });

  it("a copy taken before compaction holds the start of what a later copy holds", () => {
    const before = normal();
    const a = parseCopilotCli(events([...before, ...hook("preCompact", 6)])).turns;
    const b = parseCopilotCli(events([...before, ...compaction(6), user("After", 7), assistant("Yes", 8)])).turns;
    expect(b.slice(0, a.length)).toEqual(a);
  });
});

describe("resumed Copilot CLI sessions", () => {
  it("a resumed session's file holds its earlier turns, the same, then the new ones", () => {
    const first = [...normal(), ...hook("sessionEnd", 6), shutdown(6)];
    const resumed = [...first, resume(20), memoryHook(20)[0]!, user("Back again", 21), memoryHook(21)[1]!, assistant("Welcome back", 22), shutdown(23)];
    const a = parseCopilotCli(events(first)).turns;
    const b = parseCopilotCli(events(resumed)).turns;
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b.slice(a.length).map((t) => t.text)).toEqual(["Back again", "Welcome back"]);
    expect(JSON.stringify(b)).not.toContain(MEMORY);
  });
});

describe("injected context and side-chains in Copilot CLI sessions", () => {
  it("drops Attache's memory, which Copilot CLI keeps on the sessionStart hook's end event", () => {
    const p = parseCopilotCli(events(normal()));
    expect(events(normal())).toContain(MEMORY);
    expect(JSON.stringify(p)).not.toContain(MEMORY);
  });

  it("strips Attache's memory tag and injected reminders from text", () => {
    const list = [start(), user(`<attache-memory>\n${MEMORY}\n</attache-memory>\nWhat did we decide?`, 1), assistant(`<system-reminder>${SIDE}</system-reminder>We decided to wait.`, 2)];
    const p = parseCopilotCli(events(list));
    expect(p.turns.map((t) => t.text)).toEqual(["What did we decide?", "We decided to wait."]);
  });

  it("drops a subagent's prompt, system prompt and answer, and the task tool's output", () => {
    const list = [...normal(), user("Explore the repo", 6), ...turn(6), ...subagent(6), ...turn(7, "1"), assistant("The explorer found the config.", 7), turnEnd(7, "1")];
    expect(said(events(list)).slice(4)).toEqual([
      ["user", "Explore the repo"],
      ["assistant", "The explorer found the config."],
    ]);
  });

  it("drops a message Copilot CLI or another agent put in the owner's place", () => {
    const list = [start(), user("Go", 1), user(`${SIDE} hidden skill`, 1, { source: "skill-pdf" }), user(`${SIDE} keep going`, 2, { isAutopilotContinuation: true }), assistant("Done", 3), assistant(`${SIDE}`, 3, { parentToolCallId: "call_9" })];
    expect(said(events(list))).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });

  it("keeps an answer whose parentToolCallId is null: only a subagent's answer names a parent tool call", () => {
    expect(said(events([start(), user("Go", 1, { source: null }), assistant("Done", 2, { parentToolCallId: null })]))).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });

  it("never lets a plain marker in tool output, injected memory or a subagent's output reach the turns", () => {
    const list = [...normal(), ...readTool(6), ...subagent(7), user(`<attache-memory>${MEMORY}</attache-memory>Final?`, 8), assistant("All done.", 9)];
    const p = parseCopilotCli(events(list));
    expect(p.turns.at(-1)!.text).toBe("All done.");
    for (const marker of [TOOL_OUTPUT, MEMORY, SIDE, SECRET]) expect(JSON.stringify(p.turns)).not.toContain(marker);
  });
});

describe("Copilot CLI formats Attache cannot read", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["a single non-JSON line", "not an event", /not JSON/],
    ["a line that is not an event", events([start(), user("Go", 1)]).replace("\n", '\n["what"]\n'), /line that is not an event/],
    ["a line that is not JSON in the middle", events([start(), user("Go", 1)]).replace("\n", "\n{oops\n"), /not JSON/],
    ["a file that does not start with session.start", events([user("Go", 1), assistant("Ok", 2)]), /does not start with session\.start/],
    ["a newer events format", events([start(0, 2), user("Go", 1)]), /Copilot CLI events format version 2/],
    ["another producer", events([{ ...start(), data: { ...start().data, producer: "someone-else" } }, user("Go", 1)]), /producer "someone-else"/],
    ["an unknown message event", events([start(), user("Go", 1), event("user.voice_message", 2, { content: SECRET })]), /event of type "user\.voice_message"/],
    ["an unknown kind of event", events([start(), user("Go", 1), event("conversation.turn", 2, { content: SECRET })]), /event of type "conversation\.turn"/],
    ["a message whose text is not a string", events([start(), user("Go", 1), assistant("Ok", 2), { ...user("x", 3), data: { content: [{ type: "text", text: SECRET }] } }]), /not text/],
    ["an event without a type", events([start(), { ...user("Go", 1), type: undefined as unknown as string }]), /without a type/],
    ["an assistant message in a phase Attache does not know", events([start(), user("Go", 1), assistant(SECRET, 2, { phase: "planning" })]), /phase "planning"/],
  ];
  for (const [name, raw, problem] of cases) {
    it(`${name} yields no turns and names the Copilot CLI format that failed`, () => {
      const p = parseCopilotCli(raw);
      expect(p.turns).toEqual([]);
      expect(p.problem).toMatch(problem);
      expect(p.problem).toMatch(/Copilot CLI/);
    });
  }

  it("skips events Copilot CLI keeps for itself that are never the conversation", () => {
    const list = [start(), event("session.usage_checkpoint", 1, { totalNanoAiu: 0 }), event("permission.requested", 1, { tool: SECRET }), event("skill.invoked", 1, { name: SIDE }), user("Go", 1), event("session.info", 1, { message: SIDE }), assistant("Done", 2)];
    expect(said(events(list))).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });

  it("drops the assistant's thinking and keeps its response", () => {
    expect(said(events([start(), user("Go", 1), assistant(`${SECRET} hmm`, 2, { phase: "thinking" }), assistant("Done", 2, { phase: "response" })]))).toEqual([
      ["user", "Go"],
      ["assistant", "Done"],
    ]);
  });

  it("drops events with an agentId even of a kind it otherwise keeps", () => {
    expect(said(events([start(), user("Go", 1), assistant(SIDE, 2, {}, { agentId: SUBAGENT })]))).toEqual([["user", "Go"]]);
  });
});
