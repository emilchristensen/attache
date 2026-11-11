#!/usr/bin/env node
/**
 * Build locally installable, unsigned release artifacts for one target
 * (`scripts/release-targets.mjs`), by default this computer's:
 *   release/<version>/jarvis-<version>-<target>.tar.gz   extracted release (install.sh inside)
 *   release/<version>/Jarvis-Installer-<version>-macos-arm64.command   one-step installer (macOS)
 *   release/<version>/Jarvis-Installer-<version>-linux-x64.sh          one-step installer (Linux)
 *   release/<version>/SHA256SUMS                         every artifact in the folder
 *
 * The Node.js runtime is bundled (Node 24 LTS, which has SQLite FTS5 built in),
 * so end users need no developer tools. Any target can be built on any host.
 * Usage: node scripts/build-release.mjs [--version x.y.z] [--target macos-arm64|linux-x64]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { releaseLauncher } from "../apps/service/src/platform/wrapper.ts";
import { chooseTarget, hostTarget, releaseTarball, RELEASE_TARGETS } from "./release-targets.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const VERSION = arg("version") ?? process.env.JARVIS_VERSION ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TARGET = chooseTarget(arg("target"));
const T = RELEASE_TARGETS[TARGET];
const NODE_VERSION = (readFileSync(join(ROOT, ".node-version"), "utf8").trim() || "24.18.0").replace(/^v/, "");
const OUT = join(ROOT, "release", VERSION);
const STAGE = join(OUT, `.stage-${TARGET}`, `jarvis-${VERSION}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });

/** The official Node binary of the pinned version for the target, downloaded once and checked against nodejs.org SHASUMS256. */
async function nodeRuntime() {
  const cacheDir = join(ROOT, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const dist = `node-v${NODE_VERSION}-${T.nodeDist}`;
  const cached = join(cacheDir, dist, "bin", "node");
  if (existsSync(cached)) return cached;
  const name = `${dist}.tar.gz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const tgz = join(cacheDir, name);
  if (!existsSync(tgz)) {
    const res = await fetch(`${base}/${name}`);
    if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${name}`))?.split(/\s+/)[0];
  const actual = await sha256(tgz);
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${name}`);
  run("tar", ["-xzf", tgz, "-C", cacheDir, `${dist}/bin/node`]);
  return cached;
}

/** A shell header that unpacks the tarball appended after it and runs the release's install.sh. */
function installerHeader(installer) {
  return `#!/bin/sh
# Jarvis ${VERSION} installer for ${T.label}. Run: sh "${installer}"
set -eu
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/jarvis-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LINE=$(awk '/^__JARVIS_PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$LINE" "$0" | ${T.tar} -xzf - -C "$WORK"
/bin/sh "$WORK/jarvis-${VERSION}/install.sh"
STATUS=$?
exit $STATUS
__JARVIS_PAYLOAD__
`;
}

async function main() {
  console.log(`Building Jarvis ${VERSION} for ${T.label} (Node ${NODE_VERSION})`);
  const tarName = releaseTarball(VERSION, TARGET);
  const installerName = T.installer(VERSION);
  mkdirSync(OUT, { recursive: true });
  for (const f of [tarName, installerName, ".stage-" + TARGET]) rmSync(join(OUT, f), { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  run(process.execPath, [join(ROOT, "apps/service/build.mjs")], { env: { ...process.env, JARVIS_VERSION: VERSION } });
  run("npx", ["vite", "build"], { cwd: join(ROOT, "apps/web") });

  const node = await nodeRuntime();
  // A runtime for another computer cannot run here; its version is then the one its checksum vouched for.
  if (hostTarget() === TARGET) {
    const nodeV = execFileSync(node, ["--version"]).toString().trim();
    if (nodeV !== `v${NODE_VERSION}`) throw new Error(`bundled runtime is ${nodeV}, expected v${NODE_VERSION}`);
  }
  mkdirSync(join(STAGE, "runtime"), { recursive: true });
  copyFileSync(node, join(STAGE, "runtime/node"));
  chmodSync(join(STAGE, "runtime/node"), 0o755);
  mkdirSync(join(STAGE, "service"), { recursive: true });
  copyFileSync(join(ROOT, "apps/service/dist/jarvis-service.mjs"), join(STAGE, "service/jarvis-service.mjs"));
  copyFileSync(join(ROOT, "apps/service/dist/jarvis-agent-hook.mjs"), join(STAGE, "service/jarvis-agent-hook.mjs"));
  // ONNX Runtime's WebAssembly files, loaded from the bundle's folder to run the meaning model; the same on every platform.
  for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) copyFileSync(join(ROOT, "apps/service/dist", f), join(STAGE, "service", f));
  cpSync(join(ROOT, "apps/web/dist"), join(STAGE, "web"), { recursive: true, filter: (s) => !s.endsWith(".map") });
  // The launcher text is resolved per operating system with the rest of the platform code.
  const launcher = releaseLauncher(T.os);
  mkdirSync(join(STAGE, "bin"), { recursive: true });
  writeFileSync(join(STAGE, launcher.path), launcher.text);
  chmodSync(join(STAGE, launcher.path), launcher.mode);
  for (const f of ["install.sh", "uninstall.sh"]) {
    copyFileSync(join(ROOT, "installer", f), join(STAGE, f));
    chmodSync(join(STAGE, f), 0o755);
  }
  writeFileSync(join(STAGE, "VERSION"), VERSION);
  // install.sh refuses to run on any other kind of computer.
  writeFileSync(join(STAGE, "TARGET"), TARGET);
  writeFileSync(join(STAGE, "README.txt"), `Jarvis ${VERSION} for ${T.label}\n\nInstall: ${T.howToInstall(installerName)}.\nThe installer bundles its own Node.js runtime (v${NODE_VERSION}); no developer tools are needed.\nUninstall: ~/.local/bin/jarvis-uninstall (keeps your data unless --delete-data).\n`);

  const tarPath = join(OUT, tarName);
  // No macOS extended attributes (GNU tar warns about each one) and no builder's user id in the archive.
  const portable = process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"] : ["--owner=0", "--group=0", "--numeric-owner"];
  run("tar", [...portable, "-czf", tarPath, "-C", join(STAGE, ".."), `jarvis-${VERSION}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  rmSync(join(OUT, ".stage-" + TARGET), { recursive: true, force: true });

  const installerPath = join(OUT, installerName);
  writeFileSync(installerPath, installerHeader(installerName));
  appendFileSync(installerPath, readFileSync(tarPath));
  chmodSync(installerPath, 0o755);

  // Checksums cover every target built into this folder so far.
  const artifacts = readdirSync(OUT).filter((f) => /\.(tar\.gz|command|sh)$/.test(f)).sort();
  const lines = [];
  for (const f of artifacts) lines.push(`${await sha256(join(OUT, f))}  ${f}`);
  writeFileSync(join(OUT, "SHA256SUMS"), lines.join("\n") + "\n");
  for (const f of [tarName, installerName, "SHA256SUMS"]) console.log(`  ${join(OUT, f)}  ${(statSync(join(OUT, f)).size / 1_048_576).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
