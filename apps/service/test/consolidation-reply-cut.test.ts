import { describe, expect, it } from "vitest";
import { parseConsolidationReply } from "../src/consolidation/reply.ts";

/**
 * Consolidation's reply cut off at the model's token limit, at every character: only entries written out in full
 * before the cut are kept, and none of them changed. Unit level, because driving one Harness session per character
 * would take hours; the integration tests in consolidation-cut-off.test.ts drive the same reading through each provider.
 */

// Nested arrays and objects, and strings holding quotes, backslashes, brackets, commas, escapes and the reply's own opening.
const ENTRIES = [
  {
    item: { action: "update", path: "memory/projects/orion-migration.md", facts: [{ subject: "Status", value: 'He said "ship it]}" today, {not before}' }], events: ["Moved to C:\\deploy\\orion\\", "Line one\nline two\ttabbed"] },
    reason: 'The owner wrote "done", then \\"done\\" again.',
    evidence: "Café ☕ — ship it]}",
  },
  {
    item: { action: "create", type: "note", title: "Reply format [draft]", facts: [{ subject: "Shape", value: '{"proposals":[{"item":{}}]}' }], tags: ["json", "a,b", "]"], notes: "Backslash at the end \\" },
    reason: "Kept as written: \\u0041 is not an A.",
    evidence: '\\"quoted\\" and \u0000-free',
  },
  {
    item: { action: "update", path: "memory/people/sofie.md", facts: [{ subject: "Role", value: "Lead, \"Orion\" [launch] {team}" }, { subject: "Team", value: "}]," }] },
    reason: "The session named her role.",
    evidence: "Sofie leads the launch",
  },
];

/** How a model may lay the reply out: compact, indented, or indented in a code fence after a stray line. */
const LAYOUTS = [
  { name: "compact", reply: () => JSON.stringify({ proposals: ENTRIES }), entry: (e: unknown) => JSON.stringify(e) },
  { name: "indented", reply: () => JSON.stringify({ proposals: ENTRIES }, null, 2), entry: (e: unknown) => JSON.stringify(e, null, 2).replace(/\n/g, "\n    ") },
  { name: "fenced", reply: () => `Here are the changes:\n\`\`\`json\n${JSON.stringify({ proposals: ENTRIES }, null, 2)}\n\`\`\``, entry: (e: unknown) => JSON.stringify(e, null, 2).replace(/\n/g, "\n    ") },
];

describe("A Consolidation reply cut off at the token limit, at every character", () => {
  it.each(LAYOUTS)("$name: keeps exactly the entries written out in full before the cut, and says the change being written was lost", ({ reply, entry }) => {
    const text = reply();
    const whole = parseConsolidationReply({ text, cutOff: false });
    expect(whole.candidates).toHaveLength(ENTRIES.length);
    expect(whole.dropped).toEqual([]);

    // Where each entry ends in the reply, and where the array closes.
    let from = 0;
    const ends = ENTRIES.map((e) => {
      const start = text.indexOf(entry(e), from);
      expect(start).toBeGreaterThan(0);
      from = start + entry(e).length;
      return from;
    });
    const arrayClosed = text.lastIndexOf("]") + 1;

    for (let cut = 0; cut <= text.length; cut++) {
      const at = text.slice(0, cut);
      const read = parseConsolidationReply({ text: at, cutOff: true });
      const complete = ends.filter((end) => end <= cut).length;
      expect(read.candidates, `cut at ${cut}: ${JSON.stringify(at.slice(-20))}`).toEqual(whole.candidates.slice(0, complete));
      const lost = at.trim() !== "" && cut < arrayClosed;
      expect(read.dropped, `cut at ${cut}: ${JSON.stringify(at.slice(-20))}`).toEqual(lost ? [{ problem: expect.stringContaining("token limit") }] : []);
    }
  });
});
