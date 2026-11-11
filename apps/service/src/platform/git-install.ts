import { pathFor, platformLocations, toolCandidates, type Env } from "./locations.ts";
import { currentOs, type Os } from "./os.ts";

/**
 * Every place git may be installed, in lookup order. Beyond the usual tool
 * folders, Windows looks where Git for Windows installs itself, for everyone
 * or for one user: a service started at logon keeps the PATH it started with,
 * so git installed after that is found only here.
 */
export function gitCandidates(os: Os = currentOs(), env: Env = process.env): string[] {
  const loc = platformLocations(os, env);
  const shared = toolCandidates(loc, "git");
  if (os !== "windows") return shared;
  const { join } = pathFor("windows");
  const localAppData = env.LOCALAPPDATA || join(loc.home, "AppData", "Local");
  const gitForWindows = [join(env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe"), join(localAppData, "Programs", "Git", "cmd", "git.exe")];
  return [...shared, ...gitForWindows];
}

const HOW_TO_INSTALL: Readonly<Record<Os, string>> = {
  macos: "On macOS, run `xcode-select --install` in Terminal (Apple's command line tools include git), or install it with Homebrew: `brew install git`.",
  linux: "On Linux, install it with your distribution's package manager, for example `sudo apt install git` or `sudo dnf install git`.",
  windows: "On Windows, install Git for Windows from https://git-scm.com/download/win, or run `winget install --id Git.Git -e` in a terminal.",
};

/** What the owner sees when Replication needs git and this Machine has none. */
export function gitMissingMessage(os: Os = currentOs()): string {
  return `Replication runs git, and git is not installed on this Machine. ${HOW_TO_INSTALL[os]} Then try again.`;
}
