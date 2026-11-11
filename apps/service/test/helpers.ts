import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export function tempDir(prefix = "jarvis-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The access-control entries of a file on Windows, as `icacls` prints them: `DOMAIN\name:(I)(F)`. */
function windowsAcl(path: string): string[] {
  const out = execFileSync("icacls", [path], { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((line, i) => (i === 0 ? line.slice(path.length) : line).trim())
    .filter((line) => line.includes(":("));
}

/**
 * A file's permissions in a form two files can be compared by: the mode bits
 * on macOS and Linux, the access-control list on Windows, which has no mode
 * bits (Node reports 0o666 for every writable file there).
 */
export function permissions(path: string): string {
  return process.platform === "win32" ? windowsAcl(path).join("\n") : (statSync(path).mode & 0o777).toString(8);
}

/** Accounts that can read every file on Windows anyway. */
const WINDOWS_PRIVILEGED = new Set(["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"]);

/**
 * Who besides the owner can access a file: group and other mode bits on macOS
 * and Linux, an access-control entry for any other account on Windows. Empty
 * when the file is private to the user.
 */
export function accessOutsideOwner(path: string): string[] {
  if (process.platform !== "win32") {
    const bits = statSync(path).mode & 0o077;
    return bits ? [`group and other mode bits ${bits.toString(8)}`] : [];
  }
  const me = userInfo().username.toLowerCase();
  return windowsAcl(path).filter((entry) => {
    const who = entry.slice(0, entry.indexOf(":("));
    return !WINDOWS_PRIVILEGED.has(who) && who.toLowerCase().split("\\").at(-1) !== me;
  });
}
