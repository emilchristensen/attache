import { describe, expect, it } from "vitest";
import { stateTone } from "../src/components/state-tone.ts";

describe("stateTone", () => {
  it.each(["ready", "connected", "complete", "empty", "succeeded", "ok", "applied", "open"])("shows the healthy state %s as plain text, never a tag", (state) => {
    expect(stateTone(state)).toBe("plain");
  });

  it.each(["partial", "needs_setup", "needs_auth", "blocked", "revoked", "unknown"])("shows %s, which the owner can fix or which was partly read, as an amber tag", (state) => {
    expect(stateTone(state)).toBe("warning");
  });

  it.each(["queued", "running", "draft", "approved", "snoozed", "proposed", "executing", "never_run"])("shows %s, which is underway or not known yet, as a neutral tag", (state) => {
    expect(stateTone(state)).toBe("neutral");
  });

  it.each(["error", "failed", "unavailable", "denied", "unauthorized", "offline", "expired", "rejected"])("shows %s as a red tag", (state) => {
    expect(stateTone(state)).toBe("danger");
  });

  it("shows a state it does not know as a neutral tag", () => {
    expect(stateTone("something_new")).toBe("neutral");
  });
});
