import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { currentOs, type Os } from "./os.ts";

/** Errors Windows gives while another program (an editor, a virus scanner, the search indexer) has the target open. */
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long a replacement waits for such a program to let go before it gives up. */
const LOCKED_WAIT_MS = 5_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Move a fully written temporary file over `target` in one step, so a reader
 * sees the old file or the new one, never half of either.
 *
 * On macOS and Linux a rename replaces a file even while it is open. Windows
 * refuses while another program holds the target open without sharing delete
 * access, which virus scanners and indexers do for a moment after every
 * write; the rename is retried until it lets go. On failure the temporary file
 * is removed, so none are left beside the target.
 */
export function replaceWith(tmp: string, target: string, os: Os = currentOs()): void {
  const deadline = Date.now() + LOCKED_WAIT_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      renameSync(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (os === "windows" && LOCKED.has(code) && Date.now() + wait <= deadline) {
        sleepSync(wait);
        continue;
      }
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
}

/**
 * Write `data` to `target` so that a reader in another process sees the old
 * file, or no file, until the new one is complete. Writing in place would
 * empty the file first, and a reader that comes by before the write finishes
 * (likely on a loaded machine) finds it empty or half written.
 */
export function writeFileWhole(target: string, data: string, options: { mode?: number } = {}, os: Os = currentOs()): void {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: options.mode ?? 0o666, flag: "wx" });
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  replaceWith(tmp, target, os);
}
