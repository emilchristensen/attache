import { describe, expect, it } from "vitest";
import { renderMemoryDoc, type StateEntryInput } from "../src/memory/markdown.ts";
import { defaultSeams, mergeByRules, type MachineRef, type MergeInput, type MergeRule } from "../src/replication/seams.ts";

/**
 * The note merge rule through the merge-rule seam Replication calls. Two
 * Machines can merge the same pair of versions at once (both fetched before
 * either pushed); they must write the same note, or they would never agree.
 */

const MAC: MachineRef = { id: "0b5f3c1e-0000-4000-8000-000000000001", name: "Mac" };
const PC: MachineRef = { id: "f3a9e2d4-0000-4000-8000-000000000002", name: "PC" };
const NOW = new Date("2026-11-20T12:00:00Z");

function note(opts: { id: string; updated: string; state: StateEntryInput[]; history: string[]; tags?: string[] }): string {
  return renderMemoryDoc({
    frontmatter: { id: opts.id, type: "project", title: "Orion migration", created: "2026-11-01", updated: opts.updated, ...(opts.tags ? { tags: opts.tags } : {}) },
    title: "Orion migration",
    state: opts.state,
    history: opts.history,
  });
}

/** All of Replication's merge rules, tried in their order, as one rule. */
const rule = (): MergeRule => {
  const rules = defaultSeams().mergeRules;
  return { name: "replication", appliesTo: () => true, merge: (input) => mergeByRules(rules, input) };
};

/** The same merge as each Machine runs it: its own version is `ours`. */
function onEachMachine(base: string | null, mac: string, pc: string): [string | null, string | null] {
  const input = (ours: string, theirs: string, local: MachineRef, remote: MachineRef): MergeInput => ({ path: "memory/projects/orion-migration.md", base, ours, theirs, local, remote, now: NOW });
  return [rule().merge(input(mac, pc, MAC, PC))?.content ?? null, rule().merge(input(pc, mac, PC, MAC))?.content ?? null];
}

const created = "- 2026-11-01 — created by user";

describe("note merge rule on either Machine", () => {
  it("writes the same note for the same date on both sides", () => {
    const base = note({ id: "a", updated: "2026-11-01", state: [{ subject: "Status", date: "2026-11-01", value: "Planned" }, { subject: "Owner", date: "2026-11-01", value: "Ada" }], history: [created] });
    const mac = note({ id: "a", updated: "2026-11-10", state: [{ subject: "Status", date: "2026-11-10", value: "From the Mac", review: "2026-12-01" }, { subject: "Owner", date: "2026-11-01", value: "Ada" }], history: [created, "- 2026-11-10 — Mac event"], tags: ["mac"] });
    const pc = note({ id: "a", updated: "2026-11-10", state: [{ subject: "Status", date: "2026-11-10", value: "From the PC" }, { subject: "Owner", date: "2026-11-10", value: "Grace" }], history: [created, "- 2026-11-09 — PC event"], tags: ["pc"] });
    const [onMac, onPc] = onEachMachine(base, mac, pc);
    expect(onMac).not.toBeNull();
    expect(onMac).toBe(onPc);
    // The PC's id sorts last, so it wins the tie; History is in date order.
    expect(onMac).toContain("- **Status** (2026-11-10): From the PC");
    expect(onMac).toContain('- 2026-11-10 — **Status** was "From the Mac" (dated 2026-11-10, review 2026-12-01); superseded:');
    expect(onMac).toContain("- **Owner** (2026-11-10): Grace");
    expect(onMac!.indexOf("PC event")).toBeLessThan(onMac!.indexOf("Mac event"));
    expect(onMac).toMatch(/tags:\n {2}- mac\n {2}- pc/);
  });

  it("writes the same note for two notes created apart with the same type and title", () => {
    const mac = note({ id: "id-from-mac", updated: "2026-11-10", state: [{ subject: "Status", date: "2026-11-10", value: "Scoping" }], history: ["- 2026-11-10 — created by user"] });
    const pc = note({ id: "id-from-pc", updated: "2026-11-11", state: [{ subject: "Budget", date: "2026-11-11", value: "Ten days" }], history: ["- 2026-11-11 — created by user"] });
    const [onMac, onPc] = onEachMachine(null, mac, pc);
    expect(onMac).toBe(onPc);
    expect(onMac).toContain("id: id-from-pc");
    expect(onMac).toContain("created: 2026-11-01");
    expect(onMac).toContain("updated: 2026-11-11");
    expect(onMac).toContain("- **Status** (2026-11-10): Scoping\n- **Budget** (2026-11-11): Ten days");
    expect(onMac).toContain("## History\n<!-- Append-only. Never edited. -->\n- 2026-11-10 — created by user\n- 2026-11-11 — created by user\n");
  });

  it("leaves a note whose prose both Machines changed for the prose merge, without conflict markers", () => {
    const base = note({ id: "a", updated: "2026-11-01", state: [{ subject: "Status", date: "2026-11-01", value: "Planned" }], history: [created] });
    const withNotes = (text: string) => base.replace("## History", `## Notes\n${text}\n\n## History`);
    const [onMac, onPc] = onEachMachine(base, withNotes("Written on the Mac."), withNotes("Written on the PC."));
    expect(onMac).toBeNull();
    expect(onPc).toBeNull();
  });

  it("keeps a note one Machine changed and the other deleted", () => {
    const base = note({ id: "a", updated: "2026-11-01", state: [{ subject: "Status", date: "2026-11-01", value: "Planned" }], history: [created] });
    const changed = note({ id: "a", updated: "2026-11-02", state: [{ subject: "Status", date: "2026-11-02", value: "Started" }], history: [created] });
    const input: MergeInput = { path: "memory/projects/orion-migration.md", base, ours: null, theirs: changed, local: MAC, remote: PC, now: NOW };
    const outcome = rule().merge(input);
    expect(outcome?.content).toBe(changed);
    expect(outcome?.notices?.map((n) => n.kind)).toEqual(["deleted_and_changed"]);
  });
});
