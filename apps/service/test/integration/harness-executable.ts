import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

/**
 * Where a real-executable smoke test finds its Harness: the path in `overrideVar` when it is set,
 * else the first `command` on PATH; null when there is neither, so the smoke test is skipped.
 *
 * A version manager's shim (mise, asdf) is resolved to the executable it runs, asked with the
 * owner's own environment. The smoke tests run the executable with HOME (and for OpenCode the XDG
 * folders) pointed at a temporary home, where a shim finds none of the owner's version-manager
 * configuration and installs, and tries to install the tool instead of running it.
 */
export function findHarnessExecutable(command: string, overrideVar: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const found = env[overrideVar] || onPath(command, env);
  if (!found) return null;
  // A named executable that is missing fails where the smoke test runs it, with that test's message.
  if (!existsSync(found)) return found;
  const shim = shimOf(found);
  return shim ? resolveShim(found, command, overrideVar, shim, env) : found;
}

function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of [command, `${command}.cmd`, `${command}.exe`]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

interface Shim {
  manager: "mise" | "asdf";
  /** The version manager's own executable, which names the executable a shim runs. */
  executable: string;
}

/** The version manager behind a shim, or null when `path` is not one. */
function shimOf(path: string): Shim | null {
  // mise's shims are links to (or, on Windows, copies of) the mise executable, in a `mise/shims` folder.
  const real = realpathSync(path);
  if (/^mise(\.exe)?$/i.test(basename(real))) return { manager: "mise", executable: real };
  if (basename(dirname(path)) === "shims" && basename(dirname(dirname(path))) === "mise") return { manager: "mise", executable: "mise" };
  // asdf's shims are scripts that end in `exec <asdf> exec "<command>" "$@"`.
  const asdf = /^exec\s+(\S*asdf)\s+exec\s/m.exec(head(real))?.[1];
  return asdf ? { manager: "asdf", executable: asdf } : null;
}

/** The first kilobyte of a file, as text: enough for a shim script, without reading a whole binary. */
function head(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function resolveShim(path: string, command: string, overrideVar: string, shim: Shim, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(shim.executable, ["which", command], { env, encoding: "utf8", windowsHide: true });
  const resolved = (r.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  if (r.status === 0 && resolved && existsSync(resolved)) return resolved;
  const said = `${r.error?.message ?? ""}${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  throw new Error(`${path} is a ${shim.manager} shim, and \`${shim.manager} which ${command}\` did not name the executable it runs (${said || `exit ${r.status}`}). Install ${command} with ${shim.manager}, or name the executable in ${overrideVar}.`);
}
