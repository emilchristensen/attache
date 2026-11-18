import { describe, expect, it } from "vitest";
import type { AttentionItemView } from "@attache/contracts";
import { receiptStands, type DecidedEntry } from "../src/views/inbox-list.ts";

// A decided row's receipt ("Dismissed: ...", with Undo) stands in the row's place until the service answers with the
// item open again: after Undo, a snooze that ran out, or evidence that changed after a dismissal.

const item = (id: string) => ({ id, state: "open" }) as AttentionItemView;
const entry = (since: readonly AttentionItemView[] | null): DecidedEntry => ({ item: item("a"), decision: "dismiss", until: null, since });

describe("a decided row's receipt", () => {
  it("stands while the answer it was decided on is still the latest", () => {
    const answer = [item("a"), item("b")];
    expect(receiptStands(entry(answer), answer)).toBe(true);
  });

  it("stands while newer answers leave the item out", () => {
    expect(receiptStands(entry([item("a")]), [item("b")])).toBe(true);
  });

  it("gives way when a newer answer has the item open again (Undo, a snooze that ran out, changed evidence)", () => {
    expect(receiptStands(entry([item("a")]), [item("b")]) && receiptStands(entry([item("a")]), [item("a"), item("b")])).toBe(false);
    expect(receiptStands(entry(null), [item("a")])).toBe(false);
  });
});
