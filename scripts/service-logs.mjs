/**
 * The logs an Attache service writes in its state folder's `logs` (service.log, and service.err.log
 * and service.out.log under a service manager), copied out of temporary folders before they are gone,
 * so a failed CI run can upload them.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Large enough for a whole test run's log; a runaway one keeps its end, where the failure is.
const MAX_BYTES = 2 * 1024 * 1024;
// Deep enough for a state folder inside the install test's home (AppData/Local/Attache/state/logs).
const MAX_DEPTH = 6;
// Attache's test folders: attache-it-*, attache-e2e-*, "attache clean home æøå-*".
const ATTACHE_FOLDER = /^attache/i;
const SKIP = new Set(["node_modules", ".git"]);

/** The file's content, or its last `maxBytes` with a note of how much was left out. */
function tail(file, maxBytes) {
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return size > maxBytes ? Buffer.concat([Buffer.from(`[the first ${size - maxBytes} bytes left out]\n`), buf]) : buf;
}

/** Copy every file in a logs folder (and below) to `to`. Returns how many files were copied. */
export function copyLogFolder(from, to, { maxBytes = MAX_BYTES } = {}) {
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    if (e.isDirectory()) copied += copyLogFolder(src, join(to, e.name), { maxBytes });
    else if (e.isFile()) {
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, e.name), tail(src, maxBytes));
      copied++;
    }
  }
  return copied;
}

/** Every `logs` folder at most `depth` levels below `dir`, not following links. */
function logFolders(dir, depth) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Removed while we looked, or not ours to read.
    return [];
  }
  return entries.filter((e) => e.isDirectory() && !SKIP.has(e.name)).flatMap((e) => (e.name === "logs" ? [join(dir, e.name)] : logFolders(join(dir, e.name), depth - 1)));
}

/**
 * Copy the `logs` folders of every Attache test folder in `tmp` to `out`, at the same relative paths.
 * Returns how many files were copied.
 */
export function collectServiceLogs({ tmp = tmpdir(), out, maxBytes = MAX_BYTES }) {
  const roots = readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory() && ATTACHE_FOLDER.test(e.name));
  let copied = 0;
  for (const root of roots) {
    for (const logs of logFolders(join(tmp, root.name), MAX_DEPTH)) copied += copyLogFolder(logs, join(out, relative(tmp, logs)), { maxBytes });
  }
  return copied;
}
