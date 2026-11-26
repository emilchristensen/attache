import { describe, expect, it } from "vitest";
import { GO_TO, GO_TO_LIMIT, goToMatches } from "../src/palette.ts";
import { screenAt, settingsSectionAt } from "../src/routes.ts";

const hrefs = (entries: readonly { href: string }[]) => entries.map((e) => e.href);

describe("the palette's Go to group", () => {
  it("lists every screen, then every Settings section, each at its own address", () => {
    expect(GO_TO.map((e) => `${e.label} ${e.href}`)).toEqual([
      "Home /",
      "Approvals /approvals",
      "Brain /brain",
      "Connections /connections",
      "Jobs /jobs",
      "Settings /settings",
      "Features /settings/features",
      "Schedules and notifications /settings/schedules",
      "Identity /settings/identity",
      "Saving and review /settings/saving",
      "Meaning-based search /settings/meaning-search",
      "Backup and export /settings/backup",
      "Machines and Replication /settings/machines",
      "Paired clients /settings/clients",
      "Service health /settings/service",
      "Updates /settings/updates",
    ]);
  });

  it("opens each Settings section on the Settings screen, and knows which section an address names", () => {
    for (const e of GO_TO.filter((g) => g.kind === "section")) {
      expect(screenAt(e.href)).toBe("settings");
      expect(settingsSectionAt(e.href)).toBe(e.href.slice("/settings/".length));
    }
    expect(settingsSectionAt("/settings")).toBeNull();
    expect(settingsSectionAt("/settings/nothing-here")).toBeNull();
    expect(settingsSectionAt("/brain")).toBeNull();
  });

  it("shows everything before the owner types", () => {
    expect(goToMatches("")).toEqual(GO_TO);
    expect(goToMatches("   ")).toEqual(GO_TO);
  });

  it("matches the start of any word in a place's name, ignoring case", () => {
    expect(hrefs(goToMatches("conn"))).toEqual(["/connections"]);
    expect(hrefs(goToMatches("REPL"))).toEqual(["/settings/machines"]);
    expect(hrefs(goToMatches("health"))).toEqual(["/settings/service"]);
  });

  it("does not match inside a word", () => {
    expect(goToMatches("ome")).toEqual([]);
    expect(goToMatches("nora")).toEqual([]);
  });

  it("takes every word the owner types, and lets a section be found under Settings or its group", () => {
    expect(hrefs(goToMatches("settings ident"))).toEqual(["/settings/identity"]);
    expect(hrefs(goToMatches("brain backup"))).toEqual(["/settings/backup"]);
    expect(hrefs(goToMatches("meaning search"))).toEqual(["/settings/meaning-search"]);
  });

  it("puts a place whose own name matches before one found only under Settings, and keeps a short list", () => {
    // "Settings" matches the screen by name and every section through it; the screen comes first.
    const settings = goToMatches("settings");
    expect(settings[0]!.href).toBe("/settings");
    expect(settings).toHaveLength(GO_TO_LIMIT);
    // "b" starts Brain, Meaning-based and Backup by name; Saving and review is found through its group, Brain.
    expect(hrefs(goToMatches("b"))).toEqual(["/brain", "/settings/meaning-search", "/settings/backup", "/settings/saving"]);
  });
});
