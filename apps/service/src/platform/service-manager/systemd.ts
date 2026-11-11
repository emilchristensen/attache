import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import { run, type RunResult } from "../run.ts";
import type { PlatformLocations } from "../locations.ts";
import type { ServiceManager, ServiceSpec } from "./types.ts";
import { replaceWith } from "../replace-file.ts";

const { join } = posix;
const SYSTEMCTL = "systemctl";
const STOP_WAIT_MS = 10_000;
/** Unit states in which systemd keeps the service running, or is about to start it again after a crash. */
const RUNNING = new Set(["active", "activating", "reloading"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function noLineBreaks(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`A Jarvis path cannot contain a line break: ${JSON.stringify(s)}`);
  return s;
}
/** systemd expands `%` specifiers in every setting, so a literal `%` is written `%%`. */
const specifiers = (s: string) => noLineBreaks(s).replace(/%/g, "%%");
const cQuoted = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
/** One ExecStart argument: quoted, with `$` doubled because systemd expands `$NAME` there. */
const execArg = (s: string) => cQuoted(specifiers(s).replace(/\$/g, "$$$$"));
const environment = (name: string, value: string) => `Environment=${cQuoted(`${name}=${specifiers(value)}`)}`;

/** The systemd user unit: starts at login, restarts after a crash, runs the bundled runtime through the stable `current` link. */
export function systemdUnit(home: string, spec: ServiceSpec): string {
  const current = join(spec.installPrefix, "current");
  const logs = join(spec.stateDir, "logs");
  return [
    "[Unit]",
    `Description=Jarvis (${noLineBreaks(spec.instance)})`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execArg(join(current, "runtime/node"))} ${execArg(join(current, "service/jarvis-service.mjs"))} serve --port ${spec.port}`,
    environment("JARVIS_STATE_DIR", spec.stateDir),
    environment("JARVIS_INSTANCE", spec.instance),
    environment("JARVIS_WEB_DIR", join(current, "web")),
    environment("HOME", home),
    environment("PATH", `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`),
    "Restart=always",
    "RestartSec=2",
    `StandardOutput=append:${specifiers(join(logs, "service.out.log"))}`,
    `StandardError=append:${specifiers(join(logs, "service.err.log"))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * `systemctl --user` finds the owner's user manager through `XDG_RUNTIME_DIR`,
 * which a login sets. Where it is missing (`su`, some SSH setups), the
 * standard location is tried.
 */
function userManagerEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  return process.env.XDG_RUNTIME_DIR || uid === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

function systemctlFailure(args: string[], r: RunResult): Error {
  const reason = r.stderr.trim().split("\n")[0] || `exit ${r.code}`;
  if (/ENOENT/.test(r.stderr)) return new Error("Jarvis runs as a systemd user service, and systemctl was not found on this computer. Jarvis needs a Linux that uses systemd.");
  if (/Failed to connect to (user scope )?bus|No medium found|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i.test(r.stderr)) {
    return new Error(`Jarvis runs as a systemd user service, and systemd could not be reached for this user (${reason}). Run the installer from your own desktop or SSH login, or turn on lingering with \`loginctl enable-linger\`, then try again.`);
  }
  return new Error(`systemctl --user ${args.join(" ")} failed: ${reason}`);
}

/** A systemd user service in the owner's user manager, enabled for `default.target` so it starts at login. */
export class SystemdServiceManager implements ServiceManager {
  readonly name: string;
  readonly definition: string;
  private readonly loc: PlatformLocations;

  constructor(loc: PlatformLocations, unitName: string) {
    this.loc = loc;
    this.name = unitName;
    this.definition = join(loc.serviceDefinitionDir!, unitName);
  }

  private systemctl(args: string[]): Promise<RunResult> {
    return run(SYSTEMCTL, ["--user", ...args], { env: userManagerEnv() });
  }

  private async must(args: string[]): Promise<void> {
    const r = await this.systemctl(args);
    if (r.code !== 0) throw systemctlFailure(args, r);
  }

  async install(spec: ServiceSpec): Promise<void> {
    const dir = this.loc.serviceDefinitionDir!;
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, systemdUnit(this.loc.home, spec));
    replaceWith(tmp, this.definition);
    // Enabling by path also links the unit in when the user manager does not
    // look in this folder (an XDG_CONFIG_HOME it does not share), and reloads it.
    await this.must(["enable", this.definition]);
  }

  async loaded(): Promise<boolean> {
    const r = await this.systemctl(["show", this.name, "--property=ActiveState", "--value"]);
    return r.code === 0 && RUNNING.has(r.stdout.trim());
  }

  async start(): Promise<void> {
    if (!existsSync(this.definition)) throw new Error(`Jarvis is not set up as a background service here: ${this.definition} is missing. Run the Jarvis installer again.`);
    await this.must(["restart", this.name]);
  }

  async stop(): Promise<void> {
    const r = await this.systemctl(["stop", this.name]);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (await this.loaded()) {
      if (Date.now() > deadline) throw r.code === 0 ? new Error(`systemd did not stop ${this.name}`) : systemctlFailure(["stop", this.name], r);
      await sleep(250);
    }
  }

  async uninstall(): Promise<void> {
    await this.stop();
    const disabled = await this.systemctl(["disable", this.name]);
    rmSync(this.definition, { force: true });
    await this.systemctl(["daemon-reload"]);
    // A unit that was never enabled, or is already gone, is not an error; an unreachable user manager is.
    if (disabled.code !== 0 && !/does not exist|not found|No such file/i.test(disabled.stderr)) throw systemctlFailure(["disable", this.name], disabled);
  }
}
