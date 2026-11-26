import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "../run.ts";
import type { PlatformLocations } from "../locations.ts";
import { REFUSED_TO_START_FILE, type ServiceManager, type ServiceSpec } from "./types.ts";
import { replaceWith } from "../replace-file.ts";
import { sleep, waitUntil } from "../wait.ts";
import { escapeXml } from "../xml.ts";

const LAUNCHCTL = "/bin/launchctl";
const STOP_WAIT_MS = 10_000;
const BOOTSTRAP_ATTEMPTS = 6;

/** The LaunchAgent: starts at login, restarts when it stops unless it refused to start, runs the bundled runtime through the stable `current` link. */
export function launchAgentPlist(label: string, home: string, spec: ServiceSpec): string {
  const p = escapeXml;
  const current = join(spec.installPrefix, "current");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${p(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${p(join(current, "runtime/node"))}</string>
    <string>${p(join(current, "service/attache-service.mjs"))}</string>
    <string>serve</string>
    <string>--port</string><string>${spec.port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATTACHE_STATE_DIR</key><string>${p(spec.stateDir)}</string>
    <key>ATTACHE_INSTANCE</key><string>${p(spec.instance)}</string>
    <key>ATTACHE_WEB_DIR</key><string>${p(join(current, "web"))}</string>
    <key>HOME</key><string>${p(home)}</string>
    <key>PATH</key><string>${p(`${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>${spec.releaseFeedUrl ? `
    <key>ATTACHE_RELEASE_FEED_URL</key><string>${p(spec.releaseFeedUrl)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>PathState</key><dict><key>${p(join(spec.stateDir, REFUSED_TO_START_FILE))}</key><false/></dict></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${p(join(spec.stateDir, "logs/launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${p(join(spec.stateDir, "logs/launchd.err.log"))}</string>
</dict>
</plist>
`;
}

/** A launchd agent in the owner's GUI session (`gui/<uid>`). */
export class LaunchdServiceManager implements ServiceManager {
  readonly name: string;
  readonly definition: string;
  private readonly loc: PlatformLocations;
  private readonly domain: string;

  constructor(loc: PlatformLocations, label: string) {
    this.loc = loc;
    this.name = label;
    this.definition = join(loc.serviceDefinitionDir!, `${label}.plist`);
    this.domain = `gui/${process.getuid?.() ?? 0}`;
  }

  async install(spec: ServiceSpec): Promise<void> {
    mkdirSync(this.loc.serviceDefinitionDir!, { recursive: true });
    const tmp = join(this.loc.serviceDefinitionDir!, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, launchAgentPlist(this.name, this.loc.home, spec));
    replaceWith(tmp, this.definition);
  }

  async loaded(): Promise<boolean> {
    return (await run(LAUNCHCTL, ["print", `${this.domain}/${this.name}`])).code === 0;
  }

  async start(): Promise<void> {
    if (!existsSync(this.definition)) throw new Error(`Attache is not set up as a background service here: ${this.definition} is missing. Run the Attache installer again.`);
    if (!(await this.loaded())) {
      // Starting is a new attempt: a refusal from before must not keep launchd from running it (KeepAlive's PathState
      // also holds RunAtLoad back). If it refuses again, the service writes the file again and launchd leaves it stopped.
      const stateDir = await this.stateDir();
      if (stateDir) rmSync(join(stateDir, REFUSED_TO_START_FILE), { force: true });
      // launchd can refuse a bootstrap for a moment after a bootout; retry briefly.
      for (let attempt = 1; ; attempt++) {
        const r = await run(LAUNCHCTL, ["bootstrap", this.domain, this.definition]);
        // RunAtLoad has started it. A kickstart now would start it a second time, past KeepAlive:
        // a service that already refused to start would run again.
        if (r.code === 0) return;
        if (attempt >= BOOTSTRAP_ATTEMPTS) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.code}`}`);
        await sleep(1000);
      }
    }
    await run(LAUNCHCTL, ["kickstart", "-k", `${this.domain}/${this.name}`]);
  }

  /** The state folder the agent runs with, as its definition says (`ATTACHE_STATE_DIR`), or null when it cannot be read. */
  private async stateDir(): Promise<string | null> {
    const r = await run("/usr/bin/plutil", ["-extract", "EnvironmentVariables.ATTACHE_STATE_DIR", "raw", "-o", "-", this.definition]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async stop(): Promise<void> {
    const r = await run(LAUNCHCTL, ["bootout", `${this.domain}/${this.name}`]);
    if (!(await waitUntil(async () => !(await this.loaded()), STOP_WAIT_MS))) throw new Error(`launchctl bootout failed: ${r.stderr.trim() || "the service is still loaded"}`);
  }

  async uninstall(): Promise<void> {
    await this.stop();
    rmSync(this.definition, { force: true });
  }
}
