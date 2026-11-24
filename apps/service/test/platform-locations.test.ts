/** Path wording that differs per operating system, checked for every one on any host. */
import { describe, expect, it } from "vitest";
import { delimiter } from "node:path";
import { folderName, platformLocations } from "../src/platform/locations.ts";
import { copilotCliInstall, harnessInstalls, openCodeInstall, piInstall } from "../src/platform/harness-locations.ts";

describe("folderName", () => {
  it("names a Windows folder after its last part, with either separator and a trailing one", () => {
    expect(folderName("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\attache-e2e æøå-7ss1F1\\vault", "windows")).toBe("vault");
    expect(folderName("C:\\Notes\\Work\\", "windows")).toBe("Work");
    expect(folderName("C:/Notes/Work", "windows")).toBe("Work");
    expect(folderName("\\\\server\\share\\Team notes", "windows")).toBe("Team notes");
  });

  it("names a macOS or Linux folder after its last part, keeping a backslash that is part of the name", () => {
    expect(folderName("/home/alex/Documents/Notes/", "linux")).toBe("Notes");
    expect(folderName("/Users/alex/Obsidian Vault", "macos")).toBe("Obsidian Vault");
    expect(folderName("/home/alex/odd\\name", "linux")).toBe("odd\\name");
  });

  it("is empty for a drive or filesystem root, which has no folder name", () => {
    expect(folderName("C:\\", "windows")).toBe("");
    expect(folderName("/", "linux")).toBe("");
  });
});

describe("where Attache looks for Harness executables", () => {
  it("looks only in ATTACHE_HARNESS_TOOL_DIRS when it is set, so tests never find the Machine's own Harnesses", () => {
    const loc = platformLocations("macos", { HOME: "/Users/ada" });
    const before = process.env.ATTACHE_HARNESS_TOOL_DIRS;
    process.env.ATTACHE_HARNESS_TOOL_DIRS = ["/tmp/e2e/bin", "/tmp/e2e/more"].join(delimiter);
    try {
      const all = [...Object.values(harnessInstalls(loc)).flatMap((h) => h.executables), ...piInstall(loc).executables, ...openCodeInstall(loc).executables, ...copilotCliInstall(loc).executables];
      expect(all.filter((p) => p.startsWith("/opt/homebrew") || p.startsWith("/usr/local"))).toEqual([]);
      expect(harnessInstalls(loc).codex.executables).toEqual(["/tmp/e2e/bin/codex", "/tmp/e2e/more/codex"]);
    } finally {
      if (before === undefined) delete process.env.ATTACHE_HARNESS_TOOL_DIRS;
      else process.env.ATTACHE_HARNESS_TOOL_DIRS = before;
    }
    expect(harnessInstalls(loc).codex.executables).toContain("/opt/homebrew/bin/codex");
  });
});
