import { describe, expect, it } from "vitest";
import type { UpdateChannel } from "@attache/contracts";
import { eligibleVersions } from "../src/updates/channel.ts";

const RELEASES = ["0.5.0", "0.6.0", "0.6.1", "0.7.0-beta.1", "0.7.0-beta.2", "0.7.0", "0.8.0-beta.1"];

describe("which releases a Machine may take, newest first", () => {
  it.each<[string, UpdateChannel, string[], string[]]>([
    // [installed, channel, marked bad, eligible]
    ["0.6.0", "stable", [], ["0.7.0", "0.6.1"]],
    ["0.6.0", "beta", [], ["0.8.0-beta.1", "0.7.0", "0.7.0-beta.2", "0.7.0-beta.1", "0.6.1"]],
    // Beta takes a Stable release that passes it.
    ["0.7.0-beta.2", "beta", [], ["0.8.0-beta.1", "0.7.0"]],
    // Switched from Beta to Stable: stays put until Stable passes it.
    ["0.7.0-beta.2", "stable", [], ["0.7.0"]],
    ["0.8.0-beta.1", "stable", [], []],
    ["0.8.0-beta.1", "beta", [], []],
    // Never an older version, nor the same one.
    ["0.7.0", "stable", [], []],
    ["0.9.0", "beta", [], []],
    // A version that failed on this Machine is skipped; a newer one is still taken.
    ["0.6.0", "stable", ["0.7.0"], ["0.6.1"]],
    ["0.6.0", "beta", ["0.8.0-beta.1", "0.7.0"], ["0.7.0-beta.2", "0.7.0-beta.1", "0.6.1"]],
  ])("on %s following %s, with %j marked bad: %j", (installed, channel, bad, eligible) => {
    expect(eligibleVersions(RELEASES, { installed, channel, bad })).toEqual(eligible);
  });

  it("takes tags with a v in front, and ignores anything a release cannot carry", () => {
    expect(eligibleVersions(["v0.7.0", "0.7.1-rc.1", "latest", "0.7.2+build.1", "v0.8.0-beta.3"], { installed: "0.6.0", channel: "beta", bad: [] })).toEqual(["0.8.0-beta.3", "0.7.0"]);
  });

  it("lists each version once", () => {
    expect(eligibleVersions(["0.7.0", "v0.7.0"], { installed: "0.6.0", channel: "stable", bad: [] })).toEqual(["0.7.0"]);
  });
});
