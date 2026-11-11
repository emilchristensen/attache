import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, minimumNode } from "../node-minimum.mjs";
import { BUNDLED_NODE_VERSION } from "../release-targets.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

describe("minimumNode", () => {
  it("reads the lowest supported version from an engines range", () => {
    expect(minimumNode(">=24.22.0")).toBe("24.22.0");
    expect(minimumNode(" >= 26.1.3 ")).toBe("26.1.3");
  });

  it("refuses a range it cannot turn into one version", () => {
    expect(() => minimumNode("^24.22.0")).toThrow(/>=X.Y.Z/);
    expect(() => minimumNode(">=24")).toThrow(/>=X.Y.Z/);
    expect(() => minimumNode(undefined)).toThrow(/>=X.Y.Z/);
  });
});

describe("the Node versions this repository names", () => {
  it("bundles a Node in the release that development supports too", () => {
    const engines = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node;
    expect(compareVersions(BUNDLED_NODE_VERSION, minimumNode(engines))).toBeGreaterThanOrEqual(0);
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch, as numbers", () => {
    expect(compareVersions("24.22.2", "24.22.0")).toBeGreaterThan(0);
    expect(compareVersions("24.9.0", "24.22.0")).toBeLessThan(0);
    expect(compareVersions("26.0.0", "24.22.0")).toBeGreaterThan(0);
    expect(compareVersions("24.22.0", "24.22.0")).toBe(0);
  });
});
