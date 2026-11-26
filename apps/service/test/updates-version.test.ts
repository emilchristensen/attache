import { describe, expect, it } from "vitest";
import { isNewerVersion, parseVersion } from "../src/updates/version.ts";

describe("version ordering", () => {
  // Each pair is [older, newer], from the semantic versioning precedence rules.
  it.each([
    ["0.6.0", "0.6.1"],
    ["0.6.9", "0.7.0"],
    ["0.9.0", "0.10.0"],
    ["0.10.0", "1.0.0"],
    ["0.7.0-beta.1", "0.7.0"],
    ["0.7.0-beta.1", "0.7.0-beta.2"],
    ["0.7.0-beta.2", "0.7.0-beta.10"],
    ["0.7.0-alpha", "0.7.0-beta"],
    ["0.7.0-beta", "0.7.0-beta.1"],
    ["0.7.0-1", "0.7.0-beta"],
    ["0.6.0", "0.7.0-beta.1"],
  ])("%s is older than %s", (older, newer) => {
    expect(isNewerVersion(newer, older)).toBe(true);
    expect(isNewerVersion(older, newer)).toBe(false);
  });

  it.each([
    ["0.6.0", "0.6.0"],
    ["0.7.0-beta.1", "0.7.0-beta.1"],
    ["0.6.0+build.5", "0.6.0"],
    ["v0.6.0", "0.6.0"],
  ])("%s ranks the same as %s", (a, b) => {
    expect(isNewerVersion(a, b)).toBe(false);
    expect(isNewerVersion(b, a)).toBe(false);
  });

  it.each(["", "test", "0.6", "0.6.0.1", "01.2.3", "0.6.0-", "0.6.0-beta..1", "1.0.0 beta"])("%j is not a version, so it is never newer or older", (text) => {
    expect(parseVersion(text)).toBeNull();
    expect(isNewerVersion(text, "0.0.1")).toBe(false);
    expect(isNewerVersion("999.0.0", text)).toBe(false);
  });
});
