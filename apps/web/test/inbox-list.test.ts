import { describe, expect, it } from "vitest";
import type { AttentionItemView } from "@attache/contracts";
import { receiptStands, type DecidedEntry } from "../src/views/inbox-list.ts";

// A decided row's receipt ("Dismissed: ...", with Undo) stands in the row's place until the service answers, to a
// request asked after the decision succeeded, with the item again: after Undo, a snooze that ran out, or evidence
// that changed after a dismissal.

const item = (id: string) => ({ id, state: "open" }) as AttentionItemView;
/** Decided when the clock read 100. */
const entry: DecidedEntry = { item: item("a"), decision: "dismiss", until: null, decidedAt: 100 };

describe("a decided row's receipt", () => {
  it("stands against an answer asked before the decision succeeded, even one that still has the item", () => {
    expect(receiptStands(entry, { items: [item("a"), item("b")], askedAt: 99 })).toBe(true);
    expect(receiptStands(entry, { items: [item("a")], askedAt: null })).toBe(true);
  });

  it("stands while answers asked after it leave the item out", () => {
    expect(receiptStands(entry, { items: [item("b")], askedAt: 101 })).toBe(true);
  });

  it("gives way when an answer asked after it has the item again (Undo, a snooze that ran out, changed evidence)", () => {
    expect(receiptStands(entry, { items: [item("a"), item("b")], askedAt: 101 })).toBe(false);
  });
});
