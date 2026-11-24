/**
 * Chrome's environment for the browser journeys. Linux has no Georgia, the
 * first family of the Dashboard's `--serif`, so there "Georgia" is the bundled
 * Gelasio (`fonts/`), which has Georgia's metrics: headings then wrap and
 * overflow as they do on macOS and Windows.
 */
import { join } from "node:path";

/** The fontconfig file that adds `fonts/` and maps "Georgia" to Gelasio, on top of the system's configuration. */
export const GEORGIA_FONTCONFIG = join(import.meta.dirname, "fonts", "fonts.conf");

/** The environment to start Chrome with: this one, plus the Georgia mapping on Linux. */
export function chromeEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return process.platform === "linux" ? { ...env, FONTCONFIG_FILE: GEORGIA_FONTCONFIG } : env;
}
