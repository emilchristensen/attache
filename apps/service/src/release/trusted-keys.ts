/**
 * The public keys this Machine accepts a release signature from (ADR 0007):
 * the key built into this copy, plus every next key a verified manifest named.
 * The release build makes `process.env.ATTACHE_RELEASE_PUBLIC_KEY` a constant
 * in the bundle (`apps/service/build.mjs`), so nothing at run time replaces
 * the built-in key; only a run from source reads it from the environment, as
 * tests do. A next key is kept in the Machine's state, never in the Brain.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileWhole } from "../platform/replace-file.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { parsePublicKey, samePublicKey } from "./signature.ts";

/** The public key this copy was built with, or undefined for a build without one. */
export function builtInReleaseKey(): string | undefined {
  return process.env.ATTACHE_RELEASE_PUBLIC_KEY || undefined;
}

/** Where the next keys verified manifests named are kept. */
const keptKeysFile = (stateDir: string) => join(stateDir, "release-keys.json");

function keptKeys(stateDir: string): string[] {
  const file = keptKeysFile(stateDir);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { keys?: unknown };
  if (!Array.isArray(parsed.keys) || !parsed.keys.every((k) => typeof k === "string")) throw new Error(`${file} is not a list of release keys.`);
  return parsed.keys;
}

/** Every key a release signature may come from on this Machine. */
export function trustedReleaseKeys(stateDir: string): string[] {
  const builtIn = builtInReleaseKey();
  return [...(builtIn ? [builtIn] : []), ...keptKeys(stateDir)];
}

/** Keep the next key a verified manifest names. Call it only after the whole release verified. */
export function keepNextReleaseKey(stateDir: string, manifest: ReleaseManifest): void {
  const next = manifest.nextPublicKey;
  if (!next) return;
  parsePublicKey(next);
  if (trustedReleaseKeys(stateDir).some((k) => samePublicKey(k, next))) return;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileWhole(keptKeysFile(stateDir), JSON.stringify({ keys: [...keptKeys(stateDir), next] }, null, 2) + "\n", { mode: 0o600 });
}
