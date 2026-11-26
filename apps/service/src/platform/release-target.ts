/**
 * The release target a computer runs: which of Attache's release builds is the
 * one for it. The release build names its artifacts by these targets
 * (`scripts/release-targets.mjs`), and a release manifest lists one artifact per target.
 */
export type ReleaseTarget = "macos-arm64" | "linux-x64" | "windows-x64";

const TARGETS: Readonly<Record<string, ReleaseTarget>> = { "darwin-arm64": "macos-arm64", "linux-x64": "linux-x64", "win32-x64": "windows-x64" };

/** This computer's release target, or null when Attache has no release for it. */
export function releaseTarget(nodePlatform: string = process.platform, arch: string = process.arch): ReleaseTarget | null {
  return TARGETS[`${nodePlatform}-${arch}`] ?? null;
}
