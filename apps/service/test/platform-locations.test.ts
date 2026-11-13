/** Path wording that differs per operating system, checked for every one on any host. */
import { describe, expect, it } from "vitest";
import { folderName } from "../src/platform/locations.ts";

describe("folderName", () => {
  it("names a Windows folder after its last part, with either separator and a trailing one", () => {
    expect(folderName("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\jarvis-e2e æøå-7ss1F1\\vault", "windows")).toBe("vault");
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
