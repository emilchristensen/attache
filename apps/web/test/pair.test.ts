import { describe, expect, it } from "vitest";
import { pairFailure } from "../src/pair.ts";

const E = { message: "down" };
const before = { message: "earlier" };

describe("pairFailure", () => {
  it.each<[string, typeof E | null, { loading: boolean; error: typeof E | null }, boolean, typeof E | null]>([
    ["a failure shows at once, while the other list is still asked", null, { loading: false, error: E }, false, E],
    ["it stays while its Retry is under way", E, { loading: true, error: E }, false, E],
    ["it stays when the Retry answers before the other list: no stale pair stands in for it", E, { loading: false, error: null }, false, E],
    ["it ends once the pair has settled with a good answer", E, { loading: false, error: null }, true, null],
    ["a newer failure replaces an older one", before, { loading: false, error: E }, false, E],
    ["nothing failed", null, { loading: true, error: null }, false, null],
  ])("%s", (_, previous, own, pairSettled, expected) => {
    expect(pairFailure(previous, own, pairSettled)).toBe(expected);
  });
});
