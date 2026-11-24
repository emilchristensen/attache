import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHarnessExecutable } from "./integration/harness-executable.ts";

/**
 * The real-executable smoke tests run a Harness in a temporary home, where a version manager's shim
 * cannot find the owner's installs; they must be handed the executable the shim runs.
 * The version managers here are stand-ins that answer `which <command>` the way mise and asdf do.
 */
describe.skipIf(process.platform === "win32")("finding a Harness executable for a smoke test", () => {
  let root: string;
  let real: string;

  const script = (path: string, body: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  /** A version manager that names `real` for `which opencode` and knows no other tool. */
  const manager = (path: string) => script(path, `[ "$1 $2" = "which opencode" ] && echo "${real}" && exit 0\necho "no such tool: $2" >&2\nexit 1`);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "attache-harness-executable-"));
    real = join(root, "installs", "opencode", "bin", "opencode");
    script(real, "echo opencode");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("takes the first executable on PATH as it is when it is no shim", () => {
    expect(findHarnessExecutable("opencode", "ATTACHE_TEST_EXECUTABLE", { PATH: join(root, "installs", "opencode", "bin") })).toBe(real);
  });

  it("resolves a mise shim, a link to the mise executable, to the executable it runs", () => {
    manager(join(root, "bin", "mise"));
    mkdirSync(join(root, "mise", "shims"), { recursive: true });
    symlinkSync(join(root, "bin", "mise"), join(root, "mise", "shims", "opencode"));
    expect(findHarnessExecutable("opencode", "ATTACHE_TEST_EXECUTABLE", { PATH: join(root, "mise", "shims") })).toBe(real);
  });

  it("resolves an asdf shim, a script that runs `asdf exec`, to the executable it runs", () => {
    manager(join(root, "asdf", "bin", "asdf"));
    script(join(root, "asdf", "shims", "opencode"), `# asdf-plugin: opencode 2.4.1\nexec ${join(root, "asdf", "bin", "asdf")} exec "opencode" "$@"`);
    expect(findHarnessExecutable("opencode", "ATTACHE_TEST_EXECUTABLE", { PATH: join(root, "asdf", "shims") })).toBe(real);
  });

  it("resolves a shim named in the override variable too", () => {
    manager(join(root, "bin", "mise"));
    mkdirSync(join(root, "mise", "shims"), { recursive: true });
    symlinkSync(join(root, "bin", "mise"), join(root, "mise", "shims", "opencode"));
    expect(findHarnessExecutable("opencode", "ATTACHE_TEST_EXECUTABLE", { PATH: "", ATTACHE_TEST_EXECUTABLE: join(root, "mise", "shims", "opencode") })).toBe(real);
  });

  it("says what to do when the version manager cannot name the executable", () => {
    manager(join(root, "bin", "mise"));
    mkdirSync(join(root, "mise", "shims"), { recursive: true });
    symlinkSync(join(root, "bin", "mise"), join(root, "mise", "shims", "pi"));
    expect(() => findHarnessExecutable("pi", "ATTACHE_PI_EXECUTABLE", { PATH: join(root, "mise", "shims") })).toThrow(
      /is a mise shim, and `mise which pi` did not name the executable it runs \(no such tool: pi\)\. Install pi with mise, or name the executable in ATTACHE_PI_EXECUTABLE\./,
    );
  });

  it("finds nothing when the command is neither named nor on PATH", () => {
    expect(findHarnessExecutable("opencode", "ATTACHE_TEST_EXECUTABLE", { PATH: join(root, "empty") })).toBeNull();
  });
});
