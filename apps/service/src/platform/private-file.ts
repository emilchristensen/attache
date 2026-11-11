import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import type { Env } from "./locations.ts";
import { launchTool } from "./launch.ts";
import { currentOs, type Os } from "./os.ts";
import { replaceWith } from "./replace-file.ts";

const system32 = (env: Env, exe: string) => win32.join(env.SystemRoot || "C:\\Windows", "System32", exe);

function runSync(path: string, args: string[]): { ok: boolean; stdout: string; why: string } {
  const launch = launchTool(path, args, "windows");
  const r = spawnSync(launch.command, launch.args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (r.error) return { ok: false, stdout: "", why: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout ?? "", why: (r.stderr || r.stdout || "").trim().split(/\r?\n/)[0] || `exit ${r.status}` };
}

let userSid: string | null = null;

/** The security identifier of the user this process runs as, from `whoami /user`. */
function currentUserSid(env: Env): string {
  if (userSid) return userSid;
  const r = runSync(env.JARVIS_WHOAMI_BIN || system32(env, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[\d-]+)"/.exec(r.stdout)?.[1];
  if (!r.ok || !sid) throw new Error(`Jarvis could not find out which Windows user it runs as: ${r.why}`);
  userSid = sid;
  return sid;
}

/**
 * Give a file an access-control list of its own that lets only the current
 * user in: inherited entries are removed, so a folder that others may read
 * (a state folder outside the user profile, such as `D:\Jarvis`) does not
 * pass that on.
 */
function restrictToOwner(path: string, env: Env): void {
  const sid = currentUserSid(env);
  const r = runSync(env.JARVIS_ICACLS_BIN || system32(env, "icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`]);
  if (!r.ok) throw new Error(`Jarvis could not make ${path} private: ${r.why}`);
}

/**
 * Write a file only its owner can read, in one step: mode 0600 on macOS and
 * Linux, an owner-only access-control list on Windows, which has no mode bits.
 * The temporary file is made private while still empty, so the content is
 * never readable by anyone else, not even for a moment. Throws, and writes
 * nothing, when the file cannot be made private.
 */
export function writePrivateFile(path: string, data: string, os: Os = currentOs(), env: Env = process.env): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
    if (os === "windows") restrictToOwner(tmp, env);
    // r+ opens the existing file, so it keeps the access-control list just set.
    writeFileSync(tmp, data, { flag: "r+" });
    replaceWith(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
