#!/usr/bin/env node
/**
 * The release workflow's gate (`.github/workflows/release.yml`): what must
 * hold before a tag publishes a release, checked before anything is built.
 *
 * - The tag is `v<version>`, and the version is the one in the code
 *   (`package.json`, which the release build reads), and every other place
 *   that holds it says the same (`VERSION_FILES`).
 * - The version is one a release can carry: `x.y.z` (Stable) or `x.y.z-beta.N` (Beta).
 * - `CHANGELOG.md` has a section for it; that section is the release notes.
 * - The release public key is committed (`.github/release-public-key.pem`).
 * - The full CI run passed for the tagged commit (`release-gate/ci-run.mjs`).
 *
 *   node scripts/release-gate.mjs --commit <sha> --tag v<version> [--notes-out <file>] [--root <checkout>]
 *   node scripts/release-gate.mjs --commit <sha> --dry-run [--version <version>] [--notes-out <file>]
 *
 * A dry run has no tag: it builds the version given, by default the one in the
 * code, and reports what would refuse a real release as warnings without failing.
 * Writes `version` and `prerelease` to `$GITHUB_OUTPUT` and the release notes to
 * `--notes-out`. Reads GitHub from `GITHUB_API_URL`, `GITHUB_REPOSITORY` and
 * `GITHUB_TOKEN`, as a workflow step has them.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { channelOf, isReleaseVersion } from "../apps/service/src/release/manifest.ts";
import { parsePublicKey } from "../apps/service/src/release/signature.ts";
import { changelogProblem, changelogSection } from "./release-gate/changelog.mjs";
import { fullCiRun } from "./release-gate/ci-run.mjs";

/** Where the release public key is committed; the release build builds it into the service bundle. */
export const RELEASE_PUBLIC_KEY_FILE = ".github/release-public-key.pem";

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** The other places a version bump changes, each with how to read the version from it. */
const VERSION_FILES = [
  ["apps/service/package.json", (text) => JSON.parse(text).version],
  ["apps/web/package.json", (text) => JSON.parse(text).version],
  ["packages/contracts/package.json", (text) => JSON.parse(text).version],
  ["apps/service/src/core/version.ts", (text) => /\?\?\s*"([^"]+)"/.exec(text)?.[1]],
];

/** A half-done bump: places in the code that hold another version than package.json. */
function bumpProblem(root, codeVersion) {
  const behind = [];
  let other = null;
  for (const [file, versionIn] of VERSION_FILES) {
    const text = read(join(root, file));
    if (text === null) continue;
    const found = versionIn(text);
    if (found !== codeVersion) {
      behind.push(file);
      other ??= found;
    }
  }
  if (!behind.length) return null;
  const list = behind.length === 1 ? behind[0] : `${behind.slice(0, -1).join(", ")} and ${behind.at(-1)}`;
  return `The version is ${codeVersion} in package.json but ${other} in ${list}. Bump it in every one of them.`;
}

function versionProblem({ tag, codeVersion, version }) {
  if (tag !== undefined) {
    if (!/^v\d/.test(tag)) return `The tag ${tag} is not a release tag: release tags are v<version>, such as v0.7.0 or v0.7.0-beta.1.`;
    if (tag.slice(1) !== codeVersion) return `The tag ${tag} does not match the version in the code, ${codeVersion} (package.json). Bump the version in a commit, then tag that commit v<version>.`;
  }
  if (!isReleaseVersion(version)) return `${version} is not a release version: use x.y.z for Stable or x.y.z-beta.N for Beta.`;
  return null;
}

function publicKeyProblem(root) {
  const pem = read(join(root, RELEASE_PUBLIC_KEY_FILE));
  if (pem === null) return `There is no release public key at ${RELEASE_PUBLIC_KEY_FILE}. Make the signing key once with scripts/release-key-wizard.sh.`;
  try {
    parsePublicKey(pem);
    return null;
  } catch (e) {
    return `${RELEASE_PUBLIC_KEY_FILE} is not an Ed25519 public key (${e.message}). Make the signing key again with scripts/release-key-wizard.sh.`;
  }
}

async function ciProblem(commit, ref) {
  const api = { url: process.env.GITHUB_API_URL ?? "https://api.github.com", repo: process.env.GITHUB_REPOSITORY ?? "emilchristensen/attache", token: process.env.GITHUB_TOKEN };
  try {
    const found = await fullCiRun(api, commit, ref);
    if (found.run) console.log(`The full CI run passed on ${commit}: ${found.run.html_url}`);
    return found.problem ?? null;
  } catch (e) {
    return `Could not ask GitHub whether CI passed on ${commit}: ${e.message}`;
  }
}

async function main() {
  const { values: o } = parseArgs({
    options: { root: { type: "string" }, commit: { type: "string" }, tag: { type: "string" }, "dry-run": { type: "boolean" }, version: { type: "string" }, "notes-out": { type: "string" } },
  });
  const dryRun = Boolean(o["dry-run"]);
  if (!o.commit || dryRun === (o.tag !== undefined)) throw new Error("Usage: release-gate.mjs --commit <sha> (--tag v<version> | --dry-run [--version <version>]) [--notes-out <file>] [--root <checkout>]");
  if (o.version && !dryRun) throw new Error("--version is for a dry run; a tag's version is the one in the code.");
  const root = resolve(o.root ?? join(import.meta.dirname, ".."));
  const codeVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const version = o.version ?? codeVersion;
  const changelog = read(join(root, "CHANGELOG.md"));

  const badVersion = versionProblem({ tag: o.tag, codeVersion, version });
  const problems = [badVersion, bumpProblem(root, codeVersion), badVersion ? null : changelogProblem(changelog, version), publicKeyProblem(root), await ciProblem(o.commit, o.tag ?? process.env.GITHUB_REF_NAME ?? "main")].filter(Boolean);

  if (dryRun) for (const p of problems) console.log(`::warning title=A release would be refused::${p}`);
  else for (const p of problems) console.error(`::error title=Release refused::${p}`);
  if (problems.length && !dryRun) process.exit(1);

  // A dry run of a version no release can carry stops here: nothing could build it.
  if (badVersion) process.exit(1);
  if (o["notes-out"]) writeFileSync(o["notes-out"], (changelog && changelogSection(changelog, version)) || "");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${channelOf(version) === "beta"}\n`);
  console.log(`${dryRun ? "Dry run of" : "Releasing"} Attache ${version} (${channelOf(version) === "beta" ? "Beta, a GitHub prerelease" : "Stable, the Latest release"}).`);
}

main().catch((e) => {
  console.error(`::error title=Release gate::${e.message}`);
  process.exit(1);
});
