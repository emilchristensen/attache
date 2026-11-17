import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { redact, redactDeep } from "./redaction.ts";

/** Redaction lives in `redaction.ts`, shared with the credential scan; these re-exports keep existing imports working. */
export { redact, redactDeep, registerSecret } from "./redaction.ts";

type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export function createLogger(logDir: string | null, opts: { quiet?: boolean } = {}): Logger {
  const file = logDir ? join(logDir, "service.log") : null;
  const write = (level: Level, msg: string, data?: unknown) => {
    const line = redact(
      JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data === undefined ? {} : { data: redactDeep(data) }) }),
    );
    if (file) {
      try {
        appendFileSync(file, line + "\n", { mode: 0o600 });
      } catch {
        // Logging must never take the service down.
      }
    }
    if (!opts.quiet && (level !== "debug" || process.env.ATTACHE_DEBUG)) {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    }
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}
