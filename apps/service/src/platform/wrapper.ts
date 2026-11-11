import { pathFor, type PlatformLocations } from "./locations.ts";
import type { Os } from "./os.ts";

/** A small executable file that starts Jarvis. */
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
  if (/["%\r\n]/.test(s)) throw new Error(`A Jarvis path cannot contain ", % or a line break on Windows: ${s}`);
  return s;
}

/**
 * The launcher inside a release (`bin/jarvis`): runs the bundled runtime on
 * the bundled service, wherever the release was unpacked. Path relative to
 * the release root.
 */
export function releaseLauncher(os: Os): WrapperFile {
  if (os === "windows") return { path: "bin/jarvis.cmd", text: '@"%~dp0..\\runtime\\node.exe" "%~dp0..\\service\\jarvis-service.mjs" %*\r\n', mode: 0o755 };
  return { path: "bin/jarvis", text: '#!/bin/sh\nD="$(cd "$(dirname "$0")/.." && pwd -P)"\nexec "$D/runtime/node" "$D/service/jarvis-service.mjs" "$@"\n', mode: 0o755 };
}

/**
 * The command-line entry points the installer puts on the owner's PATH:
 * `jarvis`, pinned to this install's state folder, instance and port unless
 * the environment says otherwise, and `jarvis-uninstall`, pinned to the
 * install and its state folder. Both go through
 * the stable `current` link so they survive upgrades.
 */
export function commandWrappers(loc: PlatformLocations, spec: WrapperSpec): WrapperFile[] {
  const { join } = pathFor(loc.os);
  const current = join(spec.installPrefix, "current");
  if (loc.os === "windows") {
    const v = cmdValue;
    return [
      {
        path: join(loc.binDir, "jarvis.cmd"),
        text: ["@echo off", "setlocal", `if not defined JARVIS_STATE_DIR set "JARVIS_STATE_DIR=${v(spec.stateDir)}"`, `if not defined JARVIS_INSTANCE set "JARVIS_INSTANCE=${v(spec.instance)}"`, `if not defined JARVIS_PORT set "JARVIS_PORT=${spec.port}"`, `"${v(join(current, "bin", "jarvis.cmd"))}" %*`, ""].join("\r\n"),
        mode: 0o755,
      },
      {
        path: join(loc.binDir, "jarvis-uninstall.cmd"),
        text: ["@echo off", "setlocal", `set "JARVIS_PREFIX=${v(spec.installPrefix)}"`, `set "JARVIS_STATE_DIR=${v(spec.stateDir)}"`, `set "JARVIS_INSTANCE=${v(spec.instance)}"`, `powershell -NoProfile -ExecutionPolicy Bypass -File "${v(join(current, "uninstall.ps1"))}" %*`, ""].join("\r\n"),
        mode: 0o755,
      },
    ];
  }
  const q = shDouble;
  return [
    {
      path: join(loc.binDir, "jarvis"),
      text: `#!/bin/sh\nexport JARVIS_STATE_DIR="\${JARVIS_STATE_DIR:-${q(spec.stateDir)}}"\nexport JARVIS_INSTANCE="\${JARVIS_INSTANCE:-${q(spec.instance)}}"\nexport JARVIS_PORT="\${JARVIS_PORT:-${spec.port}}"\nexec "${q(join(current, "bin", "jarvis"))}" "$@"\n`,
      mode: 0o755,
    },
    {
      path: join(loc.binDir, "jarvis-uninstall"),
      text: `#!/bin/sh\nJARVIS_PREFIX="${q(spec.installPrefix)}" JARVIS_STATE_DIR="${q(spec.stateDir)}" JARVIS_INSTANCE="${q(spec.instance)}" exec /bin/sh "${q(join(current, "uninstall.sh"))}" "$@"\n`,
      mode: 0o755,
    },
  ];
}
