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
 *   node scripts/release-signing.mjs verify <release-folder> --public-key <public-key.pem> [--version x.y.z]
 *       check the manifest's signature, then every artifact it names against its size and SHA-256
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateReleaseKeyPair, signBytes } from "../apps/service/src/release/signature.ts";
import { verifyReleaseFolder } from "../apps/service/src/release/verify-release.ts";

const USAGE = "Usage: release-signing.mjs keygen <private-key.pem> <public-key.pem> | sign <manifest.json> --key <private-key.pem> | verify <release-folder> --public-key <public-key.pem> [--version x.y.z]";
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

async function verifyCmd([folder]) {
  if (!folder) fail(USAGE);
  const version = option("version");
  const { manifest, artifacts } = await verifyReleaseFolder(folder, { trustedKeys: [readFileSync(required("public-key"), "utf8")], ...(version ? { version } : {}) });
  const channel = manifest.channel === "beta" ? "Beta" : "Stable";
  console.log(`Attache ${manifest.version} (${channel}) is signed with this key, and its artifacts match:`);
  for (const [target, a] of Object.entries(artifacts)) console.log(`  ${target}  ${a.name}  ${a.size} bytes  sha256 ${a.sha256}`);
  if (manifest.nextPublicKey) console.log("It names the next public key.");
}

const commands = { keygen, sign: signCmd, verify: verifyCmd };
const command = commands[argv[0]];
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
Promise.resolve()
  .then(() => (command ? command(positional) : fail(USAGE)))
  .catch((e) => {
    console.error(`release-signing: ${e.message}`);
    process.exit(1);
  });
