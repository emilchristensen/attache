/**
 * Attache's version numbers, ordered by semantic versioning: `major.minor.patch`
 * with an optional prerelease (`-beta.N`) that comes before its release.
 * Build metadata (`+…`) does not count towards the order.
 */

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^(0|[1-9]\d*)$/;

export interface Version {
  release: readonly [number, number, number];
  /** The prerelease's dot-separated identifiers; empty for a release. */
  prerelease: readonly string[];
}

/** The parts of a version, or null when `text` is not a version number. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (!m) return null;
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ? m[4].split(".") : [] };
}

/** Numeric identifiers order by value and before alphanumeric ones, which order as text. */
function compareIdentifier(a: string, b: string): number {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return Math.sign(b.length - a.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareIdentifier(a[i]!, b[i]!);
    if (c) return c;
  }
  return Math.sign(a.length - b.length);
}

/** Negative when `a` is older than `b`, positive when newer, 0 when they rank the same. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const c = Math.sign(a.release[i]! - b.release[i]!);
    if (c) return c;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Whether `candidate` is a newer version than `current`; false when either is not a version number. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}
