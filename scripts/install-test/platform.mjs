/**
 * What the install test needs to know about the operating system it runs on:
 * where the release installs in a clean home folder, and how to ask the
 * service manager about the Jarvis service (launchd on macOS, the systemd
 * user manager on Linux).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { locationsForHome, serviceName } from "../../apps/service/src/platform/locations.ts";
import { currentOs } from "../../apps/service/src/platform/os.ts";
import { hostTarget, RELEASE_TARGETS } from "../release-targets.mjs";

const succeeds = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const output = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function macos(loc, name) {
  const domain = `gui/${process.getuid()}`;
  const definition = join(loc.serviceDefinitionDir, `${name}.plist`);
  return {
    definition,
    loaded: () => succeeds("/bin/launchctl", ["print", `${domain}/${name}`]),
    /** launchd starts a LaunchAgent with RunAtLoad when the owner logs in. */
    startsAtLogin: () => existsSync(definition) && /<key>RunAtLoad<\/key><true\/>/.test(readFileSync(definition, "utf8")),
    /** Whether the service manager still knows the service at all. */
    known: () => existsSync(definition) || succeeds("/bin/launchctl", ["print", `${domain}/${name}`]),
    cleanup: () => succeeds("/bin/launchctl", ["bootout", `${domain}/${name}`]),
    /** Service definitions of this instance in the owner's LaunchAgents folder. */
    definitions: () => (existsSync(loc.serviceDefinitionDir) ? readdirSync(loc.serviceDefinitionDir).filter((f) => f.startsWith(`${name}.`)) : []),
    ownerFiles: { "Library/LaunchAgents/com.example.owner.plist": "<plist><dict><key>Label</key><string>com.example.owner</string></dict></plist>\n" },
    /** The owner's own brains and schedules on this Mac must not change while the test runs. */
    machineFingerprint: () => {
      const git = (dir, args) => output("/usr/bin/git", ["-C", dir, ...args]) || "n/a";
      const brain = (dir) => `${git(dir, ["rev-parse", "HEAD"])} ${createHash("sha256").update(git(dir, ["status", "--porcelain"])).digest("hex").slice(0, 12)}`;
      const agents = output("/bin/launchctl", ["list"]).split("\n").filter((l) => /second-?brain/i.test(l)).map((l) => l.split("\t").pop()).sort().join(",");
      const plistDir = join(homedir(), "Library/LaunchAgents");
      const plists = existsSync(plistDir) ? readdirSync(plistDir).filter((f) => /second-?brain|brain/i.test(f)).map((f) => `${f}:${createHash("sha256").update(readFileSync(join(plistDir, f))).digest("hex").slice(0, 12)}`).sort().join(",") : "";
      return { newBrain: brain(join(homedir(), "old-notes")), oldBrain: brain(join(homedir(), "OldNotes")), agents, plists };
    },
  };
}

function linux(loc, name) {
  const definition = join(loc.serviceDefinitionDir, name);
  // The test's clean profile has no XDG_RUNTIME_DIR; the owner's user manager lives at the standard place.
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` };
  const systemctl = (args) => {
    try {
      return { ok: true, out: execFileSync("systemctl", ["--user", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? "").trim() };
    }
  };
  return {
    definition,
    loaded: () => ["active", "activating", "reloading"].includes(systemctl(["show", name, "--property=ActiveState", "--value"]).out),
    /** A user unit enabled for default.target starts when the owner's user manager starts, at login. */
    startsAtLogin: () => systemctl(["is-enabled", name]).out === "enabled" && systemctl(["show", name, "--property=WantedBy", "--value"]).out.split(/\s+/).includes("default.target"),
    known: () => existsSync(definition) || !["", "not-found"].includes(systemctl(["is-enabled", name]).out),
    cleanup: () => {
      systemctl(["stop", name]);
      systemctl(["disable", name]);
    },
    definitions: () => (existsSync(loc.serviceDefinitionDir) ? readdirSync(loc.serviceDefinitionDir).filter((f) => f === name || f.startsWith(`${name}.`)) : []),
    ownerFiles: { ".config/systemd/user/owner-backup.service": "[Service]\nExecStart=/bin/true\n" },
    machineFingerprint: () => ({}),
  };
}

/** The install test's view of this computer, for a clean home folder and a test-only service instance. */
export function installTestPlatform(home, instance) {
  const target = hostTarget();
  if (!target) throw new Error(`The install test runs where Jarvis has a release; this is ${process.platform}/${process.arch}.`);
  const os = currentOs();
  const loc = locationsForHome(home, os, {});
  const name = serviceName(os, instance);
  const service = os === "macos" ? macos(loc, name) : linux(loc, name);
  return {
    os,
    target,
    serviceName: name,
    prefix: loc.installPrefix,
    state: loc.stateDir,
    binDir: loc.binDir,
    artifact: (root, version) => join(root, "release", version, RELEASE_TARGETS[target].installer(version)),
    ...service,
  };
}
