import { describe, expect, it } from "vitest";
import { gitCandidates } from "../src/platform/git-install.ts";

describe("where Replication looks for git", () => {
  it("finds Git for Windows where its installer puts it, for everyone or for one user, after the usual tool folders", () => {
    const env = { USERPROFILE: "C:\\Users\\owner", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local", APPDATA: "C:\\Users\\owner\\AppData\\Roaming", ProgramFiles: "D:\\Programs" };
    expect(gitCandidates("windows", env)).toEqual([
      "C:\\Users\\owner\\.local\\bin\\git.exe",
      "C:\\Users\\owner\\.local\\bin\\git.cmd",
      "C:\\Users\\owner\\AppData\\Roaming\\npm\\git.exe",
      "C:\\Users\\owner\\AppData\\Roaming\\npm\\git.cmd",
      "D:\\Programs\\Git\\cmd\\git.exe",
      "C:\\Users\\owner\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
    ]);
  });

  it("looks in the usual tool folders on macOS and Linux", () => {
    expect(gitCandidates("macos", { HOME: "/Users/owner" })).toEqual(["/Users/owner/.local/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]);
    expect(gitCandidates("linux", { HOME: "/home/owner" })).toEqual(["/home/owner/.local/bin/git", "/usr/local/bin/git", "/usr/bin/git"]);
  });
});
