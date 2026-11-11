import { describe, expect, it } from "vitest";
import { renderMemoryDoc, type StateEntryInput } from "../src/memory/markdown.ts";
import { defaultSeams, mergeByRules, type MachineRef, type MergeInput, type MergeOutcome } from "../src/replication/seams.ts";

/**
 * The prose merge through the merge-rule seam Replication calls, for the
 * shapes of change the integration tests do not reach cheaply. Both Machines
 * can merge the same two versions; they must write the same note.
 */

const MAC: MachineRef = { id: "0b5f3c1e-0000-4000-8000-000000000001", name: "Mac" };
const PC: MachineRef = { id: "f3a9e2d4-0000-4000-8000-000000000002", name: "PC" };
const NOW = new Date("2026-11-20T12:00:00Z");
const PATH = "memory/projects/orion-migration.md";
const STATUS: StateEntryInput = { subject: "Status", date: "2026-11-01", value: "Planned" };

function note(notes: string, state: StateEntryInput[] = [STATUS], history = ["- 2026-11-01 — created by user"]): string {
  return renderMemoryDoc({ frontmatter: { id: "a", type: "project", title: "Orion migration", created: "2026-11-01", updated: "2026-11-01" }, title: "Orion migration", state, notes, history });
}

/** The same merge as each Machine runs it; fails unless both write the same outcome. */
function merge(base: string | null, mac: string, pc: string, machines: [MachineRef, MachineRef] = [MAC, PC]): MergeOutcome {
  const rules = defaultSeams().mergeRules;
  const input = (ours: string, theirs: string, local: MachineRef, remote: MachineRef): MergeInput => ({ path: PATH, base, ours, theirs, local, remote, now: NOW });
  const onMac = mergeByRules(rules, input(mac, pc, machines[0], machines[1]));
  const onPc = mergeByRules(rules, input(pc, mac, machines[1], machines[0]));
  expect(onMac).not.toBeNull();
  expect(onPc).toEqual(onMac);
  expect(onMac!.content).not.toMatch(/^(<{7}|={7}|>{7})/m);
  return onMac!;
}

const notesOf = (text: string) => text.slice(text.indexOf("## Notes\n") + "## Notes\n".length, text.indexOf("\n\n## History"));

describe("prose merge on either Machine", () => {
  it("merges changes to neighbouring lines, and lines added in different places, without any marker or notice", () => {
    const base = note("One.\nTwo.\nThree.\nFour.");
    const outcome = merge(base, note("One from Mac.\nTwo.\nThree.\nFour.\nFive from Mac."), note("One.\nTwo from PC.\nThree.\nFour."));
    expect(notesOf(outcome.content!)).toBe("One from Mac.\nTwo from PC.\nThree.\nFour.\nFive from Mac.");
    expect(outcome.notices).toBeUndefined();
  });

  it("takes the same change made on both Machines once", () => {
    const outcome = merge(note("One.\nTwo."), note("One.\nTwo, agreed."), note("One.\nTwo, agreed."));
    expect(notesOf(outcome.content!)).toBe("One.\nTwo, agreed.");
    expect(outcome.notices).toBeUndefined();
  });

  it("keeps both versions of the same lines, in Machine id order, with one notice naming the note", () => {
    const outcome = merge(note("One.\nTwo.\nThree."), note("One.\nTwo from Mac.\nThree."), note("One.\nTwo from PC.\nThree."));
    expect(notesOf(outcome.content!)).toBe("One.\n\n### Version from Mac\n\nTwo from Mac.\n\n### Version from PC\n\nTwo from PC.\n\nThree.");
    expect(outcome.notices).toEqual([expect.objectContaining({ path: PATH, kind: "prose_versions", perPath: true, title: 'Two versions kept in "Orion migration"' })]);
    expect(outcome.notices![0]!.message).toContain("Mac and PC changed the same lines");
  });

  it("keeps both lines two Machines added at the same place, as two versions", () => {
    const outcome = merge(note("One."), note("One.\nAdded on the Mac."), note("One.\nAdded on the PC."));
    expect(notesOf(outcome.content!)).toBe("One.\n\n### Version from Mac\n\nAdded on the Mac.\n\n### Version from PC\n\nAdded on the PC.");
  });

  it("says which Machine's version has nothing where it removed the lines the other changed", () => {
    const outcome = merge(note("One.\nTwo.\nThree."), note("One.\nThree."), note("One.\nTwo from PC.\nThree."));
    expect(notesOf(outcome.content!)).toBe("One.\n\n### Version from Mac\n\n_Mac's version has nothing here._\n\n### Version from PC\n\nTwo from PC.\n\nThree.");
  });

  it("tells two Machines with the same name apart by their id", () => {
    const twin: MachineRef = { id: "f3a9e2d4-0000-4000-8000-000000000002", name: "Mac" };
    const outcome = merge(note("One."), note("From the first."), note("From the second."), [MAC, twin]);
    expect(outcome.content).toContain("### Version from Mac (0b5f3c1e)\n\nFrom the first.");
    expect(outcome.content).toContain("### Version from Mac (f3a9e2d4)\n\nFrom the second.");
  });

  it("puts the versions one level below the section they are in", () => {
    const base = note("Intro.\n\n### Risks\nVendor delay.");
    const outcome = merge(base, note("Intro.\n\n### Risks\nVendor delay of a week."), note("Intro.\n\n### Risks\nVendor delay of a month."));
    expect(outcome.content).toContain("### Risks\n\n#### Version from Mac\n\nVendor delay of a week.\n\n#### Version from PC\n\nVendor delay of a month.");
  });

  it("merges prose and facts together, keeping the facts outside both versions", () => {
    const base = note("One.");
    const mac = note("From the Mac.", [{ subject: "Status", date: "2026-11-02", value: "Started" }]);
    const pc = note("From the PC.", [STATUS, { subject: "Owner", date: "2026-11-02", value: "Ada" }]);
    const text = merge(base, mac, pc).content!;
    expect(text).toContain("- **Status** (2026-11-02): Started\n- **Owner** (2026-11-02): Ada\n\n## Notes\n");
    expect(notesOf(text)).toBe("\n### Version from Mac\n\nFrom the Mac.\n\n### Version from PC\n\nFrom the PC.");
  });

  it("merges two notes created apart: prose only one has is kept, different prose in the same place becomes two versions", () => {
    const mac = note("Shared first line.\nOnly on the Mac.");
    const pc = note("Shared first line.\nOnly on the PC.");
    const text = merge(null, mac, pc).content!;
    expect(text.match(/^# Orion migration$/gm)).toHaveLength(1);
    expect(notesOf(text)).toBe("Shared first line.\n\n### Version from Mac\n\nOnly on the Mac.\n\n### Version from PC\n\nOnly on the PC.");
  });
});
