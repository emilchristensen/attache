import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { locationsForHome } from "../platform/locations.ts";
import { PI_AGENT_DIR, piInstall } from "../platform/harness-locations.ts";
import { HooksFileError, replaceFile, writeConfigText } from "./hooks-config.ts";
import { agentHome, mcpServerEntry, type AgentHooks } from "./install.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";

/**
 * Pi (earendil-works/pi) through its official extension API (ADR 0006).
 *
 * Attache owns one extension file per instance in Pi's global extensions
 * folder, which Pi loads on its own. Each time Pi loads it, the extension
 * registers this instance's MCP server with `pi.registerMcpServer`, which Pi
 * keeps for that session only: nothing is added to the owner's `mcp.json` or
 * `settings.json`, so there is never a second, persistent copy to drift.
 * Attache reads those two files only to refuse a setup in which the
 * registration could not work.
 */

const MARKER = "// Managed by Attache: registers this Attache instance's MCP server in each Pi session.";
const INSTANCE = "// attache-instance: ";
const PURPOSE = "Attache's Pi extension, which registers Attache's MCP server in each Pi session";

/** Pi's agent folder: `PI_CODING_AGENT_DIR` when it names one, else `~/.pi/agent`. */
export function piAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (env && isAbsolute(env)) return env;
  return join(agentHome(), ...PI_AGENT_DIR.split("/"));
}

/** The extension text for one Attache instance: plain code Pi loads through jiti, with no imports. */
export function piExtensionText(stateDir: string, server: string): string {
  const config = { ...mcpServerEntry(stateDir), description: "Attache: search, read and save to your Brain", exposure: "direct" };
  return [
    MARKER,
    "// Attache rewrites this file when you connect Pi again and removes it when you disconnect; edits here are lost.",
    `${INSTANCE}${JSON.stringify({ stateDir })}`,
    "",
    `const SERVER = ${JSON.stringify(server)};`,
    `const CONFIG = ${JSON.stringify(config, null, 2)};`,
    "",
    "export default function attache(pi) {",
    "  pi.registerMcpServer(SERVER, CONFIG);",
    "}",
    "",
  ].join("\n");
}

/** The state folder an Attache extension file belongs to, or null for a file Attache did not write. */
function instanceOf(text: string): string | null {
  if (!text.startsWith(MARKER)) return null;
  const line = text.split("\n").find((l) => l.startsWith(INSTANCE));
  try {
    const parsed = JSON.parse(line?.slice(INSTANCE.length) ?? "") as { stateDir?: unknown };
    return typeof parsed.stateDir === "string" ? parsed.stateDir : null;
  } catch {
    // A damaged marker line: not provably this instance's, so it is treated as the owner's.
    return null;
  }
}

/** A JSON file of Pi's, or undefined when it is absent; throws, naming the file, when Pi's own file does not parse. */
function readPiJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); fix it so Pi can read it, then connect again. Attache changed nothing.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; fix it, then connect again. Attache changed nothing.`);
  return parsed as Record<string, unknown>;
}

/** Pi treats server names that differ only in `-` and `_` as one server. */
const sameServer = (a: string, b: string) => a.replace(/_/g, "-").toLowerCase() === b.replace(/_/g, "-").toLowerCase();

export function piAdapter(hooks: AgentHooks): HarnessAdapter {
  const server = () => hooks.ownerKey();
  const extension = () => join(piAgentDir(), "extensions", `${server()}.ts`);
  const expected = () => piExtensionText(hooks.stateDir, server());

  /** Throws, naming the file, when Pi's setup would refuse or hide this instance's registration. */
  function checkPiSetup() {
    const settingsPath = join(piAgentDir(), "settings.json");
    const settings = readPiJson(settingsPath);
    const extensions = settings?.extensions;
    if (Array.isArray(extensions) && extensions.some((e) => e === "-builtin:mcp" || e === "!builtin:mcp")) {
      throw new HooksFileError(`${settingsPath} turns off Pi's built-in MCP support ("-builtin:mcp"), so Pi would reject Attache's MCP server. Remove that entry, then connect again. Attache changed nothing.`);
    }
    const mcpPath = join(piAgentDir(), "mcp.json");
    const servers = readPiJson(mcpPath)?.mcpServers;
    const clash = servers && typeof servers === "object" ? Object.keys(servers).find((n) => sameServer(n, server())) : undefined;
    if (clash) throw new HooksFileError(`${mcpPath} already defines a server named "${clash}", which Pi uses instead of Attache's. Remove or rename it, then connect again. Attache changed nothing.`);
  }

  /** The extension file's text when it is this instance's, null when absent; throws when another file is in its place. */
  function current(): string | null {
    const path = extension();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    if (instanceOf(text) !== hooks.stateDir) throw new HooksFileError(`${path} exists and was not written by this Attache; Attache will not change it. Move it away, then connect again.`);
    return text;
  }

  function plan(): HarnessFileChange[] {
    checkPiSetup();
    const text = current();
    if (text === expected()) return [];
    return [{ path: extension(), change: text === null ? "create" : "update", backup: text !== null, purpose: PURPOSE }];
  }

  const restartRequired = true;
  const adapter: HarnessAdapter = {
    kind: "pi",
    label: "Pi",
    capabilities: { mcp: true, memory: "none", capture: "none" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds one extension to Pi's extensions folder that registers Attache's MCP server each time Pi starts a session, for that session only; your Pi settings, mcp.json and other extensions are not changed. Needs Pi 0.99.0 or later with its built-in MCP support on. Run /reload in a Pi session that is already open, or start a new one. If Pi was not found, you can still connect: Attache uses ~/.pi/agent, or PI_CODING_AGENT_DIR when the Attache service has it set.",
    detect: (home) => (process.env.PI_CODING_AGENT_DIR ? true : piInstall(locationsForHome(home)).presence.some((p) => existsSync(p))),
    preview: () => ({ changes: plan(), restartRequired }),
    apply: () => {
      const changes = plan();
      const backups: string[] = [];
      for (const c of changes) {
        if (c.change === "create") replaceFile(c.path, expected());
        else {
          const { backup } = writeConfigText(c.path, expected(), hooks.backupDir);
          if (backup) backups.push(backup);
        }
      }
      return { changes, backups, restartRequired };
    },
    status: (): HarnessStatusReport => {
      const path = extension();
      try {
        checkPiSetup();
        const text = current();
        if (text === null) return { state: "missing", message: `Attache's Pi extension is not in ${path}. Set up again to fix it.`, files: [] };
        if (text !== expected()) return { state: "stale", message: `Attache's Pi extension ${path} is out of date. Set up again to fix it.`, files: [path] };
        return { state: "current", message: `Attache's Pi extension ${path}, which registers Attache's MCP server in each Pi session`, files: [path] };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    refresh: () => adapter.apply(),
    uninstall: () => {
      const path = extension();
      try {
        if (!existsSync(path) || instanceOf(readFileSync(path, "utf8")) !== hooks.stateDir) return { removed: [], failures: [] };
        rmSync(path);
        return { removed: [{ path, change: "remove", backup: false, purpose: PURPOSE }], failures: [] };
      } catch (e) {
        return { removed: [], failures: [`Could not remove ${path}: ${(e as Error).message}`] };
      }
    },
  };
  return adapter;
}
