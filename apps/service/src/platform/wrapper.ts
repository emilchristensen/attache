import { win32 } from "node:path";
import { pathFor, type PlatformLocations } from "./locations.ts";
import type { Os } from "./os.ts";

/** A small executable file that starts Attache. */
export interface WrapperFile {
  path: string;
  text: string;
  mode: number;
}

/** What the command-line entry points are pinned to. */
export interface WrapperSpec {
  installPrefix: string;
  stateDir: string;
  instance: string;
  port: number;
}

/** Quote a value for use inside double quotes in a POSIX shell script. */
const shDouble = (s: string) => s.replace(/[\\"$`]/g, (c) => `\\${c}`);
/** cmd.exe has no escape inside double quotes; `%` would expand and `"` would end the string, so they are refused. */
function cmdValue(s: string): string {
  if (/["%\r\n]/.test(s)) throw new Error(`An Attache path cannot contain ", % or a line break on Windows: ${s}`);
  return s;
}

/** cmd.exe reads a batch file in the console's code page, never UTF-8, so a wrapper holds ASCII only. */
const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * A path as a Windows wrapper in `binDir` writes it: relative to the
 * wrapper's own folder (`%~dp0`), so letters outside ASCII in the part it
 * shares with the install (an owner named Søren) never appear in the file;
 * else in full, which must then be ASCII.
 */
function fromWrapperFolder(binDir: string, target: string): string {
  cmdValue(target);
  const relative = win32.relative(binDir, target);
  const text = win32.isAbsolute(relative) ? relative : `%~dp0${relative}`;
  if (!ASCII_ONLY.test(text)) throw new Error(`Attache cannot pin ${target} in its Windows command wrappers: cmd.exe misreads letters outside ASCII in batch files. Keep the state folder inside the install folder, or choose a path with ASCII letters only.`);
  return text;
}

/** A batch line setting `name` to the full, normalised form of `path` (which may be relative to `%~dp0`). */
const setFullPath = (name: string, path: string) => `for %%p in ("${path}") do set "${name}=%%~fp"`;

/**
 * `attache.cmd` and `attache-uninstall.cmd` in the install's own `bin` folder.
 * They are plain ASCII and find the install from their own folder, so they
 * work whatever letters the owner's name or the install path has.
 */
function windowsWrappers(spec: WrapperSpec): WrapperFile[] {
  const binDir = win32.join(spec.installPrefix, "bin");
  const at = (path: string) => fromWrapperFolder(binDir, path);
  const instance = cmdValue(spec.instance);
  const current = win32.join(spec.installPrefix, "current");
  const powershell = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  return [
    {
      path: win32.join(binDir, "attache.cmd"),
      text: ["@echo off", "setlocal", `if not defined ATTACHE_STATE_DIR ${setFullPath("ATTACHE_STATE_DIR", at(spec.stateDir))}`, `if not defined ATTACHE_INSTANCE set "ATTACHE_INSTANCE=${instance}"`, `if not defined ATTACHE_PORT set "ATTACHE_PORT=${spec.port}"`, `"${at(win32.join(current, "bin", "attache.cmd"))}" %*`, ""].join("\r\n"),
      mode: 0o755,
    },
    {
      path: win32.join(binDir, "attache-uninstall.cmd"),
      // The uninstaller deletes this very file, and cmd.exe reads a batch file again after every command.
      // `(goto)` ends the batch first; the rest of the line, already expanded, still runs, and nothing is read again.
      // So the pinned values go as arguments: the batch's own variables end with it.
      text: ["@echo off", `(goto) 2>nul & "${powershell}" -NoProfile -ExecutionPolicy Bypass -File "${at(win32.join(current, "uninstall.ps1"))}" --prefix "${at(spec.installPrefix)}" --state-dir "${at(spec.stateDir)}" --instance ${instance} %*`, ""].join("\r\n"),
      mode: 0o755,
    },
  ];
}

/**
 * The launcher inside a release (`bin/attache`): runs the bundled runtime on
 * the bundled service, wherever the release was unpacked. Path relative to
 * the release root.
 */
export function releaseLauncher(os: Os): WrapperFile {
  if (os === "windows") return { path: "bin/attache.cmd", text: '@"%~dp0..\\runtime\\node.exe" "%~dp0..\\service\\attache-service.mjs" %*\r\n', mode: 0o755 };
  return { path: "bin/attache", text: '#!/bin/sh\nD="$(cd "$(dirname "$0")/.." && pwd -P)"\nexec "$D/runtime/node" "$D/service/attache-service.mjs" "$@"\n', mode: 0o755 };
}

/**
 * The command-line entry points the installer puts on the owner's PATH
 * (on Windows, in the install's own `bin` folder):
 * `attache`, pinned to this install's state folder, instance and port unless
 * the environment says otherwise, and `attache-uninstall`, pinned to the
 * install and its state folder. Both go through
 * the stable `current` link so they survive upgrades.
 */
export function commandWrappers(loc: PlatformLocations, spec: WrapperSpec): WrapperFile[] {
  if (loc.os === "windows") return windowsWrappers(spec);
  const { join } = pathFor(loc.os);
  const current = join(spec.installPrefix, "current");
  const q = shDouble;
  return [
    {
      path: join(loc.binDir, "attache"),
      text: `#!/bin/sh\nexport ATTACHE_STATE_DIR="\${ATTACHE_STATE_DIR:-${q(spec.stateDir)}}"\nexport ATTACHE_INSTANCE="\${ATTACHE_INSTANCE:-${q(spec.instance)}}"\nexport ATTACHE_PORT="\${ATTACHE_PORT:-${spec.port}}"\nexec "${q(join(current, "bin", "attache"))}" "$@"\n`,
      mode: 0o755,
    },
    {
      path: join(loc.binDir, "attache-uninstall"),
      text: `#!/bin/sh\nATTACHE_PREFIX="${q(spec.installPrefix)}" ATTACHE_STATE_DIR="${q(spec.stateDir)}" ATTACHE_INSTANCE="${q(spec.instance)}" exec /bin/sh "${q(join(current, "uninstall.sh"))}" "$@"\n`,
      mode: 0o755,
    },
  ];
}
