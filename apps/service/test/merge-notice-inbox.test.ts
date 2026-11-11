import { describe, expect, it } from "vitest";
import type { CandidateWithSource } from "../src/attention/engine.ts";
import { deletedAndChangedRule } from "../src/replication/deleted-and-changed.ts";
import { raiseMergeNotices, type MergeNoticeInbox } from "../src/replication/merge-notice-inbox.ts";
import type { MergeNotice } from "../src/replication/seams.ts";

/** An inbox that only records what it was asked to raise. */
function recordingInbox(): MergeNoticeInbox & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    apply: (_source, candidates: CandidateWithSource[]) => {
      const raised = candidates.map((c) => c.key);
      keys.push(...raised);
      return { created: raised, changed: [], unchanged: [], resolved: [], keptDismissed: [], reopened: [], touched: raised };
    },
  };
}

const NOTE = "memory/projects/tui-nesting.md";
const kept = (status: string) => `---\ntype: project\ntitle: Tui nesting\n---\n# Tui nesting\n\n## Current State\n\n- **Status** (2026-11-11): ${status}\n`;

/** The notices the deleted-and-changed rule raises when `machine` merged a note deleted on one side and changed on the other. */
function noticesOf(machine: string, status: string): readonly MergeNotice[] {
  const local = { id: null, name: machine };
  const remote = { id: null, name: machine === "Mac" ? "PC" : "Mac" };
  const out = deletedAndChangedRule.merge({ path: NOTE, base: kept("Nests found"), ours: null, theirs: kept(status), local, remote } as never);
  return out!.notices!;
}

describe("the inbox item a merge raises", () => {
  it("is the same item when two Machines merge the same deleted-and-changed note at different times", () => {
    const inbox = recordingInbox();
    raiseMergeNotices(inbox, noticesOf("Mac", "Chicks hatched"), new Date("2026-11-11T10:00:00Z"));
    raiseMergeNotices(inbox, noticesOf("Mac", "Chicks hatched"), new Date("2026-11-11T10:05:00Z"));
    expect(new Set(inbox.keys).size).toBe(1);
  });

  it("is a new item when a later merge kept a different version of the note", () => {
    const inbox = recordingInbox();
    raiseMergeNotices(inbox, noticesOf("Mac", "Chicks hatched"), new Date("2026-11-11T10:00:00Z"));
    raiseMergeNotices(inbox, noticesOf("Mac", "Chicks fledged"), new Date("2026-11-12T10:00:00Z"));
    expect(new Set(inbox.keys).size).toBe(2);
  });
});
