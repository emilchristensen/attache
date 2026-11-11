/** The operating systems Jarvis runs on. Everything that differs between them lives under `platform/`. */
export type Os = "macos" | "linux" | "windows";

const BY_NODE_PLATFORM: Readonly<Record<string, Os>> = { darwin: "macos", linux: "linux", win32: "windows" };

/** Thrown on any other operating system; its message is what the owner sees. */
export class UnsupportedPlatformError extends Error {
  readonly platform: string;
  constructor(platform: string) {
    super(`Jarvis runs on macOS, Linux and Windows. This computer runs ${platform}, which Jarvis does not support.`);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
  }
}

/** The operating system this process runs on. Throws `UnsupportedPlatformError` on any other. */
export function currentOs(nodePlatform: string = process.platform): Os {
  const os = BY_NODE_PLATFORM[nodePlatform];
  if (!os) throw new UnsupportedPlatformError(nodePlatform);
  return os;
}

const LABELS: Readonly<Record<Os, string>> = { macos: "macOS", linux: "Linux", windows: "Windows" };

/** The name the owner knows the operating system by, for messages. */
export const osLabel = (os: Os): string => LABELS[os];

/**
 * Thrown when a platform module has no implementation for this operating
 * system yet. Linux and Windows gain theirs in later releases.
 */
export class NotYetOnPlatformError extends Error {
  constructor(what: string, os: Os, instead: string) {
    super(`${what} is not available on ${osLabel(os)} yet. ${instead}`);
    this.name = "NotYetOnPlatformError";
  }
}
