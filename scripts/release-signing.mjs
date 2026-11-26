#!/usr/bin/env node
/**
 * The release signing tool (ADR 0007). It runs the same signing and
 * verification code as the release build and the installed service
 * (`apps/service/src/release/`), so a release it verifies is one Attache accepts.
 *
 *   node scripts/release-signing.mjs keygen <private-key.pem> <public-key.pem>
 *       make a key pair; never overwrites a key that exists
 *   node scripts/release-signing.mjs sign <manifest.json> --key <private-key.pem>
 *       write <manifest.json>.sig, a detached Ed25519 signature over the manifest's exact bytes
 *   node scripts/release-signing.mjs seal <release-folder> --version x.y.z --key <private-key.pem> --public-key <public-key.pem>
 *         [--notes <notes.md>] [--next-public-key <public-key.pem>]
 *       seal archives built with `build-release.mjs --unsealed`: write the manifest of every archive in the folder,
 *       sign it, and write the one-step installers and SHA256SUMS (`release-seal.mjs`); the release workflow's
 *       signing job runs this, so the signing key never reaches the job that builds
 *   node scripts/release-signing.mjs verify <release-folder> --public-key <public-key.pem> [--version x.y.z] [--targets <t1,t2,...>]
 *       check the manifest's signature, then every artifact it names against its size and SHA-256;
 *       with --targets, also that the release has each of those targets
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateReleaseKeyPair, signBytes } from "../apps/service/src/release/signature.ts";
import { verifyReleaseFolder } from "../apps/service/src/release/verify-release.ts";
import { sealRelease } from "./release-seal.mjs";

const USAGE = "Usage: release-signing.mjs keygen <private-key.pem> <public-key.pem> | sign <manifest.json> --key <private-key.pem> | seal <release-folder> --version x.y.z --key <private-key.pem> --public-key <public-key.pem> [--notes <notes.md>] [--next-public-key <public-key.pem>] | verify <release-folder> --public-key <public-key.pem> [--version x.y.z] [--targets <t1,t2,...>]";
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const required = (name) => option(name) ?? fail(`--${name} is missing. ${USAGE}`);

function fail(message) {
  throw new Error(message);
}

function keygen([privateFile, publicFile]) {
  if (!privateFile || !publicFile) fail(USAGE);
  for (const f of [privateFile, publicFile]) if (existsSync(f)) fail(`${f} already exists; the tool never overwrites a key.`);
  const { privateKey, publicKey } = generateReleaseKeyPair();
  writeFileSync(privateFile, privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(publicFile, publicKey, { flag: "wx" });
  console.log(`Signing key: ${privateFile} (keep it secret)\nPublic key: ${publicFile}`);
}

function signCmd([manifest]) {
  if (!manifest) fail(USAGE);
  writeFileSync(`${manifest}.sig`, signBytes(readFileSync(manifest), readFileSync(required("key"), "utf8")));
  console.log(`Signed ${manifest}: ${manifest}.sig`);
}

/** A key or notes file named by an option, as text; a key file must hold something, as an unset workflow secret would not. */
function optionFile(name, { key }) {
  const file = option(name);
  if (file === undefined) return undefined;
  const text = readFileSync(file, "utf8");
  if (key && !text.trim()) fail(`--${name} ${file} is empty: give the key file itself.`);
  return text;
}

async function sealCmd([folder]) {
  if (!folder) fail(USAGE);
  const version = required("version");
  required("key");
  required("public-key");
  const notes = optionFile("notes", { key: false });
  const nextPublicKey = optionFile("next-public-key", { key: true });
  const { manifest, targets } = await sealRelease({ folder, version, signingKey: optionFile("key", { key: true }), publicKey: optionFile("public-key", { key: true }), ...(notes !== undefined ? { notes } : {}), ...(nextPublicKey ? { nextPublicKey } : {}) });
  console.log(`Sealed Attache ${version} for ${targets.join(", ")}: ${manifest}`);
}

async function verifyCmd([folder]) {
  if (!folder) fail(USAGE);
  const version = option("version");
  const targets = option("targets")?.split(",").filter(Boolean);
  const { manifest, artifacts } = await verifyReleaseFolder(folder, { trustedKeys: [readFileSync(required("public-key"), "utf8")], ...(version ? { version } : {}), ...(targets ? { targets } : {}) });
  const channel = manifest.channel === "beta" ? "Beta" : "Stable";
  console.log(`Attache ${manifest.version} (${channel}) is signed with this key, and its artifacts match:`);
  for (const [target, a] of Object.entries(artifacts)) console.log(`  ${target}  ${a.name}  ${a.size} bytes  sha256 ${a.sha256}`);
  if (manifest.nextPublicKey) console.log("It names the next public key.");
}

const commands = { keygen, sign: signCmd, seal: sealCmd, verify: verifyCmd };
const command = commands[argv[0]];
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
Promise.resolve()
  .then(() => (command ? command(positional) : fail(USAGE)))
  .catch((e) => {
    console.error(`release-signing: ${e.message}`);
    process.exit(1);
  });
