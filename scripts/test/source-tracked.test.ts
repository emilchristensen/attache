// Every source file can be committed: an ignore rule meant for build output once matched apps/service/src/release/
// as well as the repository's own release/ folder, so a checkout built from git lacked the release modules (3e95816).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_DIRS = ["apps/service/src", "apps/web/src", "packages/contracts/src", "installer", "scripts", "tests/e2e"];

/** What the operating system leaves in a folder, which no source tree holds. */
const OS_LEFTOVERS = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Every file under `dir`, relative to the repository, leaving out dependencies and the operating system's leftovers. */
function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || OS_LEFTOVERS.has(e.name)) return [];
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? files(rel) : [rel];
  });
}

describe("source files", () => {
  it("are matched by no ignore rule, so git commits every one of them", () => {
    const all = SOURCE_DIRS.flatMap(files);
    expect(all.length).toBeGreaterThan(100);
    let ignored = "";
    try {
      // --no-index: ask the rules themselves, also for files git already tracks. Exit 1 means none matched.
      ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: ROOT, input: all.join("\n"), encoding: "utf8" });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(ignored.split("\n").filter(Boolean)).toEqual([]);
  });
});
