// Whether the service runs from a release install, the only kind of copy that updates itself.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseInstallOf } from "../src/updates/release-install.ts";
import { tempDir } from "./helpers.ts";

/** An installation folder as `install.sh` and `install.ps1` leave it: `app/<version>/` and `current` pointing at it. */
function installed(version: string, opts: { current?: boolean } = {}): { prefix: string; script: string } {
  const prefix = tempDir("attache-prefix-");
  const app = join(prefix, "app", version);
  mkdirSync(join(app, "service"), { recursive: true });
  writeFileSync(join(app, "VERSION"), `${version}\n`);
  writeFileSync(join(app, "service", "attache-service.mjs"), "");
  // A junction on Windows, which needs no administrator; a symbolic link elsewhere.
  if (opts.current !== false) symlinkSync(app, join(prefix, "current"), "junction");
  return { prefix, script: join(prefix, "current", "service", "attache-service.mjs") };
}

describe("a release install", () => {
  it("is the installation folder the service script runs from, through current or app/<version>", () => {
    const { prefix, script } = installed("0.7.0");
    expect(releaseInstallOf(script, "0.7.0")).toEqual({ prefix: expect.stringMatching(/attache-prefix-/) });
    expect(releaseInstallOf(join(prefix, "app", "0.7.0", "service", "attache-service.mjs"), "0.7.0")).not.toBeNull();
  });

  it.each([
    ["a source checkout's TypeScript", (p: string) => join(p, "apps", "service", "src", "main.ts")],
    ["a development bundle", (p: string) => join(p, "apps", "service", "dist", "attache-service.mjs")],
  ])("is not %s", (_what, script) => {
    const { prefix } = installed("0.7.0");
    expect(releaseInstallOf(script(prefix), "0.7.0")).toBeNull();
    expect(releaseInstallOf(undefined, "0.7.0")).toBeNull();
  });

  it("is not a version folder whose VERSION names another version than the one running", () => {
    const { script } = installed("0.7.0");
    expect(releaseInstallOf(script, "0.8.0")).toBeNull();
  });

  it("is not an app folder without current beside it", () => {
    const { prefix } = installed("0.7.0", { current: false });
    expect(releaseInstallOf(join(prefix, "app", "0.7.0", "service", "attache-service.mjs"), "0.7.0")).toBeNull();
  });
});
