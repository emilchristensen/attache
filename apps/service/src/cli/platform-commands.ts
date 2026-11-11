import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaths } from "../core/paths.ts";
import { currentOs } from "../platform/os.ts";
import { platformLocations, type PlatformLocations } from "../platform/locations.ts";
import { HARNESS_FILES, harnessInstalls, harnessMcpConfigs, type HarnessKind } from "../platform/harness-locations.ts";
import { serviceManagerFor } from "../platform/service-manager/index.ts";
import { superviseService } from "../platform/service-manager/supervisor.ts";
import { clearSecrets, createSecretStore } from "../platform/secret-store/index.ts";
import { commandWrappers, type WrapperSpec } from "../platform/wrapper.ts";
import { replaceWith } from "../platform/replace-file.ts";

/**
 * Commands the installer and uninstaller run, so that everything that
 * differs per operating system stays in the platform modules instead of in
 * shell scripts.
 */
export interface PlatformCliIo {
  out(line: string): void;
  arg(name: string): string | undefined;
  defaultPort: number;
}

/** Instance names go into service names, task names and wrappers, so they keep to letters, digits, `.`, `_` and `-`. */
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function instance(): string {
  const name = process.env.JARVIS_INSTANCE ?? "default";
  if (!INSTANCE_NAME.test(name)) throw new Error(`JARVIS_INSTANCE must be letters, digits, ".", "_" or "-", not ${JSON.stringify(name)}`);
  return name;
}

/** A TCP port from the command line; 0 (any free port) only where `anyPort` allows it. */
function portNumber(value: string | undefined, anyPort: boolean): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < (anyPort ? 0 : 1) || port > 65535) throw new Error(`--port must be a TCP port number, not ${value}`);
  return port;
}

/** Install prefix, state folder and port from the flags, falling back to this platform's defaults. */
function installSpec(io: PlatformCliIo, loc: PlatformLocations): WrapperSpec {
  const installPrefix = io.arg("prefix") ?? loc.installPrefix;
  const port = portNumber(io.arg("port") ?? process.env.JARVIS_PORT ?? String(io.defaultPort), false);
  return { installPrefix, stateDir: io.arg("state-dir") ?? process.env.JARVIS_STATE_DIR ?? loc.stateDir, instance: instance(), port };
}

const RUN_USAGE = "Usage: jarvis service run --port <n> --state-dir <path> --instance <name> --home <path> [--local-app-data <path>] [--app-data <path>]";

/** `jarvis service run`, what the Windows logon task starts: keeps `jarvis serve` running until it is stopped. */
function runSupervised(io: PlatformCliIo): Promise<void> {
  const need = (name: string) => {
    const value = io.arg(name);
    if (!value) throw new Error(RUN_USAGE);
    return value;
  };
  const script = process.argv[1];
  if (!script) throw new Error("jarvis service run cannot tell which script it runs from");
  process.env.JARVIS_INSTANCE = need("instance");
  const localAppData = io.arg("local-app-data");
  const appData = io.arg("app-data");
  return superviseService({
    script,
    port: portNumber(need("port"), true),
    stateDir: need("state-dir"),
    instance: instance(),
    home: need("home"),
    ...(localAppData ? { localAppData } : {}),
    ...(appData ? { appData } : {}),
  });
}

/** `jarvis start|stop` and `jarvis service install|start|stop|uninstall|status|run`. */
export async function serviceCommand(sub: string | undefined, io: PlatformCliIo): Promise<void> {
  if (sub === "run") return runSupervised(io);
  const loc = platformLocations();
  const manager = serviceManagerFor(loc, instance());
  switch (sub) {
    case "install": {
      await manager.install(installSpec(io, loc));
      return io.out(`Jarvis background service ${manager.name} set up${manager.definition ? ` in ${manager.definition}` : ""}.`);
    }
    case "start":
      await manager.start();
      return io.out("Jarvis service started.");
    case "stop":
      await manager.stop();
      return io.out("Jarvis service stopped. Start it again with: jarvis start");
    case "uninstall":
      await manager.uninstall();
      return io.out(`Jarvis background service ${manager.name} removed.`);
    case "status":
      return io.out(JSON.stringify({ name: manager.name, definition: manager.definition, loaded: await manager.loaded() }));
    default:
      throw new Error("Usage: jarvis service install|start|stop|uninstall|status [--prefix <path>] [--state-dir <path>] [--port <n>]");
  }
}

function writeExecutable(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${dirname(path)}/.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  replaceWith(tmp, path);
}

/** `jarvis wrappers install|uninstall`: the `jarvis` and `jarvis-uninstall` commands on the owner's PATH. */
export async function wrappersCommand(sub: string | undefined, io: PlatformCliIo): Promise<void> {
  const loc = platformLocations();
  const files = commandWrappers(loc, installSpec(io, loc));
  if (sub === "install") {
    for (const f of files) writeExecutable(f.path, f.text, f.mode);
    return io.out(JSON.stringify(files.map((f) => f.path)));
  }
  if (sub === "uninstall") {
    for (const f of files) rmSync(f.path, { force: true });
    return io.out(JSON.stringify(files.map((f) => f.path)));
  }
  throw new Error("Usage: jarvis wrappers install|uninstall [--prefix <path>] [--state-dir <path>] [--port <n>]");
}

/** `jarvis credentials clear`: delete every secret this install stored, from whichever secret store holds them. */
export async function credentialsCommand(sub: string | undefined, io: PlatformCliIo): Promise<void> {
  if (sub !== "clear") throw new Error("Usage: jarvis credentials clear [--state-dir <path>]");
  const paths = resolvePaths(io.arg("state-dir"));
  const store = createSecretStore({ os: currentOs(), stateDir: paths.stateDir, secretsFile: paths.secretsFile, instance: instance() });
  const removed = await clearSecrets(store);
  io.out(JSON.stringify({ store: store.kind, removed }));
}

/** Everything `platform/` resolves for this operating system, as JSON; with a key, just that value (for installer scripts). */
export function pathsReport(loc: PlatformLocations = platformLocations()) {
  const installs = harnessInstalls(loc);
  const mcp = harnessMcpConfigs(loc.os);
  const harnesses = Object.fromEntries((Object.keys(HARNESS_FILES) as HarnessKind[]).map((k) => [k, { ...HARNESS_FILES[k], mcpFile: mcp[k].file, mcpFormat: mcp[k].format, ...installs[k] }]));
  return { ...loc, harnesses };
}

export function pathsCommand(key: string | undefined, io: PlatformCliIo): void {
  const report = pathsReport();
  if (!key) return io.out(JSON.stringify(report, null, 2));
  const value = (report as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`Unknown path ${key}. Paths: ${Object.entries(report).filter(([, v]) => typeof v === "string").map(([k]) => k).join(", ")}`);
  io.out(value);
}
