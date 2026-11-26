/**
 * The two records an Update leaves in the Machine's state, so that what
 * happened survives the restart in the middle of it (spec #130, "Updater"):
 * - `<state>/updates/install.json`, written by the Updater just before it starts the installer: which version it
 *   moves from and to, and the new version's release notes from its signed manifest.
 * - `<state>/updates/outcome.json`, written by the installer in unattended mode when it is done (`installer/install.sh`,
 *   `installer/install.ps1`): `{ outcome, from, to, at, reason? }`, where outcome is `updated`, `rolled_back` (the new
 *   version did not come up, so it switched back) or `failed` (it stopped before changing anything).
 * The outcome's fields are a contract with installers of other versions: add fields, never rename them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LastUpdateView } from "@attache/contracts";
import { writeFileWhole } from "../platform/replace-file.ts";
import { updatesDir } from "./bad-versions.ts";

/** Where a release waits, downloaded and verified, until it is installed or superseded: `<state>/updates/staging/<version>/`. */
export const stagingDir = (stateDir: string): string => join(updatesDir(stateDir), "staging");
const requestFile = (stateDir: string) => join(updatesDir(stateDir), "install.json");
/** Where the installer writes its outcome. */
export const outcomeFile = (stateDir: string): string => join(updatesDir(stateDir), "outcome.json");

const InstallRequestRecord = z.object({ from: z.string(), to: z.string(), notes: z.string(), at: z.string() });
export type InstallRequestRecord = z.infer<typeof InstallRequestRecord>;

const OutcomeRecord = z.looseObject({
  outcome: z.enum(["updated", "rolled_back", "failed"]),
  from: z.string(),
  to: z.string(),
  at: z.string(),
  reason: z.string().optional(),
});
export type OutcomeRecord = z.infer<typeof OutcomeRecord>;

function readRecord<T>(file: string, schema: z.ZodType<T>, what: string): T | null {
  if (!existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not ${what}: ${(e as Error).message}`, { cause: e });
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new Error(`${file} is not ${what}: ${r.error.issues[0]?.message ?? "unreadable"}.`);
  return r.data;
}

/** The Update the Updater last handed to the installer, or null. */
export const readInstallRequest = (stateDir: string): InstallRequestRecord | null => readRecord(requestFile(stateDir), InstallRequestRecord, "a record of an Update being installed");

/** What the installer last said, or null when it has said nothing since the last Update began. */
export const readOutcome = (stateDir: string): OutcomeRecord | null => readRecord(outcomeFile(stateDir), OutcomeRecord, "an Update's outcome");

/** Record the Update about to be installed, and forget the last one's outcome: the next outcome is this one's. */
export function recordInstallRequest(stateDir: string, request: InstallRequestRecord): void {
  mkdirSync(updatesDir(stateDir), { recursive: true, mode: 0o700 });
  rmSync(outcomeFile(stateDir), { force: true });
  writeFileWhole(requestFile(stateDir), JSON.stringify(request, null, 2) + "\n", { mode: 0o600 });
}

/** Record an outcome the installer could not: it never reported back. */
export function recordOutcome(stateDir: string, outcome: OutcomeRecord): void {
  writeFileWhole(outcomeFile(stateDir), JSON.stringify(outcome, null, 2) + "\n", { mode: 0o600 });
}

/** Forget an install request whose installer never started. */
export const forgetInstallRequest = (stateDir: string): void => rmSync(requestFile(stateDir), { force: true });

/** The last Update as the owner reads it: the installer's outcome, with the release notes the Updater kept for it. */
export function lastUpdateOf(outcome: OutcomeRecord, request: InstallRequestRecord | null): LastUpdateView {
  const { from, to, at } = outcome;
  if (outcome.outcome === "updated") return { outcome: "updated", from, to, at, notes: request?.to === to ? request.notes : "" };
  return { outcome: outcome.outcome, from, to, at, reason: outcome.reason ?? "The installer gave no reason." };
}
