#!/usr/bin/env node
/**
 * Build locally installable, unsigned release artifacts:
 *   release/<version>/jarvis-<version>-macos-arm64.tar.gz        extracted release (install.sh inside)
 *   release/<version>/Jarvis-Installer-<version>-macos-arm64.command   self-extracting one-step installer
 *   release/<version>/SHA256SUMS
 *
 * The Node.js runtime is bundled (Node 24 LTS, which has SQLite FTS5 built in),
 * so end users need no developer tools. Usage: node scripts/build-release.mjs [--version x.y.z]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { releaseLauncher } from "../apps/service/src/platform/wrapper.ts";

const ROOT = resolve(import.meta.dirname, "..");
const argVersion = process.argv.includes("--version") ? process.argv[process.argv.indexOf("--version") + 1] : null;
const VERSION = argVersion ?? process.env.JARVIS_VERSION ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const NODE_VERSION = (readFileSync(join(ROOT, ".node-version"), "utf8").trim() || "24.18.0").replace(/^v/, "");
const OUT = join(ROOT, "release", VERSION);
const STAGE = join(OUT, `jarvis-${VERSION}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });

async function nodeRuntime() {
  // Prefer an official Node binary of the pinned version (fnm installs official builds);
  // otherwise download the official tarball and verify it against nodejs.org SHASUMS256.
  const cacheDir = join(ROOT, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `node-v${NODE_VERSION}-darwin-arm64`, "bin", "node");
  if (existsSync(cached)) return cached;
  const name = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
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
  run("/usr/bin/tar", ["-xzf", tgz, "-C", cacheDir]);
  return cached;
}

async function main() {
  console.log(`Building Jarvis ${VERSION} (Node ${NODE_VERSION})`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  run(process.execPath, [join(ROOT, "apps/service/build.mjs")], { env: { ...process.env, JARVIS_VERSION: VERSION } });
  run("npx", ["vite", "build"], { cwd: join(ROOT, "apps/web") });

  const node = await nodeRuntime();
  const nodeV = execFileSync(node, ["--version"]).toString().trim();
  if (nodeV !== `v${NODE_VERSION}`) throw new Error(`bundled runtime is ${nodeV}, expected v${NODE_VERSION}`);
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
  const launcher = releaseLauncher("macos");
  mkdirSync(join(STAGE, "bin"), { recursive: true });
  writeFileSync(join(STAGE, launcher.path), launcher.text);
  chmodSync(join(STAGE, launcher.path), launcher.mode);
  for (const f of ["install.sh", "uninstall.sh"]) {
    copyFileSync(join(ROOT, "installer", f), join(STAGE, f));
    chmodSync(join(STAGE, f), 0o755);
  }
  writeFileSync(join(STAGE, "VERSION"), VERSION);
  writeFileSync(join(STAGE, "README.txt"), `Jarvis ${VERSION}\n\nInstall: double-click Jarvis-Installer-${VERSION}-macos-arm64.command, or run ./install.sh from this folder.\nThe installer bundles its own Node.js runtime (${nodeV}); no developer tools are needed.\nUninstall: ~/.local/bin/jarvis-uninstall (keeps your data unless --delete-data).\n`);

  const tarName = `jarvis-${VERSION}-macos-arm64.tar.gz`;
  const tarPath = join(OUT, tarName);
  run("/usr/bin/tar", ["-czf", tarPath, "-C", OUT, `jarvis-${VERSION}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

  // Self-extracting installer: a shell header followed by the tarball bytes.
  const cmdName = `Jarvis-Installer-${VERSION}-macos-arm64.command`;
  const cmdPath = join(OUT, cmdName);
  const header = `#!/bin/sh
# Jarvis ${VERSION} installer for macOS (Apple silicon). Double-click, or run: sh "${cmdName}"
set -eu
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/jarvis-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LINE=$(awk '/^__JARVIS_PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$LINE" "$0" | /usr/bin/tar -xzf - -C "$WORK"
/bin/sh "$WORK/jarvis-${VERSION}/install.sh"
STATUS=$?
exit $STATUS
__JARVIS_PAYLOAD__
`;
  writeFileSync(cmdPath, header);
  appendFileSync(cmdPath, readFileSync(tarPath));
  chmodSync(cmdPath, 0o755);

  const lines = [];
  for (const f of [tarName, cmdName]) lines.push(`${await sha256(join(OUT, f))}  ${f}`);
  writeFileSync(join(OUT, "SHA256SUMS"), lines.join("\n") + "\n");
  rmSync(STAGE, { recursive: true, force: true });
  for (const f of [tarName, cmdName, "SHA256SUMS"]) console.log(`  ${join(OUT, f)}  ${(statSync(join(OUT, f)).size / 1_048_576).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
