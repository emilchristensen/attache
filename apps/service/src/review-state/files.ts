import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slugify } from "../memory/markdown.ts";

/**
 * Review state lives in the Brain so it replicates: inbox items, the owner's
 * decisions on them, and Proposals. It is a folder of its own that recall
 * never indexes. Each item is one JSON file written as a single line, so a
 * change both Machines made to the same item is always a git conflict that
 * reaches a merge rule, never a textual splice of two JSON edits.
 */
export const REVIEW_STATE_DIR = "review";

const SLUG_MAX = 48;
const HASH_HEX = 12;

/** Whether a Brain-relative path is review state, optionally of one kind (`proposals`, `inbox`). */
export function isReviewPath(rel: string, kind?: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const prefix = kind ? `${REVIEW_STATE_DIR}/${kind}/` : `${REVIEW_STATE_DIR}/`;
  return n.startsWith(prefix) && n.endsWith(".json");
}

/** The file for one item: the same key gives the same path on every Machine. */
export function reviewPath(kind: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, HASH_HEX);
  return `${REVIEW_STATE_DIR}/${kind}/${slugify(key).slice(0, SLUG_MAX).replace(/-+$/, "")}-${hash}.json`;
}

function inside(root: string, rel: string): string {
  if (!isReviewPath(rel)) throw new Error(`Not a review-state path: ${rel}`);
  if (rel.split("/").includes("..")) throw new Error(`Not a review-state path: ${rel}`);
  return join(root, rel);
}

/** One line of JSON and a newline. */
export function serializeReviewFile(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Write one item atomically. The caller tells Replication (`app.replication.noteWrite()`). */
export function writeReviewFile(root: string, rel: string, value: unknown): void {
  const abs = inside(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, serializeReviewFile(value));
  renameSync(tmp, abs);
}

/** The parsed file, or null when it is missing or not JSON. */
export function readReviewFile(root: string, rel: string): unknown {
  try {
    return JSON.parse(readFileSync(inside(root, rel), "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function removeReviewFile(root: string, rel: string): void {
  rmSync(inside(root, rel), { force: true });
}

/** Brain-relative paths of every item of one kind. */
export function listReviewFiles(root: string, kind: string): string[] {
  const dir = join(root, REVIEW_STATE_DIR, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => `${REVIEW_STATE_DIR}/${kind}/${f}`);
}
