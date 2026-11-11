import { spawn } from "node:child_process";
import { launchTool } from "./launch.ts";
import type { Os } from "./os.ts";

const OPENERS: Readonly<Record<Os, (url: string) => [string, string[]]>> = {
  macos: (url) => ["/usr/bin/open", [url]],
  linux: (url) => ["xdg-open", [url]],
  // rundll32 hands the URL to the default browser without going through cmd.exe's parsing.
  windows: (url) => ["rundll32", ["url.dll,FileProtocolHandler", url]],
};

/** Open a URL in the owner's default browser. Best effort: a missing opener is ignored, the URL is printed anyway. */
export function openUrl(os: Os, url: string): void {
  const [cmd, args] = OPENERS[os](url);
  let launch;
  try {
    launch = launchTool(cmd, args, os);
  } catch {
    return;
  }
  const child = spawn(launch.command, launch.args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
