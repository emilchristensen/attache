/**
 * The computers a Jarvis release is built for. Each target bundles the
 * official Node.js build for that operating system and processor, and ships
 * a one-step installer that unpacks the release and runs its installer:
 * `install.sh` on macOS and Linux, `install.ps1` on Windows.
 */
/**
 * The Node.js runtime every release bundles: one exact version, chosen for the product (spec #5 §3)
 * and changed on purpose. Development runs on any Node from `engines.node` in package.json, and this
 * version must be one of those (scripts/test/node-version.test.mjs).
 */
export const BUNDLED_NODE_VERSION = "24.22.2";

export const RELEASE_TARGETS = {
  "macos-arm64": {
    os: "macos",
    nodeDist: "darwin-arm64",
    label: "macOS (Apple silicon)",
    tar: "/usr/bin/tar",
    archive: "tar.gz",
    installer: (version) => `Jarvis-Installer-${version}-macos-arm64.command`,
    howToInstall: (installer) => `double-click ${installer}, or run ./install.sh from this folder`,
    uninstall: "~/.local/bin/jarvis-uninstall",
  },
  "linux-x64": {
    os: "linux",
    nodeDist: "linux-x64",
    label: "Linux (x86_64)",
    tar: "tar",
    archive: "tar.gz",
    installer: (version) => `Jarvis-Installer-${version}-linux-x64.sh`,
    howToInstall: (installer) => `run sh ${installer}, or run ./install.sh from this folder`,
    uninstall: "~/.local/bin/jarvis-uninstall",
  },
  "windows-x64": {
    os: "windows",
    nodeDist: "win-x64",
    label: "Windows (x86_64)",
    archive: "zip",
    installer: (version) => `Jarvis-Installer-${version}-windows-x64.cmd`,
    howToInstall: (installer) => `double-click ${installer}, or double-click install.cmd in this folder`,
    uninstall: "%LOCALAPPDATA%\\Jarvis\\bin\\jarvis-uninstall.cmd",
  },
};

/** The release archive of a target: a tarball for macOS and Linux, a zip for Windows. */
export const releaseArchive = (version, target) => `jarvis-${version}-${target}.${RELEASE_TARGETS[target].archive}`;

/** The target matching this computer, or null when Jarvis has no release for it. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  return null;
}

/** The target named on the command line, else this computer's. */
export function chooseTarget(name) {
  const target = name ?? hostTarget();
  if (!target) throw new Error(`There is no Jarvis release for ${process.platform}/${process.arch}. Pass --target ${Object.keys(RELEASE_TARGETS).join("|")}.`);
  if (!RELEASE_TARGETS[target]) throw new Error(`Unknown release target ${target}. Targets: ${Object.keys(RELEASE_TARGETS).join(", ")}.`);
  // A Windows file system has no executable bit, which the macOS and Linux releases need on their programs.
  if (process.platform === "win32" && RELEASE_TARGETS[target].os !== "windows") throw new Error(`Build the ${RELEASE_TARGETS[target].label} release on macOS or Linux: Windows cannot mark its programs executable.`);
  return target;
}
