/**
 * Which releases a Machine may take (spec #130, "Release feed client"): those
 * in its Update channel, newer than the version it runs, and not marked bad on
 * this Machine. Stable takes Stable releases; Beta takes Beta and Stable ones.
 * A Machine never moves to an older version, so a Machine switched from Beta
 * to Stable stays put until Stable passes it.
 */
import type { UpdateChannel } from "@attache/contracts";
import { channelOf, isReleaseVersion } from "../release/manifest.ts";
import { compareVersions, parseVersion, type Version } from "./version.ts";

export interface Eligibility {
  /** The version this Machine runs. */
  installed: string;
  channel: UpdateChannel;
  /** Versions that failed on this Machine and rolled back; never tried again. */
  bad: readonly string[];
}

/** A release's tag as the version it carries: `v0.7.0` and `0.7.0` both carry `0.7.0`. */
export const tagVersion = (tag: string): string => tag.trim().replace(/^v/, "");

/** The versions among `tags` this Machine may take, newest first, each once. */
export function eligibleVersions(tags: readonly string[], e: Eligibility): string[] {
  const installed = parseVersion(e.installed);
  if (!installed) return [];
  const bad = new Set(e.bad.map(tagVersion));
  const found = new Map<string, Version>();
  for (const tag of tags) {
    const version = tagVersion(tag);
    if (!isReleaseVersion(version) || found.has(version) || bad.has(version)) continue;
    if (e.channel === "stable" && channelOf(version) !== "stable") continue;
    const parsed = parseVersion(version)!;
    if (compareVersions(parsed, installed) > 0) found.set(version, parsed);
  }
  return [...found].sort(([, a], [, b]) => compareVersions(b, a)).map(([v]) => v);
}
