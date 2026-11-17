/**
 * What counts as a credential, in one place: redaction (logs, evidence, API
 * responses) and the credential scan before every Replication commit both use
 * this list, so the two can never disagree about what a secret looks like.
 */

export interface SecretPattern {
  /** What the match looks like, safe to show the owner, e.g. "a GitHub token". */
  readonly kind: string;
  /** Global, so every match in a text is found. */
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  { kind: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "a GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "an Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "an API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "an AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "a Google access token", pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  { kind: "a JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "an authorization header", pattern: /(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}/gi },
  { kind: "an Atlassian API token", pattern: /\bATATT[A-Za-z0-9_=-]{20,}\b/g },
]);

const REDACTED = "[REDACTED]";
/** Shorter values are too likely to occur in ordinary text to be redacted everywhere. */
const KNOWN_SECRET_MIN = 8;

const knownSecrets = new Set<string>();

/** A secret this service holds (e.g. a connection token), redacted and scanned for by value from now on. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= KNOWN_SECRET_MIN) knownSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) out = out.split(secret).join(REDACTED);
  for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password|authorization|api[_-]?key/i.test(k) && typeof v === "string" ? REDACTED : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/** One credential in a text. It never carries the secret itself, only where it is and what it looks like. */
export interface SecretFinding {
  /** 1-based line the secret starts on. */
  readonly line: number;
  readonly kind: string;
}

interface Match {
  index: number;
  kind: string;
  value: string;
}

/** Everything `redact` replaces in `text`, in the order it appears. */
function matches(text: string): Match[] {
  const out: Match[] = [];
  for (const secret of knownSecrets) {
    for (let i = text.indexOf(secret); i !== -1; i = text.indexOf(secret, i + secret.length)) out.push({ index: i, kind: "a secret Attache holds", value: secret });
  }
  for (const { kind, pattern } of SECRET_PATTERNS) {
    for (const m of text.matchAll(pattern)) out.push({ index: m.index, kind, value: m[0] });
  }
  return out.sort((a, b) => a.index - b.index);
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/**
 * Every credential `redact` would hide in `text`, at most one per line, in
 * line order. A secret that also appears in one of `known` (e.g. versions of
 * the same file that are committed already) is not reported: it is not new.
 */
export function findSecrets(text: string, known: readonly string[] = []): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const m of matches(text)) {
    if (known.some((k) => k.includes(m.value))) continue;
    const line = lineAt(text, m.index);
    if (out.at(-1)?.line !== line) out.push({ line, kind: m.kind });
  }
  return out;
}
