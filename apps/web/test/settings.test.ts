import { describe, expect, it } from "vitest";
import type { FeatureStatus, ReadinessState } from "@attache/contracts";
import { settingsGroups, settingsSectionShown } from "../src/routes.ts";
import { featureProblem } from "../src/feature-problem.ts";

describe("the Settings section list", () => {
  it("has four groups, in order, with their sections in order", () => {
    expect(settingsGroups().map((g) => [g.group, g.sections.map((s) => s.label)])).toEqual([
      ["Attache", ["Features", "Schedules and notifications", "Identity"]],
      ["Brain", ["Saving and review", "Meaning-based search", "Backup and export"]],
      ["Machines", ["Machines and Replication", "Paired clients"]],
      ["Service", ["Service health", "Updates"]],
    ]);
  });

  it("shows the first section at Settings itself, the named section below it, and nothing for an unknown one", () => {
    expect(settingsSectionShown("/settings")).toBe("features");
    expect(settingsSectionShown("/settings/identity")).toBe("identity");
    expect(settingsSectionShown("/settings/machines")).toBe("machines");
    expect(settingsSectionShown("/settings/nothing-here")).toBeNull();
    expect(settingsSectionShown("/settings/identity/more")).toBeNull();
  });
});

const feature = (readiness: ReadinessState, over: Partial<FeatureStatus> = {}): FeatureStatus => ({
  id: "attention",
  label: "Attention and briefings",
  description: "Watches your sources.",
  core: false,
  enabled: true,
  readiness,
  reason: null,
  dependsOn: { features: [], connections: [] },
  schedules: [],
  ...over,
});

describe("a feature switch's problem state", () => {
  it("is nothing for a ready feature, even with a reason", () => {
    expect(featureProblem(feature("ready", { reason: "Reads GitHub and Slack." }))).toBeNull();
  });

  it("is nothing for a feature that is off: the switch already says so", () => {
    expect(featureProblem(feature("disabled", { enabled: false }))).toBeNull();
    expect(featureProblem(feature("needs_setup", { enabled: false, reason: "Connect a source." }))).toBeNull();
  });

  it("names each problem of a feature that is on, with its reason", () => {
    expect(featureProblem(feature("needs_setup", { reason: "Connect at least one source." }))).toEqual({ state: "needs_setup", words: "needs setup", reason: "Connect at least one source." });
    expect(featureProblem(feature("partial", { reason: "Slack needs sign-in." }))).toEqual({ state: "partial", words: "partly working", reason: "Slack needs sign-in." });
    expect(featureProblem(feature("unavailable", { reason: "No model is set up." }))).toEqual({ state: "unavailable", words: "unavailable", reason: "No model is set up." });
  });

  it("keeps a problem the service gave no reason for", () => {
    expect(featureProblem(feature("needs_setup"))).toEqual({ state: "needs_setup", words: "needs setup", reason: null });
  });
});
