import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Review state is the owner's inbox and Proposals with their decisions. It
 * lives in the Brain so it replicates to every Machine, in a top-level folder
 * that recall never indexes: its files are JSON, and the indexer skips the
 * folder explicitly too.
 */
export const REVIEW_STATE_DIR = "review";

export type ReviewKind = "inbox" | "proposals";

const SLUG_MAX = 48;
const HASH_CHARS = 12;

function slug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * The file that holds one item. The same key gives the same path on every
 * Machine, so two Machines writing the same item meet as one conflicting file
 * that the kind's merge rule settles.
 */
export function reviewPath(kind: ReviewKind, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, HASH_CHARS);
  const name = slug(key);
  return `${REVIEW_STATE_DIR}/${kind}/${name ? `${name}-` : ""}${hash}.json`;
}

/** Whether `rel` (a Brain-relative path with forward slashes) is review state, of `kind` when given. */
export function isReviewPath(rel: string, kind?: ReviewKind): boolean {
  const parts = rel.split(/[\\/]/).filter((p) => p && p !== ".");
  if (parts[0] !== REVIEW_STATE_DIR) return false;
  if (!kind) return true;
  return parts.length === 3 && parts[1] === kind && parts[2]!.endsWith(".json");
}

/**
 * One line of JSON: any change both Machines made to the same file then
 * conflicts as a whole and reaches the merge rule, instead of git merging
 * two halves of a JSON document line by line.
 */
export function encodeReviewFile(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** The parsed file, or null when it is missing or not JSON. */
export function decodeReviewFile(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Replace the file atomically, so git and other readers never see half of it. */
export function writeReviewFile(root: string, rel: string, value: unknown): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, encodeReviewFile(value));
  renameSync(tmp, abs);
}

export function readReviewFile(root: string, rel: string): unknown {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  return decodeReviewFile(readFileSync(abs, "utf8"));
}

export function removeReviewFile(root: string, rel: string): void {
  rmSync(join(root, rel), { force: true });
}

/** Every file of `kind`, as Brain-relative paths. */
export function listReviewFiles(root: string, kind: ReviewKind): string[] {
  const dir = join(root, REVIEW_STATE_DIR, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .sort()
    .map((n) => `${REVIEW_STATE_DIR}/${kind}/${n}`);
}
