/**
 * The computers a Jarvis release is built for. Each target bundles the
 * official Node.js build for that operating system and processor, and ships
 * a self-extracting installer that runs `install.sh` from the release.
 */
export const RELEASE_TARGETS = {
  "macos-arm64": {
    os: "macos",
    nodeDist: "darwin-arm64",
    label: "macOS (Apple silicon)",
    tar: "/usr/bin/tar",
    installer: (version) => `Jarvis-Installer-${version}-macos-arm64.command`,
    howToInstall: (installer) => `double-click ${installer}, or run ./install.sh from this folder`,
  },
  "linux-x64": {
    os: "linux",
    nodeDist: "linux-x64",
    label: "Linux (x86_64)",
    tar: "tar",
    installer: (version) => `Jarvis-Installer-${version}-linux-x64.sh`,
    howToInstall: (installer) => `run sh ${installer}, or run ./install.sh from this folder`,
  },
};

/** The release tarball of a target. */
export const releaseTarball = (version, target) => `jarvis-${version}-${target}.tar.gz`;

/** The target matching this computer, or null when Jarvis has no release for it. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

/** The target named on the command line, else this computer's. */
export function chooseTarget(name) {
  const target = name ?? hostTarget();
  if (!target) throw new Error(`There is no Jarvis release for ${process.platform}/${process.arch}. Pass --target ${Object.keys(RELEASE_TARGETS).join("|")}.`);
  if (!RELEASE_TARGETS[target]) throw new Error(`Unknown release target ${target}. Targets: ${Object.keys(RELEASE_TARGETS).join(", ")}.`);
  return target;
}
