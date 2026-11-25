import { describe, expect, it } from "vitest";
import { homeAreaOrder } from "../src/home-arrangement.ts";

describe("Home's area order", () => {
  it.each([
    [false, ["your-day", "for-you-now", "inbox"]],
    [true, ["for-you-now", "your-day", "inbox"]],
  ] as const)("phone %s puts the areas in the document as drawn", (phone, order) => {
    expect(homeAreaOrder(phone)).toEqual(order);
  });
});
