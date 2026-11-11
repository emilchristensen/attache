import { setTimeout as sleep } from "node:timers/promises";

export { sleep };

/**
 * Check `done` every `everyMs` until it says true or `timeoutMs` has passed.
 * True when it became true in time; the caller says what failed otherwise.
 */
export async function waitUntil(done: () => Promise<boolean>, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
  return true;
}
