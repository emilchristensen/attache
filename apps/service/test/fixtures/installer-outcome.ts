/**
 * What the installer of an Update leaves in the Machine's state when it finishes (`<state>/updates/outcome.json`),
 * written as `install.sh` and `install.ps1` write it. Service tests and browser journeys play the installer with it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function installerFinished(
  stateDir: string,
  outcome: { outcome: "updated" | "rolled_back" | "failed"; from: string; to: string; reason?: string; database?: "restored" | "no_backup" | "restore_failed"; backup?: string; at?: string },
): void {
  mkdirSync(join(stateDir, "updates"), { recursive: true });
  // `at` is when the installer finished: now, unless the test plays an Update that finished earlier.
  writeFileSync(join(stateDir, "updates", "outcome.json"), JSON.stringify({ at: new Date().toISOString(), ...outcome }) + "\n");
}
