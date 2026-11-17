#!/usr/bin/env node
/**
 * Build locally installable, unsigned release artifacts for one target
 * (`scripts/release-targets.mjs`), by default this computer's:
 *   release/<version>/attache-<version>-<target>.tar.gz   extracted release, macOS and Linux (install.sh inside)
 *   release/<version>/attache-<version>-windows-x64.zip   extracted release, Windows (install.cmd inside)
 *   release/<version>/Attache-Installer-<version>-macos-arm64.command   one-step installer (macOS)
 *   release/<version>/Attache-Installer-<version>-linux-x64.sh          one-step installer (Linux)
 *   release/<version>/Attache-Installer-<version>-windows-x64.cmd       one-step installer (Windows)
 *   release/<version>/SHA256SUMS                         every artifact in the folder
 *
 * The Node.js runtime is bundled (BUNDLED_NODE_VERSION in release-targets.mjs; Node 24 LTS has SQLite FTS5 built in),
 * so end users need no developer tools. macOS and Linux build every target;
 * Windows builds its own.
 * Usage: node scripts/build-release.mjs [--version x.y.z] [--target macos-arm64|linux-x64|windows-x64]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { releaseLauncher } from "../apps/service/src/platform/wrapper.ts";
import { posixInstallerHeader, windowsInstallerHeader, WINDOWS_INSTALL_CMD } from "./release-installers.mjs";
import { BUNDLED_NODE_VERSION, chooseTarget, hostTarget, releaseArchive, RELEASE_TARGETS } from "./release-targets.mjs";
import { zipFolder } from "./zip.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
const VERSION = arg("version") ?? process.env.ATTACHE_VERSION ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const TARGET = chooseTarget(arg("target"));
const T = RELEASE_TARGETS[TARGET];
const WINDOWS = T.os === "windows";
const NODE_VERSION = BUNDLED_NODE_VERSION;
const OUT = join(ROOT, "release", VERSION);
const STAGE = join(OUT, `.stage-${TARGET}`, `attache-${VERSION}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * The official Node binary of the pinned version for the target, downloaded once and checked against nodejs.org SHASUMS256:
 * from the tarball on macOS and Linux, and as the published `win-x64/node.exe` for Windows.
 */
async function nodeRuntime() {
  const cacheDir = join(ROOT, ".cache");
  const dist = `node-v${NODE_VERSION}-${T.nodeDist}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const cached = WINDOWS ? join(cacheDir, dist, "node.exe") : join(cacheDir, dist, "bin", "node");
  if (existsSync(cached)) return cached;
  mkdirSync(dirname(cached), { recursive: true });
  const name = WINDOWS ? `${T.nodeDist}/node.exe` : `${dist}.tar.gz`;
  const file = WINDOWS ? `${cached}.download` : join(cacheDir, name);
  if (!existsSync(file)) await download(`${base}/${name}`, file);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${name}`))?.split(/\s+/)[0];
  const actual = await sha256(file);
  if (!expected || expected !== actual) {
    rmSync(file, { force: true });
    throw new Error(`checksum mismatch for ${name}`);
  }
  if (WINDOWS) copyFileSync(file, cached);
  else run("tar", ["-xzf", file, "-C", cacheDir, `${dist}/bin/node`]);
  return cached;
}

/** The web app's production build, with this repository's Vite, on any host (no `npx`, which is a batch file on Windows). */
function buildWeb() {
  const web = join(ROOT, "apps/web");
  const vite = join(dirname(createRequire(join(web, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  run(process.execPath, [vite, "build"], { cwd: web });
}

/** The installer, uninstaller and README the release carries for its operating system. */
function stageInstallers(installerName) {
  if (WINDOWS) {
    for (const f of ["install.ps1", "uninstall.ps1"]) copyFileSync(join(ROOT, "installer", f), join(STAGE, f));
    writeFileSync(join(STAGE, "install.cmd"), WINDOWS_INSTALL_CMD);
  } else {
    for (const f of ["install.sh", "uninstall.sh"]) {
      copyFileSync(join(ROOT, "installer", f), join(STAGE, f));
      chmodSync(join(STAGE, f), 0o755);
    }
  }
  const eol = WINDOWS ? "\r\n" : "\n";
  const readme = [`Attache ${VERSION} for ${T.label}`, "", `Install: ${T.howToInstall(installerName)}.`, `The installer bundles its own Node.js runtime (v${NODE_VERSION}); no developer tools are needed.`, `Uninstall: ${T.uninstall} (keeps your data unless --delete-data).`, ""];
  writeFileSync(join(STAGE, "README.txt"), readme.join(eol));
}

/** Pack the staged release: a tarball for macOS and Linux, a zip for Windows. */
function packArchive(archivePath) {
  if (WINDOWS) return zipFolder(STAGE, `attache-${VERSION}`, archivePath);
  // No macOS extended attributes (GNU tar warns about each one) and no builder's user id in the archive.
  const portable = process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"] : ["--owner=0", "--group=0", "--numeric-owner"];
  run("tar", [...portable, "-czf", archivePath, "-C", join(STAGE, ".."), `attache-${VERSION}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

async function main() {
  console.log(`Building Attache ${VERSION} for ${T.label} (Node ${NODE_VERSION})`);
  const archiveName = releaseArchive(VERSION, TARGET);
  const installerName = T.installer(VERSION);
  mkdirSync(OUT, { recursive: true });
  for (const f of [archiveName, installerName, ".stage-" + TARGET]) rmSync(join(OUT, f), { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  run(process.execPath, [join(ROOT, "apps/service/build.mjs")], { env: { ...process.env, ATTACHE_VERSION: VERSION } });
  buildWeb();

  const node = await nodeRuntime();
  // A runtime for another computer cannot run here; its version is then the one its checksum vouched for.
  if (hostTarget() === TARGET) {
    const nodeV = execFileSync(node, ["--version"]).toString().trim();
    if (nodeV !== `v${NODE_VERSION}`) throw new Error(`bundled runtime is ${nodeV}, expected v${NODE_VERSION}`);
  }
  const runtime = join(STAGE, "runtime", WINDOWS ? "node.exe" : "node");
  mkdirSync(dirname(runtime), { recursive: true });
  copyFileSync(node, runtime);
  chmodSync(runtime, 0o755);
  mkdirSync(join(STAGE, "service"), { recursive: true });
  copyFileSync(join(ROOT, "apps/service/dist/attache-service.mjs"), join(STAGE, "service/attache-service.mjs"));
  copyFileSync(join(ROOT, "apps/service/dist/attache-agent-hook.mjs"), join(STAGE, "service/attache-agent-hook.mjs"));
  // ONNX Runtime's WebAssembly files, loaded from the bundle's folder to run the meaning model; the same on every platform.
  for (const f of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) copyFileSync(join(ROOT, "apps/service/dist", f), join(STAGE, "service", f));
  cpSync(join(ROOT, "apps/web/dist"), join(STAGE, "web"), { recursive: true, filter: (s) => !s.endsWith(".map") });
  // The launcher text is resolved per operating system with the rest of the platform code.
  const launcher = releaseLauncher(T.os);
  mkdirSync(join(STAGE, "bin"), { recursive: true });
  writeFileSync(join(STAGE, launcher.path), launcher.text);
  chmodSync(join(STAGE, launcher.path), launcher.mode);
  stageInstallers(installerName);
  writeFileSync(join(STAGE, "VERSION"), VERSION);
  // The installer refuses to run on any other kind of computer.
  writeFileSync(join(STAGE, "TARGET"), TARGET);

  const archivePath = join(OUT, archiveName);
  packArchive(archivePath);
  rmSync(join(OUT, ".stage-" + TARGET), { recursive: true, force: true });

  const installerPath = join(OUT, installerName);
  const header = { version: VERSION, label: T.label, installer: installerName, tar: T.tar };
  writeFileSync(installerPath, WINDOWS ? windowsInstallerHeader(header) : posixInstallerHeader(header));
  appendFileSync(installerPath, readFileSync(archivePath));
  chmodSync(installerPath, 0o755);

  // Checksums cover every target built into this folder so far.
  const artifacts = readdirSync(OUT).filter((f) => /\.(tar\.gz|zip|command|sh|cmd)$/.test(f)).sort();
  const lines = [];
  for (const f of artifacts) lines.push(`${await sha256(join(OUT, f))}  ${f}`);
  writeFileSync(join(OUT, "SHA256SUMS"), lines.join("\n") + "\n");
  for (const f of [archiveName, installerName, "SHA256SUMS"]) console.log(`  ${join(OUT, f)}  ${(statSync(join(OUT, f)).size / 1_048_576).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
