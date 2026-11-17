#!/usr/bin/env node
/**
 * The lowest Node version Attache supports for development, from `engines.node` in package.json
 * (the one place it is written). CI tests on it; `pnpm install` refuses anything older (engineStrict).
 * Run directly, it prints the version and, on GitHub Actions, sets the step output `version`.
 * It runs before setup-node, on whatever Node the runner has, so it uses nothing newer than Node 18.
 * Usage: node scripts/node-minimum.mjs
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RANGE = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/;

/** The version an engines range of the form `>=X.Y.Z` starts at. */
export function minimumNode(range) {
  const m = RANGE.exec(range ?? "");
  if (!m) throw new Error(`engines.node must be a range of the form >=X.Y.Z, got ${JSON.stringify(range)}`);
  return m[1];
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b` (X.Y.Z versions). */
export function compareVersions(a, b) {
  const [pa, pb] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = minimumNode(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines?.node);
  console.log(version);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
