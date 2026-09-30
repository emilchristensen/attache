import { appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Patterns for credentials that must never reach logs, evidence or API
 * responses. Known secret values registered at runtime are redacted too.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}/gi,
  /\bATATT[A-Za-z0-9_=-]{20,}\b/g,
];

const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) out = out.split(secret).join("[REDACTED]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password|authorization|api[_-]?key/i.test(k) && typeof v === "string" ? "[REDACTED]" : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

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
    if (!opts.quiet && (level !== "debug" || process.env.JARVIS_DEBUG)) {
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
