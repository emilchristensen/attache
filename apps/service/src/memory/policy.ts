import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * Deterministic write policy for the data folder. Every memory write goes
 * through `assertWritable`, whatever its origin. The policy does not depend on
 * model output or instructions found in documents.
 */

/** The actor Consolidation writes as, so the change log tells its changes from the owner's (ADR 0004). */
export const CONSOLIDATION_ACTOR = "consolidation";
export type WriteActor = "user" | "service" | typeof CONSOLIDATION_ACTOR | "connector" | "model" | "import";

export const AREAS = ["memory", "evidence", "deliverables"] as const;
export type Area = (typeof AREAS)[number] | "import";

/** Records that only an authenticated user action may change. */
const PROTECTED = [/^memory\/self\.md$/i];

export class PolicyError extends Error {
  readonly code: "outside_root" | "protected" | "actor_denied" | "invalid_path";
  constructor(message: string, code: "outside_root" | "protected" | "actor_denied" | "invalid_path") {
    super(message);
    this.code = code;
  }
}

export function normalizeRel(rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) throw new PolicyError(`Invalid path: ${rel}`, "invalid_path");
  const n = normalize(rel).split(sep).join("/");
  if (n.startsWith("../") || n === ".." || n.startsWith("/")) throw new PolicyError(`Path escapes data folder: ${rel}`, "outside_root");
  return n;
}

/**
 * A path in the Brain as a Harness or a model writes it, cleaned up: a leading
 * "./" is dropped, then it is normalised like any relative path, and refused
 * when it is no path in the Brain.
 */
export function brainRel(path: string): string {
  return normalizeRel(path.replace(/^\.\//, ""));
}

/** Resolve a relative path inside root, refusing escapes including via symlinked parents. */
export function resolveInside(root: string, rel: string): string {
  const n = normalizeRel(rel);
  const abs = resolve(root, n);
  const realRoot = realpathSync(root);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  const r = relative(realRoot, realProbe);
  if (r.startsWith("..") || isAbsolute(r)) throw new PolicyError(`Path escapes data folder via symlink: ${rel}`, "outside_root");
  return abs;
}

export function areaOf(rel: string): Area | null {
  const first = rel.split("/")[0];
  return (AREAS as readonly string[]).includes(first ?? "") ? (first as Area) : null;
}

export function isProtected(rel: string): boolean {
  return PROTECTED.some((re) => re.test(rel));
}

/**
 * Which actor may write where:
 * - user: memory, evidence, deliverables; protected records only with explicit confirmation.
 * - service: evidence and deliverables (archives, briefings, job outputs) and applying user-approved proposals.
 * - consolidation: memory only, what Consolidation found in a session or a meeting and screened like a save (ADR 0004).
 * - connector / import: evidence only.
 * - model: nothing directly; model suggestions become proposals.
 */
export function assertWritable(rel: string, actor: WriteActor, opts: { confirmedProtected?: boolean; approvedProposal?: boolean } = {}): void {
  const n = normalizeRel(rel);
  const area = areaOf(n);
  if (!area) throw new PolicyError(`Writes are limited to memory/, evidence/ and deliverables/: ${n}`, "invalid_path");
  if (!n.endsWith(".md")) throw new PolicyError(`Only Markdown files may be written: ${n}`, "invalid_path");
  if (isProtected(n)) {
    if (actor !== "user" || !opts.confirmedProtected) throw new PolicyError(`${n} is a protected identity record; change it from Settings`, "protected");
    return;
  }
  switch (actor) {
    case "user":
      return;
    case "service":
      if (area === "memory" && !opts.approvedProposal) throw new PolicyError("The service writes curated memory only for approved proposals", "actor_denied");
      return;
    case CONSOLIDATION_ACTOR:
      if (area !== "memory") throw new PolicyError("Consolidation writes curated memory only", "actor_denied");
      return;
    case "connector":
    case "import":
      if (area !== "evidence") throw new PolicyError(`${actor} data is archived as evidence only`, "actor_denied");
      return;
    case "model":
      throw new PolicyError("Model output cannot write memory; create a proposal instead", "actor_denied");
  }
}
